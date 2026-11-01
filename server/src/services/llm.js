import OpenAI from 'openai';
import { createRateLimiter } from '../utils/rateLimit.js';

/**
 * One OpenAI-compatible client for every provider (Gemini, OpenAI, Groq, OpenRouter, Ollama...).
 * Every request first passes a per-process rate limiter so free-tier RPM limits are respected
 * even when several jobs run concurrently.
 */
export function createLlmClient(llm, { OpenAIClass = OpenAI } = {}) {
  const client = new OpenAIClass({
    apiKey: llm.apiKey,
    ...(llm.baseUrl ? { baseURL: llm.baseUrl } : {}),
    maxRetries: 3, // SDK honours Retry-After on 429/5xx
    timeout: 120_000,
  });
  const acquire = createRateLimiter(llm.maxRpm);
  return {
    chat: {
      completions: {
        async create(body, opts) {
          await acquire();
          return client.chat.completions.create(body, opts);
        },
      },
    },
  };
}
