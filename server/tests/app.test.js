import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApp } from '../src/app.js';
import { createWebhookRouter } from '../src/routes/webhook.js';
import { computeSignature } from '../src/middleware/verifySignature.js';
import { createIdempotency } from '../src/services/idempotency.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from './helpers.js';

const config = loadConfig({ GITHUB_WEBHOOK_SECRET: 'secret-123456', DASHBOARD_API_KEY: 'k'.repeat(20), NODE_ENV: 'test' });

async function boot() {
  const added = [];
  const store = new Map();
  const redis = { async set(k, v, _a, _b, nx) { if (nx && store.has(k)) return null; store.set(k, v); return 'OK'; }, async del(k) { store.delete(k); } };
  const queue = { async getJob() { return null; }, async add(_n, d, o) { added.push(d); return { id: o.jobId }; } };
  const apiRouter = express.Router();
  apiRouter.post('/echo', (req, res) => res.json(req.body));
  apiRouter.get('/boom', () => { throw new Error('kaboom'); });
  const app = createApp({
    config, logger: silentLogger,
    webhookRouter: createWebhookRouter({ secret: config.webhookSecret, queue, idempotency: createIdempotency(redis), logger: silentLogger }),
    apiRouter, healthCheck: async () => ({ ok: true }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, added, close: () => { server.closeAllConnections?.(); server.close(); } };
}

test('real app wiring: signed webhook works even though a JSON parser exists for /api', async () => {
  const t = await boot();
  const raw = JSON.stringify({ action: 'opened', repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } }, pull_request: { number: 1, state: 'open', title: 't', head: { sha: 'abc' } } });
  const res = await fetch(`${t.base}/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'z1', 'x-hub-signature-256': computeSignature(config.webhookSecret, raw) } });
  assert.equal(res.status, 202);
  assert.equal(t.added.length, 1);
  t.close();
});

test('API requires the bearer key, health does not, errors are not leaked', async () => {
  const t = await boot();
  const auth = { authorization: `Bearer ${'k'.repeat(20)}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${t.base}/api/echo`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);
  assert.equal((await fetch(`${t.base}/api/echo`, { method: 'POST', body: '{"a":1}', headers: auth })).status, 200);
  const boom = await fetch(`${t.base}/api/boom`, { headers: auth });
  assert.equal(boom.status, 500);
  assert.ok(!(await boom.text()).includes('kaboom'));
  assert.equal((await fetch(`${t.base}/health`)).status, 200);
  assert.equal((await fetch(`${t.base}/api/echo`, { method: 'POST', body: 'x'.repeat(20000), headers: auth })).status, 413);
  t.close();
});
