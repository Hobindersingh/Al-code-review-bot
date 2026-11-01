import { z } from 'zod';
import { renderNumbered } from '../utils/diff.js';

const noArgs = z.object({}).passthrough();
const pathArg = z.object({ path: z.string().min(1).max(500) });
const contentArgs = z.object({
  path: z.string().min(1).max(500),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
});
const searchArgs = z.object({ query: z.string().min(2).max(120) });

// Providers like Gemini reject empty `properties` / `required`, so parameter-less tools omit `parameters`.
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: {
    name,
    description,
    ...(Object.keys(properties).length
      ? { parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } }
      : {}),
  },
});

const DEFINITIONS = [
  fn('list_changed_files', 'List every reviewable file changed in this PR with status and line counts.'),
  fn(
    'get_file_diff',
    'Get the full diff of one changed file with new-file line numbers. Use when the initial diff was truncated.',
    { path: { type: 'string' } },
    ['path'],
  ),
  fn(
    'get_file_content',
    'Read a file from the PR head commit (max 400 lines per call). Use it to understand surrounding code, callers, types and imports before flagging an issue.',
    {
      path: { type: 'string' },
      start_line: { type: 'integer', description: 'Default 1' },
      end_line: { type: 'integer', description: 'Default start_line + 299' },
    },
    ['path'],
  ),
  fn(
    'search_code',
    'Search the repository (default branch index) for a symbol or string, e.g. to find callers of a changed function. Returns matching file paths.',
    { query: { type: 'string' } },
    ['query'],
  ),
];

/**
 * Read-only toolbox. Results are plain JSON strings; failures are returned to the model
 * as {error} instead of thrown so one bad call never kills the whole review.
 */
export function createToolbox({ github, ctx, headSha, files, limits }) {
  const byPath = new Map(files.map((f) => [f.filename, f]));
  const contentCache = new Map();

  const handlers = {
    async list_changed_files() {
      return files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }));
    },
    async get_file_diff({ path }) {
      const f = byPath.get(path);
      if (!f) return { error: `"${path}" is not a changed reviewable file. Use list_changed_files.` };
      return { path, diff: renderNumbered(f.parsed, 20000) };
    },
    async get_file_content({ path, start_line = 1, end_line }) {
      const end = Math.min(end_line ?? start_line + 299, start_line + 399);
      if (end < start_line) return { error: 'end_line must be >= start_line' };
      if (!contentCache.has(path)) contentCache.set(path, await github.getFileContent(ctx, path, headSha));
      const file = contentCache.get(path);
      if (!file) return { error: `"${path}" not found at ${headSha.slice(0, 7)}` };
      if (file.error) return { error: file.error };
      const all = file.text.split('\n');
      const slice = all.slice(start_line - 1, end).map((l, i) => `${String(start_line + i).padStart(5)}  ${l}`);
      return { path, total_lines: all.length, start_line, end_line: Math.min(end, all.length), content: slice.join('\n') };
    },
    async search_code({ query }) {
      return github.searchCode(ctx, query);
    },
  };

  const schemas = {
    list_changed_files: noArgs,
    get_file_diff: pathArg,
    get_file_content: contentArgs,
    search_code: searchArgs,
  };

  async function execute(name, rawArgs) {
    const handler = handlers[name];
    if (!handler) return JSON.stringify({ error: `Unknown tool "${name}"` });
    let args;
    try {
      args = typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : JSON.parse(rawArgs || '{}');
    } catch {
      return JSON.stringify({ error: 'Arguments must be valid JSON' });
    }
    const parsed = schemas[name].safeParse(args);
    if (!parsed.success) {
      return JSON.stringify({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    try {
      const out = JSON.stringify(await handler(parsed.data));
      return out.length > limits.maxToolOutputChars ? `${out.slice(0, limits.maxToolOutputChars)}…[truncated]` : out;
    } catch (err) {
      return JSON.stringify({ error: `Tool failed: ${err.message}` });
    }
  }

  return { definitions: DEFINITIONS, execute };
}
