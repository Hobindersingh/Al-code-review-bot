import { SUBMIT_TOOL, parseSubmission } from './schema.js';

export class AgentError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'AgentError';
    this.code = code;
  }
}

/**
 * Tool-calling review agent. Loops: model -> tool calls -> results -> model ... until it calls
 * submit_review. Hard limits (iterations, tool calls, tokens) force a final submission so the loop
 * is always bounded in both time and cost.
 */
export async function runReviewAgent({ openai, model, temperature, reasoningEffort, messages: initial, toolbox, limits, logger }) {
  const messages = [...initial];
  const allTools = [...toolbox.definitions, SUBMIT_TOOL];
  const usage = { promptTokens: 0, completionTokens: 0 };
  let toolCalls = 0;
  let submitErrors = 0;

  for (let i = 0; i < limits.maxIterations; i += 1) {
    const spent = usage.promptTokens + usage.completionTokens;
    const mustSubmit = i === limits.maxIterations - 1 || spent >= limits.tokenBudget || toolCalls >= limits.maxToolCalls;

    // Forcing the final answer: offer ONLY submit_review and require a tool call. 'required' is supported by
    // every OpenAI-compatible provider (incl. Gemini), unlike forcing a named function.
    const resp = await openai.chat.completions.create({
      model,
      messages,
      tools: mustSubmit ? [SUBMIT_TOOL] : allTools,
      tool_choice: mustSubmit ? 'required' : 'auto',
      ...(temperature !== undefined ? { temperature } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    });

    usage.promptTokens += resp.usage?.prompt_tokens ?? 0;
    usage.completionTokens += resp.usage?.completion_tokens ?? 0;

    const msg = resp.choices?.[0]?.message;
    if (!msg) throw new AgentError('empty_response', 'model returned no choices');
    // Push the provider's message back UNCHANGED: Gemini 3 attaches `extra_content` (thought signatures) to
    // tool calls and returns HTTP 400 if they are not echoed. Only fill in ids some providers leave empty.
    const calls = msg.tool_calls ?? [];
    calls.forEach((c, idx) => { if (!c.id) c.id = `call_${i}_${idx}`; });
    messages.push(msg);

    if (!calls.length) {
      messages.push({ role: 'user', content: 'Finish by calling submit_review (an empty findings array is fine).' });
      continue;
    }

    for (const call of calls) {
      const name = call.function.name;

      if (name === 'submit_review') {
        const check = parseSubmission(call.function.arguments);
        if (check.ok) {
          logger?.debug({ iterations: i + 1, toolCalls }, 'agent submitted');
          return { ...check.value, usage, iterations: i + 1, toolCalls };
        }
        submitErrors += 1;
        if (submitErrors > 2) throw new AgentError('invalid_submission', check.error);
        messages.push({ role: 'tool', tool_call_id: call.id, content: `Invalid submission: ${check.error}. Fix it and call submit_review again.` });
        continue;
      }

      if (toolCalls >= limits.maxToolCalls) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Tool budget exhausted. Call submit_review now.' });
        continue;
      }
      toolCalls += 1;
      const content = await toolbox.execute(name, call.function.arguments);
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  throw new AgentError('no_submission', 'agent did not submit a review within its limits');
}
