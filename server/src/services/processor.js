import { UnrecoverableError } from 'bullmq';
import { runReviewAgent } from '../agent/agent.js';
import { buildMessages } from '../agent/prompts.js';
import { createToolbox } from '../agent/tools.js';
import { finalizeFindings } from '../agent/postprocess.js';
import { formatComment, formatReviewBody, reviewMarker } from '../agent/format.js';
import { parsePatch, shouldReview } from '../utils/diff.js';

const isTerminal = (doc) => doc.status === 'completed' || doc.status === 'superseded' || (doc.status === 'skipped' && doc.skipReason === 'no reviewable changes');

/** 'fatal' errors will never succeed on retry (bad credentials, missing repo, no quota). */
export function classifyError(err) {
  const status = err?.status ?? err?.response?.status;
  const headers = err?.response?.headers ?? err?.headers ?? {};
  if (err?.code === 'insufficient_quota') return 'fatal'; // OpenAI sends this as a 429, but retrying never helps
  const rateLimited =
    status === 429 ||
    (status === 403 && (headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] || /rate limit|abuse/i.test(err?.message ?? '')));
  if (rateLimited) return 'retry';
  if ([400, 401, 403, 404, 422].includes(status)) return 'fatal';
  return 'retry';
}

/** Layer 3 of idempotency: unique (repo, pr, sha) index. Returns the existing or newly created doc. */
export async function claimReview(Review, key, data, model) {
  try {
    return await Review.findOneAndUpdate(
      key,
      { $setOnInsert: { ...key, title: data.title, author: data.author, action: data.action, deliveryId: data.deliveryId, model, status: 'processing' } },
      { upsert: true, new: true },
    );
  } catch (err) {
    if (err?.code === 11000) return Review.findOne(key); // lost the upsert race to a concurrent worker
    throw err;
  }
}

export function createProcessor({ github, openai, config, logger, Review }) {
  return async function processReview(job) {
    const data = job.data;
    const key = { repoFullName: data.repoFullName, prNumber: data.prNumber, headSha: data.headSha };
    const ctx = { owner: data.owner, repo: data.repo, prNumber: data.prNumber, installationId: data.installationId };
    const log = logger.child({ jobId: job.id, repo: data.repoFullName, pr: data.prNumber, sha: data.headSha.slice(0, 7) });
    const started = Date.now();

    const doc = await claimReview(Review, key, data, config.llm.model);
    if (isTerminal(doc)) {
      log.info({ status: doc.status }, 'already processed, skipping');
      return { skipped: doc.status };
    }
    await Review.updateOne(key, { $set: { status: 'processing', error: null, skipReason: null } });

    const finish = async (status, extra = {}) => {
      await Review.updateOne(key, { $set: { status, ...extra } });
      return { status };
    };

    try {
      // Stale-event guards: act only on the PR's current, open, non-draft head commit.
      const pr = await github.getPullRequest(ctx);
      if (pr.state !== 'open' || pr.draft) return await finish('skipped', { skipReason: pr.draft ? 'draft' : 'closed' });
      if (pr.headSha !== data.headSha) return await finish('superseded', { skipReason: `head moved to ${pr.headSha.slice(0, 7)}` });

      const all = await github.listFiles(ctx);
      const eligible = all.filter((f) => f.patch && f.status !== 'removed' && shouldReview(f.filename));
      if (!eligible.length) return await finish('skipped', { skipReason: 'no reviewable changes' });
      const files = eligible.slice(0, config.review.maxFiles).map((f) => ({ ...f, parsed: parsePatch(f.patch) }));
      const truncatedFiles = eligible.length - files.length;
      const filesByPath = new Map(files.map((f) => [f.filename, f]));

      const toolbox = createToolbox({ github, ctx, headSha: data.headSha, files, limits: config.agent });
      const result = await runReviewAgent({
        openai,
        model: config.llm.model,
        temperature: config.llm.temperature,
        reasoningEffort: config.llm.reasoningEffort,
        messages: buildMessages({ pr: data, files, maxDiffChars: config.review.maxDiffChars }),
        toolbox,
        limits: config.agent,
        logger: log,
      });

      const { inline, general, dropped } = finalizeFindings(result.findings, filesByPath, config.review);
      const findings = [...inline, ...general];
      const hasFindings = findings.length > 0;
      const body = formatReviewBody({ summary: result.summary, inline, general, headSha: data.headSha, truncatedFiles });

      const stats = {
        files: files.length,
        additions: files.reduce((s, f) => s + f.additions, 0),
        deletions: files.reduce((s, f) => s + f.deletions, 0),
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        durationMs: Date.now() - started,
        dropped,
      };

      let githubReviewId = null;
      const shouldPost = !config.review.dryRun && (hasFindings || config.review.postWhenClean);

      if (shouldPost) {
        // The agent can take a while; don't post stale comments if the author pushed again meanwhile.
        const latest = await github.getPullRequest(ctx);
        if (latest.headSha !== data.headSha || latest.state !== 'open') {
          return await finish('superseded', { skipReason: 'PR changed during review', stats });
        }
        githubReviewId = await github.findReviewByMarker(ctx, reviewMarker(data.headSha)); // retry-after-success guard
        if (!githubReviewId) {
          const comments = inline.map((f) => ({ path: f.path, line: f.line, body: formatComment(f) }));
          try {
            githubReviewId = await github.createReview(ctx, { commitId: data.headSha, body, comments });
          } catch (err) {
            if (err?.status !== 422 || !comments.length) throw err;
            log.warn('inline comments rejected by GitHub, falling back to summary-only review');
            const fallback = formatReviewBody({ summary: result.summary, inline: [], general: findings, headSha: data.headSha, truncatedFiles });
            githubReviewId = await github.createReview(ctx, { commitId: data.headSha, body: fallback, comments: [] });
          }
        }
      }

      await finish('completed', { summary: result.summary, findings, githubReviewId, dryRun: config.review.dryRun, stats });
      log.info({ findings: findings.length, ...stats }, 'review completed');
      return { status: 'completed', findings: findings.length };
    } catch (err) {
      const fatal = classifyError(err) === 'fatal';
      const attempt = job.attemptsStarted ?? job.attemptsMade + 1;
      const lastAttempt = fatal || attempt >= (job.opts?.attempts ?? 1);
      log.error({ err, attempt, fatal }, 'review attempt failed');
      await Review.updateOne(key, { $set: { status: lastAttempt ? 'failed' : 'processing', error: String(err.message).slice(0, 500) } }).catch(() => {});
      if (fatal) throw new UnrecoverableError(err.message);
      throw err;
    }
  };
}
