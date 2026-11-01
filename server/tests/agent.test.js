import test from 'node:test';
import assert from 'node:assert/strict';
import { runReviewAgent, AgentError } from '../src/agent/agent.js';
import { createToolbox } from '../src/agent/tools.js';
import { assistant, fakeOpenAI, makeFile, silentLogger, toolCall } from './helpers.js';

const limits = { maxIterations: 5, maxToolCalls: 3, tokenBudget: 100000, maxToolOutputChars: 5000 };
const submit = { summary: 'Looks risky.', findings: [{ path: 'src/a.js', line: 12, severity: 'high', category: 'security', confidence: 0.9, title: 'SQL injection', body: 'Concatenated SQL query.' }] };

function setup(script, over = {}) {
  const github = {
    async getFileContent() { return { text: 'l1\nl2\nl3\nl4' }; },
    async searchCode() { return { total: 1, paths: ['src/b.js'] }; },
    ...over.github,
  };
  const toolbox = createToolbox({ github, ctx: {}, headSha: 'abcdef1234', files: [makeFile()], limits });
  const openai = fakeOpenAI(script);
  const run = (l = limits) => runReviewAgent({ openai, model: 'm', messages: [{ role: 'user', content: 'x' }], toolbox, limits: l, logger: silentLogger });
  return { openai, run, toolbox };
}

test('agent uses tools, then submits; usage and counters are tracked', async () => {
  const { run, openai } = setup([
    assistant(toolCall('1', 'get_file_content', { path: 'src/a.js', start_line: 2, end_line: 3 })),
    assistant(toolCall('2', 'submit_review', submit)),
  ]);
  const r = await run();
  assert.equal(r.findings.length, 1);
  assert.equal(r.toolCalls, 1);
  assert.equal(r.iterations, 2);
  assert.equal(r.usage.promptTokens, 2000);
  const toolMsg = openai.calls[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /l2/);
});

test('invalid submission is fed back to the model, which can correct itself', async () => {
  const { run } = setup([assistant(toolCall('1', 'submit_review', { summary: 's', findings: [{ path: 'a' }] })), assistant(toolCall('2', 'submit_review', submit))]);
  assert.equal((await run()).findings.length, 1);
});

test('gives up with AgentError after repeated invalid submissions', async () => {
  const bad = assistant(toolCall('1', 'submit_review', { nope: true }));
  await assert.rejects(setup([bad]).run(), (e) => e instanceof AgentError && e.code === 'invalid_submission');
});

test('final iteration forces submit_review via tool_choice (bounded loop)', async () => {
  const loop = assistant(toolCall('x', 'list_changed_files', {}));
  const { run, openai } = setup([loop, loop, (req) => (req.tool_choice === 'required' ? assistant(toolCall('s', 'submit_review', submit)) : loop)]);
  const r = await run({ ...limits, maxIterations: 3 });
  assert.equal(r.iterations, 3);
  assert.equal(openai.calls.at(-1).tool_choice, 'required');
  assert.deepEqual(openai.calls.at(-1).tools.map((t) => t.function.name), ['submit_review'], 'only the submit tool is offered');
});

test('token budget forces submission', async () => {
  const heavy = { ...assistant(toolCall('x', 'list_changed_files', {})), __p: 90000, __c: 20000 };
  const { run, openai } = setup([heavy, assistant(toolCall('s', 'submit_review', submit))]);
  await run();
  assert.equal(openai.calls[1].tool_choice, 'required');
});

test('plain-text reply (no tool call) is nudged to submit; empty loop ends in AgentError', async () => {
  const chatty = { role: 'assistant', content: 'LGTM!' };
  await assert.rejects(setup([chatty]).run({ ...limits, maxIterations: 2 }), (e) => e.code === 'no_submission');
});

test('toolbox: unknown tool, bad JSON, bad args, missing file, github failure are all returned as {error}', async () => {
  const { toolbox } = setup([], { github: { async getFileContent() { throw new Error('boom'); } } });
  assert.match(await toolbox.execute('rm_rf', '{}'), /Unknown tool/);
  assert.match(await toolbox.execute('get_file_diff', '{not json'), /valid JSON/);
  assert.match(await toolbox.execute('get_file_diff', '{}'), /path/);
  assert.match(await toolbox.execute('get_file_diff', '{"path":"../../etc/passwd"}'), /not a changed/);
  assert.match(await toolbox.execute('get_file_content', '{"path":"x.js"}'), /Tool failed: boom/);
});
