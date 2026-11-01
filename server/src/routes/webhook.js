import express from 'express';
import { verifySignature } from '../middleware/verifySignature.js';
import { enqueueReview } from '../services/queue.js';

const HANDLED_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

/** Returns { job } for a reviewable PR event, or { reason } explaining why it is ignored. */
export function extractJob(payload, deliveryId) {
  const pr = payload?.pull_request;
  const repo = payload?.repository;
  if (!pr || !repo) return { reason: 'malformed payload' };
  if (!HANDLED_ACTIONS.has(payload.action)) return { reason: `action ${payload.action}` };
  if (pr.state !== 'open') return { reason: 'pr not open' };
  if (pr.draft) return { reason: 'draft pr' };
  if (!pr.head?.sha) return { reason: 'missing head sha' };
  return {
    job: {
      deliveryId,
      action: payload.action,
      owner: repo.owner.login,
      repo: repo.name,
      repoFullName: repo.full_name,
      prNumber: pr.number,
      headSha: pr.head.sha,
      title: String(pr.title ?? '').slice(0, 300),
      author: pr.user?.login ?? 'unknown',
      installationId: payload.installation?.id ?? null,
    },
  };
}

export function createWebhookRouter({ secret, queue, idempotency, logger }) {
  const router = express.Router();

  // Raw body is mandatory: the HMAC is computed over the exact bytes GitHub sent.
  router.post('/', express.raw({ type: '*/*', limit: '5mb' }), verifySignature(secret), async (req, res) => {
    const event = req.get('x-github-event');
    const deliveryId = req.get('x-github-delivery');
    if (!event || !deliveryId) return res.status(400).json({ error: 'missing github headers' });
    if (event === 'ping') return res.json({ ok: true });

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid json' });
    }

    if (event !== 'pull_request') return res.status(202).json({ ignored: `event ${event}` });
    const { job, reason } = extractJob(payload, deliveryId);
    if (!job) return res.status(202).json({ ignored: reason });

    const claimed = await idempotency.claim(deliveryId);
    if (!claimed) {
      logger.info({ deliveryId }, 'duplicate delivery ignored');
      return res.status(200).json({ duplicate: true });
    }

    try {
      const queued = await enqueueReview(queue, job);
      logger.info({ deliveryId, jobId: queued.id, pr: job.prNumber }, 'review queued');
      return res.status(202).json({ queued: true, jobId: queued.id });
    } catch (err) {
      await idempotency.release(deliveryId).catch(() => {});
      logger.error({ err, deliveryId }, 'failed to enqueue');
      return res.status(503).json({ error: 'queue unavailable' });
    }
  });

  return router;
}
