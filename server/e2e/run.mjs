// End-to-end test: real API + real worker processes, real Redis + MongoDB,
// fake GitHub and fake OpenAI HTTP servers.
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const SECRET = 'e2e-secret-123456', KEY = 'dashboard-key-1234567';
const PORTS = { api: 4100, gh: 4200, ai: 4300 };
const DB = `aicr_e2e_${Date.now()}`;
const PATCH = '@@ -10,4 +10,6 @@ function a() {\n const a = 1;\n-const b = 2;\n+const b = userInput;\n+db.query("SELECT * FROM t WHERE id=" + b);\n return a;\n }';
const FILE_TEXT = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');

const protocolErrors = [];
const gh = { reviews: [], headSha: 'sha-1', prHits: 0, openaiCalls: 0, postAttempts: {}, failPost: {}, authFailPr: null };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });

const ghServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const num = Number(/\/pulls\/(\d+)/.exec(p)?.[1] ?? 0);
  if (req.method === 'GET' && /^\/repos\/o\/r\/pulls\/\d+$/.test(p)) {
    gh.prHits += 1;
    if (num === gh.authFailPr) return json(res, 401, { message: 'Bad credentials' });
    return json(res, 200, { state: 'open', draft: false, merged: false, title: 'T', head: { sha: num === 1 ? gh.headSha : `s${num}` } });
  }
  if (req.method === 'GET' && p.endsWith('/files')) return json(res, 200, [
    { filename: 'src/a.js', status: 'modified', additions: 2, deletions: 1, patch: PATCH },
    { filename: 'package-lock.json', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
  ]);
  if (req.method === 'GET' && p.startsWith('/repos/o/r/contents/')) return json(res, 200, { type: 'file', size: FILE_TEXT.length, content: Buffer.from(FILE_TEXT).toString('base64') });
  if (req.method === 'GET' && p === '/search/code') return json(res, 200, { total_count: 1, items: [{ path: 'src/b.js' }] });
  if (req.method === 'GET' && p.endsWith('/reviews')) return json(res, 200, gh.reviews.map((r, i) => ({ id: i + 1, body: r.body })));
  if (req.method === 'POST' && p.endsWith('/reviews')) {
    const b = JSON.parse(await readBody(req));
    gh.postAttempts[num] = (gh.postAttempts[num] ?? 0) + 1;
    const inject = gh.failPost[num]?.shift();
    if (inject && !(inject === 422 && !b.comments.length)) return json(res, inject, { message: `injected ${inject}` });
    gh.reviews.push({ ...b, pr: num });
    return json(res, 200, { id: gh.reviews.length });
  }
  return json(res, 404, { message: `no route ${req.method} ${p}` });
});

// Fake OpenAI: turn 1 -> tool call, turn 2 -> submit_review with one valid and one hallucinated finding.
const aiServer = http.createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  gh.openaiCalls += 1;
  // --- act like Gemini's OpenAI-compatible endpoint: strict schemas, thought signatures, empty tool-call ids
  const walk = (o, path) => {
    if (!o || typeof o !== 'object') return;
    if ('additionalProperties' in o) protocolErrors.push(`${path}: additionalProperties`);
    if (o.properties && !Object.keys(o.properties).length) protocolErrors.push(`${path}: empty properties`);
    for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
  };
  walk(body.tools, 'tools');
  if (body.reasoning_effort !== 'low') protocolErrors.push('reasoning_effort not sent');
  if ('temperature' in body) protocolErrors.push('temperature sent');
  const hasToolResult = body.messages.some((m) => m.role === 'tool');
  if (hasToolResult) {
    const a = body.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    if (a?.tool_calls?.[0]?.extra_content?.google?.thought_signature !== 'SIG123') protocolErrors.push('thought signature not echoed');
    const t = body.messages.find((m) => m.role === 'tool');
    if (!t.tool_call_id || t.tool_call_id !== a.tool_calls[0].id) protocolErrors.push('tool_call_id mismatch');
  }
  const msg = !hasToolResult
    ? { role: 'assistant', content: null, tool_calls: [{ id: '', type: 'function', extra_content: { google: { thought_signature: 'SIG123' } }, function: { name: 'get_file_content', arguments: JSON.stringify({ path: 'src/a.js', start_line: 8, end_line: 14 }) } }] }
    : { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'submit_review', arguments: JSON.stringify({
        summary: 'Adds a raw SQL query built from user input.',
        findings: [
          { path: 'src/a.js', line: 12, severity: 'high', category: 'security', confidence: 0.92, title: 'SQL injection', body: 'User input is concatenated into SQL. cc @octocat', suggestion: 'db.query("SELECT * FROM t WHERE id=?", [b]);' },
          { path: 'src/a.js', line: 999, severity: 'medium', category: 'bug', confidence: 0.8, title: 'Hallucinated line', body: 'This line is not in the diff.' },
          { path: 'src/a.js', line: 11, severity: 'low', category: 'style', confidence: 0.3, title: 'Low confidence nit', body: 'Dropped by the confidence filter.' },
        ] }) } }] };
  json(res, 200, { id: 'x', object: 'chat.completion', model: 'fake', choices: [{ index: 0, finish_reason: 'tool_calls', message: msg }], usage: { prompt_tokens: 1200, completion_tokens: 150, total_tokens: 1350 } });
});

const env = {
  ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'warn', PORT: String(PORTS.api),
  MONGO_URI: `mongodb://127.0.0.1:27017/${DB}`, REDIS_URL: 'redis://127.0.0.1:6379',
  GITHUB_WEBHOOK_SECRET: SECRET, DASHBOARD_API_KEY: KEY, GITHUB_TOKEN: 'fake', LLM_PROVIDER: 'custom', LLM_API_KEY: 'fake', LLM_MODEL: 'fake-model', LLM_MAX_RPM: '0', LLM_REASONING_EFFORT: 'low',
  GITHUB_API_URL: `http://127.0.0.1:${PORTS.gh}`, LLM_BASE_URL: `http://127.0.0.1:${PORTS.ai}/v1`,
  WORKER_CONCURRENCY: '2',
};
const procs = [];
const start = (name, file) => {
  const p = spawn('node', [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.logs = ''; p.stdout.on('data', (d) => (p.logs += d)); p.stderr.on('data', (d) => (p.logs += d));
  procs.push(p); p.name = name; return p;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(250); }
  throw new Error(`timeout waiting for ${what}`);
}
const sign = (raw) => `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
const prPayload = (sha, action = 'opened', number = 1) => ({ action, repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } }, pull_request: { number, state: 'open', draft: false, title: 'Add query', user: { login: 'dev' }, head: { sha } } });
const hook = (payload, delivery, { badSig = false, event = 'pull_request' } = {}) => {
  const raw = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${PORTS.api}/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': badSig ? 'sha256=00' : sign(raw) } });
};
const api = (path, opts = {}) => fetch(`http://127.0.0.1:${PORTS.api}/api${path}`, { ...opts, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...opts.headers } });

let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log(`  PASS  ${name}`); } catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${e.message}`); } };

await new Promise((r) => ghServer.listen(PORTS.gh, r));
await new Promise((r) => aiServer.listen(PORTS.ai, r));
const apiProc = start('api', 'src/index.js');
const workerProc = start('worker', 'src/worker.js');

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORTS.api}/health`)).status === 200, 'api health');
  console.log('E2E against real Redis + MongoDB (fake GitHub/OpenAI)\n');

  await step('health reports mongo + redis up', async () => {
    const h = await (await fetch(`http://127.0.0.1:${PORTS.api}/health`)).json();
    assert.deepEqual(h, { ok: true, mongo: true, redis: true });
  });
  await step('bad signature rejected (401)', async () => assert.equal((await hook(prPayload('sha-1'), 'd0', { badSig: true })).status, 401));
  await step('ping acknowledged', async () => assert.equal((await hook({ zen: 'hi' }, 'dping', { event: 'ping' })).status, 200));

  await step('valid webhook is queued, review completes and is posted to GitHub exactly once', async () => {
    assert.equal((await hook(prPayload('sha-1'), 'd1')).status, 202);
    await waitFor(() => gh.reviews.length >= 1, 'review post');
    await sleep(800);
    assert.equal(gh.reviews.length, 1);
  });

  await step('posted review: only the valid inline comment, sanitised, with suggestion + marker', async () => {
    const r = gh.reviews[0];
    assert.equal(r.commit_id, 'sha-1');
    assert.equal(r.event, 'COMMENT');
    assert.equal(r.comments.length, 1);
    assert.equal(r.comments[0].line, 12);
    assert.equal(r.comments[0].side, 'RIGHT');
    assert.match(r.comments[0].body, /```suggestion/);
    assert.ok(!r.comments[0].body.includes('@octocat'), 'mention neutralised');
    assert.match(r.body, /Hallucinated line/, 'hallucinated line moved to summary');
    assert.ok(!r.body.includes('Low confidence nit'));
    assert.match(r.body, /<!-- aicr:sha-1 -->/);
  });

  await step('agent used a tool (2 model turns)', async () => assert.equal(gh.openaiCalls, 2));
  await step('LLM protocol is Gemini-compatible (schemas, thought signatures, empty ids, reasoning_effort)', async () => assert.deepEqual(protocolErrors, []));

  await step('idempotency L1: same delivery id replayed -> duplicate, nothing new', async () => {
    const res = await hook(prPayload('sha-1'), 'd1');
    assert.equal((await res.json()).duplicate, true);
  });
  await step('idempotency L2/L3: new delivery id, same commit -> no second review', async () => {
    assert.equal((await hook(prPayload('sha-1', 'reopened'), 'd2')).status, 202);
    await sleep(2500);
    assert.equal(gh.reviews.length, 1);
    assert.equal(gh.openaiCalls, 2, 'model not called again');
  });

  await step('new commit -> second review', async () => {
    gh.headSha = 'sha-2';
    assert.equal((await hook(prPayload('sha-2', 'synchronize'), 'd3')).status, 202);
    await waitFor(() => gh.reviews.length >= 2, 'second review');
    assert.equal(gh.reviews[1].commit_id, 'sha-2');
  });

  await step('stale event (head moved on) -> superseded, nothing posted', async () => {
    assert.equal((await hook(prPayload('sha-old', 'synchronize'), 'd4')).status, 202);
    await waitFor(async () => (await (await api('/reviews?status=superseded')).json()).items.length === 1, 'superseded');
    assert.equal(gh.reviews.length, 2);
  });

  await step('dashboard API requires the key', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${PORTS.api}/api/stats`)).status, 401);
    assert.equal((await api('/stats')).status, 200);
  });

  await step('GET /api/stats: aggregation totals, severity, category, daily', async () => {
    const s = await (await api('/stats?days=7')).json();
    assert.equal(s.totals.reviews, 3);
    assert.equal(s.totals.completed, 2);
    assert.equal(s.totals.findings, 4, '2 per completed review (inline + summary)');
    assert.equal(s.totals.tokens, 4 * 1350, '2 model turns x 2 completed reviews');
    assert.ok(s.totals.avgDurationMs > 0);
    assert.deepEqual(Object.fromEntries(s.severity.map((x) => [x.name, x.count])), { high: 2, medium: 2 });
    assert.equal(s.daily.length, 7);
    assert.equal(s.daily.at(-1).reviews, 3);
    assert.equal(s.repos[0].name, 'o/r');
    assert.equal(s.acceptanceRate, null);
  });

  let reviewId; let findingId;
  await step('GET /api/reviews: pagination, filters, urgentCount', async () => {
    const l = await (await api('/reviews?limit=2&page=1')).json();
    assert.equal(l.total, 3); assert.equal(l.items.length, 2); assert.equal(l.pages, 2);
    const done = await (await api('/reviews?status=completed')).json();
    assert.equal(done.items.length, 2);
    assert.equal(done.items[0].findingsCount, 2);
    assert.equal(done.items[0].urgentCount, 1);
    assert.equal((await (await api('/reviews?q=o%2Fr')).json()).total, 3);
    assert.equal((await (await api('/reviews?q=(')).json()).total, 0, 'regex chars escaped');
    assert.equal((await api('/reviews?limit=9999')).status, 400);
    reviewId = done.items[0]._id;
  });
  await step('GET /api/reviews/:id and 404/400 handling', async () => {
    const r = await (await api(`/reviews/${reviewId}`)).json();
    assert.equal(r.status, 'completed'); assert.equal(r.findings.length, 2);
    findingId = r.findings[0]._id;
    assert.equal((await api('/reviews/507f1f77bcf86cd799439011')).status, 404);
    assert.equal((await api('/reviews/not-an-id')).status, 400);
  });
  await step('feedback endpoint updates a finding and feeds acceptanceRate', async () => {
    const r = await api(`/reviews/${reviewId}/findings/${findingId}/feedback`, { method: 'POST', body: JSON.stringify({ value: 'helpful' }) });
    assert.equal(r.status, 200);
    assert.equal((await api(`/reviews/${reviewId}/findings/${findingId}/feedback`, { method: 'POST', body: JSON.stringify({ value: 'bogus' }) })).status, 400);
    const s = await (await api('/stats?days=7')).json();
    assert.equal(s.acceptanceRate, 1); assert.equal(s.ratedFindings, 1);
    assert.equal((await api(`/reviews/${reviewId}/findings/507f1f77bcf86cd799439011/feedback`, { method: 'POST', body: JSON.stringify({ value: 'helpful' }) })).status, 404);
  });

  await step('unique index exists in MongoDB (idempotency layer 3)', async () => {
    const mongoose = (await import('mongoose')).default;
    await mongoose.connect(env.MONGO_URI);
    const idx = await mongoose.connection.collection('reviews').indexes();
    await mongoose.disconnect();
    assert.ok(idx.some((i) => i.unique && i.key.repoFullName === 1 && i.key.prNumber === 1 && i.key.headSha === 1));
  });


  await step('RACE: 8 concurrent deliveries (distinct ids) of the same commit -> exactly one review', async () => {
    const before = gh.reviews.length; const aiBefore = gh.openaiCalls;
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => hook(prPayload('s6', 'opened', 6), `race-${i}`)));
    assert.ok(rs.every((r) => r.status === 202));
    await waitFor(() => gh.reviews.length > before, 'race review');
    await sleep(2500);
    assert.equal(gh.reviews.filter((r) => r.pr === 6).length, 1);
    assert.equal(gh.openaiCalls - aiBefore, 2, 'only one agent run');
  });

  await step('RETRY: transient GitHub 500 while posting -> job retries with backoff, review posted once', async () => {
    gh.failPost[3] = [500];
    assert.equal((await hook(prPayload('s3', 'opened', 3), 'r3')).status, 202);
    await waitFor(() => gh.reviews.some((r) => r.pr === 3), 'retried post', 30000);
    assert.equal(gh.reviews.filter((r) => r.pr === 3).length, 1);
    assert.equal(gh.postAttempts[3], 2);
    const doc = (await (await api('/reviews?q=Add')).json()).items.find((i) => i.prNumber === 3);
    assert.equal(doc.status, 'completed');
  });

  await step('FATAL: GitHub 401 -> marked failed immediately, no retry storm', async () => {
    gh.authFailPr = 4; const before = gh.prHits;
    assert.equal((await hook(prPayload('s4', 'opened', 4), 'f4')).status, 202);
    await waitFor(async () => (await (await api('/reviews?status=failed')).json()).items.some((i) => i.prNumber === 4), 'failed status');
    await sleep(7000);
    assert.equal(gh.prHits - before, 1, 'not retried');
    const full = await (await api(`/reviews/${(await (await api('/reviews?status=failed')).json()).items[0]._id}`)).json();
    assert.match(full.error, /Bad credentials/);
  });

  await step('RECOVERY: after fixing credentials, a redelivery of the failed commit is reviewed', async () => {
    gh.authFailPr = null;
    assert.equal((await hook(prPayload('s4', 'synchronize', 4), 'f4-retry')).status, 202);
    await waitFor(() => gh.reviews.some((r) => r.pr === 4), 'recovered review', 20000);
    const doc = (await (await api('/reviews?status=completed')).json()).items.find((i) => i.prNumber === 4);
    assert.ok(doc, 'status flipped failed -> completed');
    assert.equal(gh.reviews.filter((r) => r.pr === 4).length, 1);
  });

  await step('422 on inline comments -> falls back to summary-only review', async () => {
    gh.failPost[5] = [422];
    assert.equal((await hook(prPayload('s5', 'opened', 5), 'f5')).status, 202);
    await waitFor(() => gh.reviews.some((r) => r.pr === 5), 'fallback review');
    const r = gh.reviews.find((x) => x.pr === 5);
    assert.equal(r.comments.length, 0);
    assert.match(r.body, /SQL injection/);
    assert.equal(gh.postAttempts[5], 2);
  });

  await step('processes are healthy (no crashes / unhandled errors in logs)', async () => {
    for (const p of procs) { assert.equal(p.exitCode, null, `${p.name} exited`); assert.ok(!/unhandled|ECONNREFUSED|TypeError|ReferenceError/i.test(p.logs), `${p.name} logs:\n${p.logs.slice(0, 1500)}`); }
  });

  await step('worker drains and exits 0 on SIGTERM', async () => {
    const code = await new Promise((r) => { workerProc.once('exit', (c) => r(c)); workerProc.kill('SIGTERM'); setTimeout(() => r('timeout'), 8000); });
    assert.equal(code, 0);
  });
} catch (e) {
  failed += 1; console.log('HARNESS ERROR:', e.message);
  for (const p of procs) console.log(`--- ${p.name} logs ---\n${p.logs.slice(0, 2500)}`);
} finally {
  for (const p of procs) p.kill('SIGTERM');
  await sleep(1200);
  const mongoose = (await import('mongoose')).default;
  await mongoose.connect(env.MONGO_URI).then(() => mongoose.connection.dropDatabase()).catch(() => {});
  await mongoose.disconnect().catch(() => {});
  ghServer.close(); aiServer.close();
  console.log(failed ? `\n${failed} FAILED` : '\nALL E2E CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}
