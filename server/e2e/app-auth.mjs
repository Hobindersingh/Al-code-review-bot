// Verifies GitHub App auth: JWT -> installation token -> authenticated API call (with a real RSA key).
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { GitHubService } from '../src/services/github.js';
import { loadConfig } from '../src/config.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const seen = [];
const srv = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/app/installations/9/access_tokens') { res.statusCode = 201; return res.end(JSON.stringify({ token: 'ghs_installtoken', expires_at: new Date(Date.now() + 3600e3).toISOString(), permissions: {}, repository_selection: 'all' })); }
  if (req.url === '/repos/o/r/pulls/1') return res.end(JSON.stringify({ state: 'open', draft: false, merged: false, title: 'T', head: { sha: 'abc' } }));
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => srv.listen(4400, r));
// private key supplied the way .env files do it: newlines escaped as \n
const config = loadConfig({ GITHUB_WEBHOOK_SECRET: 'secret-123456', GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'), GITHUB_API_URL: 'http://127.0.0.1:4400' });
const gh = new GitHubService(config);
const pr = await gh.getPullRequest({ owner: 'o', repo: 'r', prNumber: 1, installationId: 9 });
srv.close();
assert.equal(pr.headSha, 'abc');
const tokenReq = seen.find((s) => s.url.includes('access_tokens'));
assert.match(tokenReq.auth, /^bearer eyJ/i, 'app JWT used to mint installation token');
assert.equal(seen.find((s) => s.url.endsWith('/pulls/1')).auth, 'token ghs_installtoken');
await assert.rejects(new GitHubService(loadConfig({ GITHUB_WEBHOOK_SECRET: 'secret-123456' })).getPullRequest({ owner: 'o', repo: 'r', prNumber: 1 }), /No GitHub credentials/);
console.log('PASS  GitHub App auth: JWT -> installation token -> API call; missing creds fail clearly');
process.exit(0);
