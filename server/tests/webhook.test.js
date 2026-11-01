import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createWebhookRouter, extractJob } from '../src/routes/webhook.js';
import { computeSignature } from '../src/middleware/verifySignature.js';
import { createIdempotency } from '../src/services/idempotency.js';
import { buildJobId } from '../src/services/queue.js';
import { silentLogger } from './helpers.js';

const secret = 'webhook-secret-1';
const payload = (over = {}) => ({
  action: 'opened',
  installation: { id: 7 },
  repository: { name: 'repo', full_name: 'o/repo', owner: { login: 'o' } },
  pull_request: { number: 5, state: 'open', draft: false, title: 'Add feature', user: { login: 'dev' }, head: { sha: 'abc123' } },
  ...over,
});

function fakeRedis() {
  const store = new Map();
  return { async set(k, v, _ex, _ttl, nx) { if (nx === 'NX' && store.has(k)) return null; store.set(k, v); return 'OK'; }, async del(k) { store.delete(k); }, store };
}

async function boot({ failQueue = false } = {}) {
  const added = [];
  const redis = fakeRedis();
  const queue = { async getJob() { return null; }, async add(name, data, opts) { if (failQueue) throw new Error('redis down'); added.push({ name, data, opts }); return { id: opts.jobId }; } };
  const app = express();
  // Same order as app.js: webhook (raw body) first, JSON parser for everything else afterwards.
  app.use('/webhook', createWebhookRouter({ secret, queue, idempotency: createIdempotency(redis), logger: silentLogger }));
  app.use(express.json());
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/webhook`;
  const send = (body, { event = 'pull_request', delivery = 'd-1', sig } = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return fetch(url, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': sig ?? computeSignature(secret, raw) } });
  };
  return { added, redis, send, close: () => { server.closeAllConnections?.(); server.close(); } };
}

test('rejects unsigned / wrongly signed requests with 401 and enqueues nothing', async () => {
  const t = await boot();
  assert.equal((await t.send(payload(), { sig: 'sha256=deadbeef' })).status, 401);
  assert.equal(t.added.length, 0);
  t.close();
});

test('valid PR event is queued once with a deterministic job id', async () => {
  const t = await boot();
  const res = await t.send(payload());
  assert.equal(res.status, 202);
  assert.equal(t.added.length, 1);
  assert.equal(t.added[0].opts.jobId, buildJobId({ repoFullName: 'o/repo', prNumber: 5, headSha: 'abc123' }));
  assert.ok(!t.added[0].opts.jobId.includes(':'));
  t.close();
});

test('redelivery with the same delivery id is deduplicated', async () => {
  const t = await boot();
  await t.send(payload());
  const again = await t.send(payload());
  assert.equal((await again.json()).duplicate, true);
  assert.equal(t.added.length, 1);
  t.close();
});

test('failed enqueue releases the idempotency key so GitHub redelivery can succeed', async () => {
  const t = await boot({ failQueue: true });
  assert.equal((await t.send(payload())).status, 503);
  assert.equal(t.redis.store.size, 0);
  t.close();
});

test('ping, other events, drafts, closed PRs and irrelevant actions are acknowledged but ignored', async () => {
  const t = await boot();
  assert.equal((await t.send({ zen: 'x' }, { event: 'ping' })).status, 200);
  assert.equal((await t.send({}, { event: 'push', delivery: 'd2' })).status, 202);
  const draft = payload(); draft.pull_request.draft = true;
  assert.equal((await t.send(draft, { delivery: 'd3' })).status, 202);
  assert.equal((await t.send(payload({ action: 'labeled' }), { delivery: 'd4' })).status, 202);
  assert.equal((await t.send('{broken', { delivery: 'd5' })).status, 400);
  assert.equal(t.added.length, 0);
  t.close();
});

test('extractJob maps payload fields', () => {
  const { job } = extractJob(payload(), 'dx');
  assert.deepEqual([job.owner, job.repo, job.prNumber, job.headSha, job.installationId], ['o', 'repo', 5, 'abc123', 7]);
  assert.ok(extractJob({}, 'x').reason);
});
