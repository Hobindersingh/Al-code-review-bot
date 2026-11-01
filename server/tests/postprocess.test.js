import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeFindings } from '../src/agent/postprocess.js';
import { formatComment, formatReviewBody } from '../src/agent/format.js';
import { makeFile } from './helpers.js';

const opts = { minConfidence: 0.6, minSeverity: 'low', maxInline: 2 };
const files = new Map([['src/a.js', makeFile()]]);
const f = (o) => ({ path: 'src/a.js', line: 12, severity: 'high', category: 'security', confidence: 0.9, title: 'SQL injection', body: 'User input concatenated into SQL.', ...o });

test('keeps valid findings inline and sorts by severity', () => {
  const r = finalizeFindings([f({ severity: 'low', line: 11, title: 'Naming' }), f()], files, opts);
  assert.equal(r.inline.length, 2);
  assert.equal(r.inline[0].severity, 'high');
});

test('drops unknown files, low confidence, low severity and duplicates', () => {
  const r = finalizeFindings(
    [f({ path: 'nope.js' }), f({ confidence: 0.2, line: 11, title: 'Maybe' }), f({ severity: 'info', line: 10, title: 'FYI' }), f(), f({ title: 'SQL injection!' })],
    files,
    { ...opts, minSeverity: 'low' },
  );
  assert.deepEqual(r.dropped, { unknownFile: 1, lowConfidence: 1, lowSeverity: 1, duplicate: 1 });
  assert.equal(r.inline.length, 1);
});

test('lines outside the diff go to the summary, never to GitHub as inline comments', () => {
  const r = finalizeFindings([f({ line: 999, title: 'Elsewhere' })], files, opts);
  assert.equal(r.inline.length, 0);
  assert.equal(r.general[0].placement, 'summary');
});

test('overflow beyond maxInline is moved to the summary', () => {
  const r = finalizeFindings([f({ line: 10, title: 'a1', category: 'bug' }), f({ line: 11, title: 'b2', category: 'bug' }), f({ line: 12, title: 'c3', category: 'bug' })], files, opts);
  assert.equal(r.inline.length, 2);
  assert.equal(r.general.length, 1);
});

test('suggestions only survive on added lines, single-line, without code fences', () => {
  const ok = finalizeFindings([f({ line: 11, suggestion: 'const b = sanitize(userInput);' })], files, opts).inline[0];
  assert.ok(ok.suggestion);
  assert.ok(!finalizeFindings([f({ line: 10, suggestion: 'x' })], files, opts).inline[0].suggestion, 'context line');
  assert.ok(!finalizeFindings([f({ line: 11, suggestion: 'a\nb' })], files, opts).inline[0].suggestion, 'multi-line');
  assert.ok(!finalizeFindings([f({ line: 11, suggestion: '```x' })], files, opts).inline[0].suggestion, 'fence');
});

test('formatting renders a suggestion block, marker and sanitised text', () => {
  const [c] = finalizeFindings([f({ line: 11, suggestion: 'fixed();', body: 'cc @bob' })], files, opts).inline;
  const text = formatComment(c);
  assert.match(text, /```suggestion\nfixed\(\);\n```/);
  assert.ok(!text.includes('@bob'));
  const body = formatReviewBody({ summary: 'ok', inline: [c], general: [], headSha: 'abc123' });
  assert.match(body, /<!-- aicr:abc123 -->/);
  assert.match(formatReviewBody({ summary: 's', inline: [], general: [], headSha: 'x' }), /No significant issues/);
});
