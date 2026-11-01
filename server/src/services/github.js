import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

const MAX_FILE_BYTES = 1_000_000;

/** Thin wrapper over Octokit. Supports a GitHub App (preferred, per-installation) or a PAT. */
export class GitHubService {
  constructor(config, { octokitFactory } = {}) {
    this.config = config;
    this.factory = octokitFactory ?? ((id) => this.#defaultFactory(id));
    this.clients = new Map();
  }

  #defaultFactory(installationId) {
    const { githubAppId, githubPrivateKey, githubToken } = this.config;
    const userAgent = 'ai-code-review-bot';
    const baseUrl = this.config.githubApiUrl; // for GitHub Enterprise or test doubles
    if (githubAppId && githubPrivateKey && installationId) {
      return new Octokit({ authStrategy: createAppAuth, auth: { appId: githubAppId, privateKey: githubPrivateKey, installationId }, userAgent, ...(baseUrl && { baseUrl }) });
    }
    if (githubToken) return new Octokit({ auth: githubToken, userAgent, ...(baseUrl && { baseUrl }) });
    throw new Error('No GitHub credentials available for this event');
  }

  #client(installationId) {
    const key = installationId ?? 'pat';
    if (!this.clients.has(key)) this.clients.set(key, this.factory(installationId));
    return this.clients.get(key);
  }

  async getPullRequest(ctx) {
    const { data } = await this.#client(ctx.installationId).rest.pulls.get({ owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber });
    return { state: data.state, draft: data.draft, merged: data.merged, headSha: data.head.sha, title: data.title };
  }

  async listFiles(ctx) {
    const o = this.#client(ctx.installationId);
    return o.paginate(o.rest.pulls.listFiles, { owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber, per_page: 100 });
  }

  /** Returns {text} | {error} | null (404) */
  async getFileContent(ctx, path, ref) {
    try {
      const { data } = await this.#client(ctx.installationId).rest.repos.getContent({ owner: ctx.owner, repo: ctx.repo, path, ref });
      if (Array.isArray(data) || data.type !== 'file') return { error: 'path is not a file' };
      if (!data.content || data.size > MAX_FILE_BYTES) return { error: 'file too large to fetch through the API' };
      return { text: Buffer.from(data.content, 'base64').toString('utf8') };
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async searchCode(ctx, query) {
    try {
      const q = `${query} repo:${ctx.owner}/${ctx.repo}`;
      const { data } = await this.#client(ctx.installationId).rest.search.code({ q, per_page: 10 });
      return { total: data.total_count, paths: data.items.map((i) => i.path) };
    } catch (err) {
      return { error: `code search unavailable (${err.status ?? 'error'})` };
    }
  }

  /** Used before posting so a retried job never posts a second review for the same commit. */
  async findReviewByMarker(ctx, marker) {
    const o = this.#client(ctx.installationId);
    const reviews = await o.paginate(o.rest.pulls.listReviews, { owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber, per_page: 100 });
    return reviews.find((r) => r.body?.includes(marker))?.id ?? null;
  }

  async createReview(ctx, { commitId, body, comments }) {
    const { data } = await this.#client(ctx.installationId).rest.pulls.createReview({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.prNumber,
      commit_id: commitId,
      event: 'COMMENT',
      body,
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
    });
    return data.id;
  }
}
