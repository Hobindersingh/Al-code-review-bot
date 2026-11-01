import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const QUEUE_NAME = 'pr-review';

export function createRedis(url) {
  // BullMQ requires maxRetriesPerRequest: null for blocking connections.
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function createReviewQueue(connection) {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
}

/**
 * Layer 2 of idempotency: one job per (repo, PR, head commit). BullMQ ignores
 * `add` when a job with the same id exists. (':' is not allowed in custom ids.)
 */
export function buildJobId({ repoFullName, prNumber, headSha }) {
  return `${repoFullName}_pr${prNumber}_${headSha}`.replace(/[^A-Za-z0-9_.-]/g, '-');
}

/**
 * Adds the job unless an equivalent one is still active/waiting/delayed (layer 2).
 * Finished jobs (failed or completed) are cleared first: otherwise their retained id would silently
 * swallow a legitimate redelivery, e.g. retry after fixing credentials, or a PR that was
 * skipped as draft and later marked ready. Layer 3 (the DB) still prevents double reviews.
 */
export async function enqueueReview(queue, data) {
  const jobId = buildJobId(data);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'failed' || state === 'completed') await existing.remove().catch(() => {});
  }
  return queue.add('review', data, { jobId });
}
