import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatsPipeline, fillDays } from '../src/routes/api.js';
import { loadConfig } from '../src/config.js';
import { apiKeyAuth } from '../src/middleware/auth.js';

test('fillDays returns a continuous series ending today', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const out = fillDays([{ _id: '2026-10-24', reviews: 3, findings: 5 }], 3, now);
  assert.deepEqual(out.map((d) => d.date), ['2026-10-23', '2026-10-24', '2026-10-25']);
  assert.deepEqual(out.map((d) => d.reviews), [0, 3, 0]);
});

test('stats pipeline is a single $match + $facet over the expected buckets', () => {
  const p = buildStatsPipeline(new Date());
  assert.equal(p.length, 2);
  assert.deepEqual(Object.keys(p[1].$facet).sort(), ['category', 'daily', 'feedback', 'repos', 'severity', 'totals']);
});

test('config validates required values and applies defaults', () => {
  assert.throws(() => loadConfig({}), /GITHUB_WEBHOOK_SECRET/);
  const c = loadConfig({ GITHUB_WEBHOOK_SECRET: 'abcdefgh', DRY_RUN: 'true', LLM_TEMPERATURE: '' });
  assert.equal(c.review.dryRun, true);
  assert.equal(c.llm.temperature, undefined);
  assert.equal(c.agent.maxIterations, 8);
});

test('apiKeyAuth: open when unset, strict when set', () => {
  const run = (key, header) => { let status = 200; apiKeyAuth(key)({ get: () => header }, { status(s) { status = s; return { json() {} }; } }, () => {}); return status; };
  assert.equal(run(undefined, undefined), 200);
  assert.equal(run('k'.repeat(16), 'Bearer wrong'), 401);
  assert.equal(run('k'.repeat(16), undefined), 401);
  assert.equal(run('k'.repeat(16), `Bearer ${'k'.repeat(16)}`), 200);
});
