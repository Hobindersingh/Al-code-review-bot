import test from 'node:test';
import assert from 'node:assert/strict';
import { runReviewAgent } from '../src/agent/agent.js';
import { createToolbox } from '../src/agent/tools.js';
import { SUBMIT_TOOL } from '../src/agent/schema.js';
import { fakeOpenAI, makeFile, silentLogger } from './helpers.js';

const limits = { maxIterations: 5, maxToolCalls: 5, tokenBudget: 100000, maxToolOutputChars: 5000 };
const submit = { summary: 's', findings: [] };
const toolbox = () => createToolbox({ github: { async getFileContent() { return { text: 'a\nb' }; }, async searchCode() { return {}; } }, ctx: {}, headSha: 'abcdef1', files: [makeFile()], limits });
const run = (script, extra = {}) => { const openai = fakeOpenAI(script); return { openai, p: runReviewAgent({ openai, model: 'gemini-x', messages: [{ role: 'user', content: 'x' }], toolbox: toolbox(), limits, logger: silentLogger, ...extra }) }; };

test('Gemini 3 thought signatures: assistant message is echoed back UNCHANGED (extra_content kept)', async () => {
  const geminiMsg = { role: 'assistant', content: null, tool_calls: [{ id: 'fc1', type: 'function', extra_content: { google: { thought_signature: 'SIG==' } }, function: { name: 'list_changed_files', arguments: '{}' } }] };
  const { openai, p } = run([geminiMsg, { role: 'assistant', content: null, tool_calls: [{ id: 'fc2', type: 'function', function: { name: 'submit_review', arguments: JSON.stringify(submit) } }] }]);
  await p;
  const echoed = openai.calls[1].messages.find((m) => m.role === 'assistant');
  assert.equal(echoed.tool_calls[0].extra_content.google.thought_signature, 'SIG==');
});

test('empty/missing tool-call ids are repaired so tool results can be matched', async () => {
  const msg = { role: 'assistant', content: null, tool_calls: [{ id: '', type: 'function', function: { name: 'list_changed_files', arguments: '{}' } }, { type: 'function', function: { name: 'list_changed_files', arguments: '{}' } }] };
  const { openai, p } = run([msg, { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'submit_review', arguments: JSON.stringify(submit) } }] }]);
  await p;
  const hist = openai.calls[1].messages;
  const ids = hist.find((m) => m.role === 'assistant').tool_calls.map((c) => c.id);
  const toolIds = hist.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.ok(ids.every(Boolean) && new Set(ids).size === 2);
  assert.deepEqual(toolIds, ids);
});

test('arguments already parsed as an object (non-string) are accepted', async () => {
  const { p } = run([{ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'submit_review', arguments: submit } }] }]);
  assert.equal((await p).summary, 's');
});

test('reasoning_effort is sent only when configured; temperature only when defined', async () => {
  const ok = { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'submit_review', arguments: JSON.stringify(submit) } }] };
  const a = run([ok], { reasoningEffort: 'low' }); await a.p;
  assert.equal(a.openai.calls[0].reasoning_effort, 'low');
  assert.ok(!('temperature' in a.openai.calls[0]));
  const b = run([ok], { temperature: 0.1 }); await b.p;
  assert.ok(!('reasoning_effort' in b.openai.calls[0]));
  assert.equal(b.openai.calls[0].temperature, 0.1);
});

test('tool schemas use only the OpenAPI subset Gemini accepts (no additionalProperties, no empty properties/required)', () => {
  const problems = [];
  const walk = (o, path) => {
    if (!o || typeof o !== 'object') return;
    if ('additionalProperties' in o) problems.push(`${path}: additionalProperties`);
    if (o.properties && !Object.keys(o.properties).length) problems.push(`${path}: empty properties`);
    if (Array.isArray(o.required) && !o.required.length) problems.push(`${path}: empty required`);
    for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
  };
  walk([...toolbox().definitions, SUBMIT_TOOL], 'tools');
  assert.deepEqual(problems, []);
  assert.ok(toolbox().definitions.find((t) => t.function.name === 'list_changed_files').function.parameters === undefined);
});
