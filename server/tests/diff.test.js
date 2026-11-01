import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch, renderNumbered, shouldReview } from '../src/utils/diff.js';
import { PATCH } from './helpers.js';

test('parsePatch tracks new-file line numbers across context, additions and deletions', () => {
  const p = parsePatch(PATCH);
  assert.deepEqual([...p.rightLines], [10, 11, 12, 13, 14]);
  assert.deepEqual([...p.addedLines], [11, 12]);
});

test('parsePatch handles multiple hunks and ignores "No newline" markers', () => {
  const p = parsePatch('@@ -1,2 +1,2 @@\n a\n+b\n@@ -50,1 +60,2 @@\n x\n+y\n\\ No newline at end of file\n');
  assert.deepEqual([...p.addedLines], [2, 61]);
  assert.ok(!p.rightLines.has(3));
});

test('parsePatch tolerates empty / undefined patches', () => {
  assert.equal(parsePatch('').rightLines.size, 0);
  assert.equal(parsePatch(undefined).rightLines.size, 0);
});

test('renderNumbered prints new-file numbers and truncates on budget', () => {
  const text = renderNumbered(parsePatch(PATCH));
  assert.match(text, /\s11 \+ const b = userInput;/);
  assert.match(text, /\s+- const b = 2;/);
  assert.match(renderNumbered(parsePatch(PATCH), 40), /diff truncated/);
});

test('shouldReview skips lockfiles, minified, binaries and build output', () => {
  for (const f of ['package-lock.json', 'a/yarn.lock', 'x.min.js', 'logo.png', 'dist/app.js', 'a.snap']) assert.equal(shouldReview(f), false, f);
  for (const f of ['src/app.js', 'README.md', 'server/index.ts']) assert.equal(shouldReview(f), true, f);
});
