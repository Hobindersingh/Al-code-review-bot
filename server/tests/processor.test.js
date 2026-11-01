import test from 'node:test';
import assert from 'node:assert/strict';
import { UnrecoverableError } from 'bullmq';
import { classifyError, claimReview, createProcessor } from '../src/services/processor.js';
import { loadConfig } from '../src/config.js';
import { PATCH, assistant, fakeOpenAI, silentLogger, toolCall } from './helpers.js';

const config = loadConfig({ GITHUB_WEBHOOK_SECRET: 'secret-123456', NODE_ENV: 'test' });
const data = { owner: 'o', repo: 'r', repoFullName: 'o/r', prNumber: 1, headSha: 'sha1234567', title: 'T', author: 'a', installationId: 1, deliveryId: 'd' };

/** In-memory stand-in for the Review model (the real one needs MongoDB). */
function fakeReview(initialStatus = null) {
  const docs = new Map();
  const k = (key) => `${key.repoFullName}#${key.prNumber}@${key.headSha}`;
  if (initialStatus) docs.set(k(data), { status: initialStatus });
  return {
    docs,
    async findOneAndUpdate(key, { $setOnInsert }) { if (!docs.has(k(key))) docs.set(k(key), { ...$setOnInsert }); return docs.get(k(key)); },
    async findOne(key) { return docs.get(k(key)); },
    async updateOne(key, { $set }) { Object.assign(docs.get(k(key)), $set); },
  };
}

function fakeGitHub(over = {}) {
  const calls = { createReview: [], getPR: 0 };
  return {
    calls,
    async getPullRequest() { calls.getPR += 1; return { state: 'open', draft: false, headSha: data.headSha }; },
    async listFiles() { return [{ filename: 'src/a.js', status: 'modified', additions: 2, deletions: 1, patch: PATCH }, { filename: 'package-lock.json', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' }]; },
    async getFileContent() { return { text: 'x' }; },
    async searchCode() { return { paths: [] }; },
    async findReviewByMarker() { return null; },
    async createReview(_ctx, args) { calls.createReview.push(args); return 99; },
    ...over,
  };
}

const goodReview = { summary: 'Has an injection.', findings: [
  { path: 'src/a.js', line: 12, severity: 'high', category: 'security', confidence: 0.9, title: 'SQL injection', body: 'Concatenated query.' },
  { path: 'src/a.js', line: 500, severity: 'medium', category: 'bug', confidence: 0.8, title: 'Hallucinated line', body: 'Not in the diff.' },
] };
const job = (over = {}) => ({ id: 'j', data, attemptsStarted: 1, opts: { attempts: 4 }, ...over });
const make = (gh, Review, script = [assistant(toolCall('1', 'submit_review', goodReview))], cfg = config) =>
  createProcessor({ github: gh, openai: fakeOpenAI(script), config: cfg, logger: silentLogger, Review });

test('happy path: posts ONE review with a valid inline comment; hallucinated line goes to summary', async () => {
  const gh = fakeGitHub(); const Review = fakeReview();
  await make(gh, Review)(job());
  assert.equal(gh.calls.createReview.length, 1);
  const { comments, body, commitId } = gh.calls.createReview[0];
  assert.equal(commitId, data.headSha);
  assert.deepEqual(comments.map((c) => c.line), [12]);
  assert.match(body, /Hallucinated line/);
  const doc = [...Review.docs.values()][0];
  assert.equal(doc.status, 'completed');
  assert.equal(doc.githubReviewId, 99);
  assert.equal(doc.stats.files, 1, 'lockfile excluded');
});

test('idempotency layer 3: an already-completed review is never processed again', async () => {
  const gh = fakeGitHub(); const Review = fakeReview('completed');
  const res = await make(gh, Review)(job());
  assert.equal(res.skipped, 'completed');
  assert.equal(gh.calls.createReview.length, 0);
  assert.equal(gh.calls.getPR, 0);
});

test('claimReview survives a duplicate-key race', async () => {
  const doc = { status: 'processing' };
  const Review = { async findOneAndUpdate() { const e = new Error('dup'); e.code = 11000; throw e; }, async findOne() { return doc; } };
  assert.equal(await claimReview(Review, {}, data, 'm'), doc);
});

test('stale event: head moved before review -> superseded, nothing posted, OpenAI never called', async () => {
  const gh = fakeGitHub({ async getPullRequest() { return { state: 'open', draft: false, headSha: 'newer' }; } });
  const Review = fakeReview(); const openai = fakeOpenAI([]);
  await createProcessor({ github: gh, openai, config, logger: silentLogger, Review })(job());
  assert.equal([...Review.docs.values()][0].status, 'superseded');
  assert.equal(openai.calls.length, 0);
});

test('PR updated while the agent was running -> superseded and nothing posted', async () => {
  let n = 0;
  const gh = fakeGitHub({ async getPullRequest() { n += 1; return { state: 'open', draft: false, headSha: n === 1 ? data.headSha : 'newer' }; } });
  const Review = fakeReview();
  await make(gh, Review)(job());
  assert.equal(gh.calls.createReview.length, 0);
  assert.equal([...Review.docs.values()][0].status, 'superseded');
});

test('retry after a successful post does not double-post (marker check)', async () => {
  const gh = fakeGitHub({ async findReviewByMarker() { return 42; } });
  const Review = fakeReview();
  await make(gh, Review)(job());
  assert.equal(gh.calls.createReview.length, 0);
  assert.equal([...Review.docs.values()][0].githubReviewId, 42);
});

test('GitHub 422 on inline comments falls back to a summary-only review', async () => {
  let first = true;
  const gh = fakeGitHub({ async createReview(_c, args) { gh.calls.createReview.push(args); if (first) { first = false; const e = new Error('Unprocessable'); e.status = 422; throw e; } return 7; } });
  const Review = fakeReview();
  await make(gh, Review)(job());
  assert.equal(gh.calls.createReview.length, 2);
  assert.equal(gh.calls.createReview[1].comments.length, 0);
  assert.match(gh.calls.createReview[1].body, /SQL injection/);
});

test('DRY_RUN stores results without posting', async () => {
  const gh = fakeGitHub(); const Review = fakeReview();
  await make(gh, Review, undefined, { ...config, review: { ...config.review, dryRun: true } })(job());
  assert.equal(gh.calls.createReview.length, 0);
  assert.equal([...Review.docs.values()][0].dryRun, true);
});

test('fatal errors (e.g. 401) become UnrecoverableError and mark the review failed', async () => {
  const gh = fakeGitHub({ async listFiles() { const e = new Error('Bad credentials'); e.status = 401; throw e; } });
  const Review = fakeReview();
  await assert.rejects(make(gh, Review)(job()), UnrecoverableError);
  assert.equal([...Review.docs.values()][0].status, 'failed');
});

test('transient errors stay retryable and only fail on the final attempt', async () => {
  const gh = fakeGitHub({ async listFiles() { throw new Error('ECONNRESET'); } });
  const Review = fakeReview();
  await assert.rejects(make(gh, Review)(job()), (e) => !(e instanceof UnrecoverableError));
  assert.equal([...Review.docs.values()][0].status, 'processing');
  await assert.rejects(make(gh, Review)(job({ attemptsStarted: 4 })));
  assert.equal([...Review.docs.values()][0].status, 'failed');
});

test('classifyError', () => {
  assert.equal(classifyError({ status: 401 }), 'fatal');
  assert.equal(classifyError({ status: 404 }), 'fatal');
  assert.equal(classifyError({ status: 429 }), 'retry');
  assert.equal(classifyError({ status: 403, message: 'API rate limit exceeded' }), 'retry');
  assert.equal(classifyError({ status: 403, message: 'Resource not accessible' }), 'fatal');
  assert.equal(classifyError({ status: 500 }), 'retry');
  assert.equal(classifyError({ code: 'insufficient_quota', status: 429 }), 'fatal');
  assert.equal(classifyError(new Error('socket hang up')), 'retry');
});

test('a draft-skipped review is NOT terminal: same commit can be reviewed once it is ready', async () => {
  const Review = fakeReview();
  let draft = true;
  const gh = fakeGitHub({ async getPullRequest() { return { state: 'open', draft, headSha: data.headSha }; } });
  const run = make(gh, Review);
  await run(job());
  assert.equal([...Review.docs.values()][0].status, 'skipped');
  draft = false;
  await run(job());
  assert.equal([...Review.docs.values()][0].status, 'completed');
  assert.equal(gh.calls.createReview.length, 1);
});
