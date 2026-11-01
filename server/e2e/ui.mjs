// Needs `npm install` in ../client (for esbuild) plus Redis + MongoDB running.
// UI test: bundles the real React app, loads it in jsdom against the real API + MongoDB, and clicks through it.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Review } from '../src/models/Review.js';

const BUNDLE = path.join(os.tmpdir(), 'aicr-ui-bundle.js');
const KEY = 'dashboard-key-1234567', PORT = 4101, BASE = `http://127.0.0.1:${PORT}`;
const MONGO_URI = `mongodb://127.0.0.1:27017/aicr_ui_${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(100); } throw new Error(`timeout: ${what}`); };

execFileSync('../client/node_modules/.bin/esbuild', ['../client/src/main.jsx', '--bundle', '--format=iife', '--jsx=automatic', '--loader:.css=empty', '--define:process.env.NODE_ENV="production"', `--outfile=${BUNDLE}`, '--log-level=error'], { stdio: 'inherit' });
const bundle = fs.readFileSync(BUNDLE, 'utf8');

await mongoose.connect(MONGO_URI); await Review.init();
const f = (o) => ({ path: 'src/a.js', line: 12, severity: 'high', category: 'security', confidence: 0.9, title: 'SQL injection', body: 'User input reaches the query.', placement: 'inline', ...o });
await Review.create([
  { repoFullName: 'acme/api', prNumber: 7, headSha: 'a'.repeat(40), title: 'Add user search', author: 'sam', status: 'completed', summary: 'Adds search with a raw query.', model: 'm',
    findings: [f({ suggestion: 'db.query(sql, [id]);' }), f({ line: 30, severity: 'low', category: 'style', title: 'Naming', body: 'Rename x.' })],
    stats: { files: 2, iterations: 2, toolCalls: 1, promptTokens: 1000, completionTokens: 100, durationMs: 4200 } },
  { repoFullName: 'acme/web', prNumber: 3, headSha: 'b'.repeat(40), title: 'Broken run', author: 'kim', status: 'failed', error: 'Bad credentials' },
  { repoFullName: 'acme/web', prNumber: 4, headSha: 'c'.repeat(40), title: 'Docs only', author: 'kim', status: 'completed', summary: 'Docs.', findings: [], stats: { durationMs: 1000, promptTokens: 10, completionTokens: 5 } },
]);

const server = spawn('node', ['src/index.js'], { env: { ...process.env, LOG_LEVEL: 'error', PORT: String(PORT), MONGO_URI, REDIS_URL: 'redis://127.0.0.1:6379', GITHUB_WEBHOOK_SECRET: 'x'.repeat(12), DASHBOARD_API_KEY: KEY }, stdio: 'inherit' });
let failed = 0;
const step = async (n, fn) => { try { await fn(); console.log(`  PASS  ${n}`); } catch (e) { failed += 1; console.log(`  FAIL  ${n}\n        ${e.message}`); } };
let dom;
try {
  await until(async () => (await fetch(`${BASE}/health`)).ok, 'api');
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message)); vc.on('error', (...a) => errors.push(a.join(' ')));
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: `${BASE}/`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.fetch = (u, o) => fetch(new URL(u, BASE), o); w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; if (process.argv.includes('--withkey')) w.localStorage.setItem('aicr_api_key', KEY); } });
  const { document } = dom.window;
  console.log('UI test (real API + MongoDB, jsdom)\n');

  await step('without a key: shows the API-key prompt, not a crash', async () => {
    dom.window.eval(bundle);
    await until(() => document.body.textContent.includes('Enter your dashboard API key'), 'key prompt');
  });
  await step('entering the key loads the inbox and overview', async () => {
    const input = document.querySelector('.keybox input');
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, KEY); input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(100);
    [...document.querySelectorAll('.keybox button')][0].click();
    await until(() => document.querySelectorAll('.row').length === 3, '3 review rows');
    await until(() => document.querySelector('.ledger'), 'ledger');
  });
  await step('ledger numbers match the data', async () => {
    const t = document.querySelector('.ledger').textContent;
    assert.match(t, /Pull requests reviewed2 of 3/);
    assert.match(t, /Findings raised2/);
    assert.match(t, /Failure rate33%/);
  });
  await step('inbox rows show status, findings and urgent counts', async () => {
    const rows = [...document.querySelectorAll('.row')].map((r) => r.textContent);
    const api = rows.find((r) => r.includes('acme/api#7'));
    assert.match(api, /completed/); assert.match(api, /2 findings/); assert.match(api, /1 urgent/);
    assert.ok(rows.some((r) => r.includes('failed')));
  });
  await step('severity + category panels render', async () => {
    assert.ok(document.querySelector('.sevbar'));
    assert.match(document.body.textContent, /security/);
  });
  await step('status filter narrows the list', async () => {
    const sel = document.querySelector('.filters select');
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(sel, 'failed');
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await until(() => document.querySelectorAll('.row').length === 1, 'filtered to 1');
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(sel, '');
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await until(() => document.querySelectorAll('.row').length === 3, 'restored');
  });
  await step('opening a review shows summary, findings, suggestion', async () => {
    [...document.querySelectorAll('.row')].find((r) => r.textContent.includes('acme/api#7')).click();
    await until(() => document.querySelectorAll('.finding').length === 2, 'findings');
    assert.match(document.body.textContent, /Adds search with a raw query/);
    assert.equal(document.querySelector('.suggest').textContent, 'db.query(sql, [id]);');
  });
  await step('clicking "Helpful" persists feedback to MongoDB and updates the button', async () => {
    [...document.querySelectorAll('.fb button')].find((b) => b.textContent === 'Helpful').click();
    await until(() => document.querySelector('.fb button[aria-pressed="true"]'), 'pressed state');
    const doc = await Review.findOne({ prNumber: 7 }).lean();
    assert.equal(doc.findings.filter((x) => x.feedback === 'helpful').length, 1);
  });
  await step('failed review shows its error; back returns to overview', async () => {
    [...document.querySelectorAll('.link')].find((b) => b.textContent.includes('Back')).click();
    await until(() => document.querySelector('.ledger'), 'overview');
    [...document.querySelectorAll('.row')].find((r) => r.textContent.includes('acme/web#3')).click();
    await until(() => document.querySelector('.notice.error'), 'error notice');
    assert.match(document.querySelector('.notice.error').textContent, /Bad credentials/);
  });
  await step('no runtime errors were logged by the app', async () => assert.deepEqual(errors, []));
} catch (e) { failed += 1; console.log('HARNESS ERROR:', e.message); }
finally {
  dom?.window.close(); server.kill('SIGTERM');
  await mongoose.connection.dropDatabase().catch(() => {}); await mongoose.disconnect();
  console.log(failed ? `\n${failed} FAILED` : '\nALL UI CHECKS PASSED'); process.exit(failed ? 1 : 0);
}
