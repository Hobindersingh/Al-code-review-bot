import { parsePatch } from '../src/utils/diff.js';

export const PATCH = [
  '@@ -10,4 +10,6 @@ function a() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = userInput;',
  '+db.query("SELECT * FROM t WHERE id=" + b);',
  ' return a;',
  ' }',
  '\\ No newline at end of file',
].join('\n');

export function makeFile(over = {}) {
  const patch = over.patch ?? PATCH;
  return { filename: 'src/a.js', status: 'modified', additions: 2, deletions: 1, patch, parsed: parsePatch(patch), ...over };
}

export const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

/** Minimal fake of the OpenAI client: replays scripted assistant messages. */
export function fakeOpenAI(script) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        async create(req) {
          calls.push(req);
          const next = script[Math.min(calls.length - 1, script.length - 1)];
          const msg = typeof next === 'function' ? next(req) : next;
          return { choices: [{ message: msg }], usage: { prompt_tokens: msg.__p ?? 1000, completion_tokens: msg.__c ?? 100 } };
        },
      },
    },
  };
}

export const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
export const assistant = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
