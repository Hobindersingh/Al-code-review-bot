import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSignature, isValidSignature } from '../src/middleware/verifySignature.js';
import { neutralizeMentions, sanitizeText } from '../src/utils/sanitize.js';

const secret = 'topsecret123';
const body = Buffer.from('{"hello":"world"}');

test('accepts a correct HMAC-SHA256 signature', () => {
  assert.equal(isValidSignature(secret, body, computeSignature(secret, body)), true);
});

test('rejects wrong secret, tampered body, missing header, wrong length, parsed (non-raw) body', () => {
  const sig = computeSignature(secret, body);
  assert.equal(isValidSignature('other-secret', body, sig), false);
  assert.equal(isValidSignature(secret, Buffer.from('{"hello":"w0rld"}'), sig), false);
  assert.equal(isValidSignature(secret, body, undefined), false);
  assert.equal(isValidSignature(secret, body, 'sha256=abc'), false);
  assert.equal(isValidSignature(secret, { hello: 'world' }, sig), false);
});

test('sanitizeText neutralizes mentions, images, and HTML-comment marker spoofing', () => {
  const out = sanitizeText('ping @octocat and @org/team ![x](http://evil/?d=1) <!-- aicr:abc --> <img src="http://e">');
  assert.ok(!/@octocat/.test(out) && !/@org/.test(out));
  assert.ok(!out.includes('http://evil') && !out.includes('<!--') && !out.includes('<img'));
  assert.ok(neutralizeMentions('mail me a@b.com').includes('a@b.com'), 'emails untouched');
});

test('sanitizeText truncates long output', () => {
  assert.ok(sanitizeText('x'.repeat(5000), 100).length <= 100);
});
