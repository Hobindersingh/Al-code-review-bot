import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, assertWorkerConfig } from '../src/config.js';
import { createRateLimiter } from '../src/utils/rateLimit.js';
import { createLlmClient } from '../src/services/llm.js';

const base = { GITHUB_WEBHOOK_SECRET: 'secret-123456', GITHUB_TOKEN: 'tok' };

test('default provider is free Gemini with its OpenAI-compatible endpoint and free-tier-safe settings', () => {
  const { llm } = loadConfig({ ...base, GEMINI_API_KEY: 'g-key' });
  assert.equal(llm.provider, 'gemini');
  assert.equal(llm.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai/');
  assert.match(llm.model, /^gemini-/);
  assert.equal(llm.apiKey, 'g-key');
  assert.equal(llm.temperature, undefined);
  assert.equal(llm.reasoningEffort, 'low');
  assert.ok(llm.maxRpm > 0);
});

test('LLM_* variables override the preset; LLM_API_KEY wins over GEMINI_API_KEY', () => {
  const { llm } = loadConfig({ ...base, LLM_API_KEY: 'a', GEMINI_API_KEY: 'b', LLM_MODEL: 'gemini-x-flash-lite', LLM_MAX_RPM: '4', LLM_REASONING_EFFORT: 'medium' });
  assert.deepEqual([llm.apiKey, llm.model, llm.maxRpm, llm.reasoningEffort], ['a', 'gemini-x-flash-lite', 4, 'medium']);
});

test('openai and custom providers', () => {
  const o = loadConfig({ ...base, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk' }).llm;
  assert.deepEqual([o.baseUrl, o.model, o.temperature, o.reasoningEffort, o.apiKey], [undefined, 'gpt-4o-mini', 0.1, undefined, 'sk']);
  assert.throws(() => assertWorkerConfig(loadConfig({ ...base, LLM_PROVIDER: 'custom', LLM_API_KEY: 'k' })), /LLM_BASE_URL and LLM_MODEL/);
  assert.doesNotThrow(() => assertWorkerConfig(loadConfig({ ...base, LLM_PROVIDER: 'custom', LLM_API_KEY: 'k', LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MODEL: 'm' })));
});

test('worker config explains how to get a free Gemini key when none is set', () => {
  assert.throws(() => assertWorkerConfig(loadConfig(base)), /aistudio\.google\.com\/apikey/);
  assert.throws(() => assertWorkerConfig(loadConfig({ GITHUB_WEBHOOK_SECRET: 'secret-123456', GEMINI_API_KEY: 'k' })), /GITHUB_TOKEN/);
});

test('rate limiter spaces concurrent callers by 60000/rpm and never lets them overlap', async () => {
  const acquire = createRateLimiter(600); // 100 ms gap
  const t0 = Date.now();
  const stamps = await Promise.all([1, 2, 3, 4].map(async () => { await acquire(); return Date.now() - t0; }));
  const sorted = [...stamps].sort((a, b) => a - b);
  assert.ok(sorted[0] < 60, 'first call immediate');
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i] - sorted[i - 1] >= 85, `gap ${i}: ${sorted[i] - sorted[i - 1]}ms`);
  const free = createRateLimiter(0); const t1 = Date.now(); await Promise.all([free(), free(), free()]); assert.ok(Date.now() - t1 < 50, 'rpm 0 = unlimited');
});

test('createLlmClient passes base URL + key to the SDK and rate-limits create()', async () => {
  let ctorArgs; let calls = 0;
  class FakeOpenAI { constructor(a) { ctorArgs = a; this.chat = { completions: { async create(body) { calls += 1; return { echoed: body.model }; } } }; } }
  const client = createLlmClient({ apiKey: 'k', baseUrl: 'https://x.test/v1/', maxRpm: 0 }, { OpenAIClass: FakeOpenAI });
  assert.equal(ctorArgs.baseURL, 'https://x.test/v1/');
  assert.equal(ctorArgs.apiKey, 'k');
  assert.deepEqual(await client.chat.completions.create({ model: 'm' }), { echoed: 'm' });
  createLlmClient({ apiKey: 'k', maxRpm: 0 }, { OpenAIClass: FakeOpenAI });
  assert.ok(!('baseURL' in ctorArgs), 'no baseURL for plain OpenAI');
  assert.equal(calls, 1);
});
