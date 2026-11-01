import 'dotenv/config';
import { z } from 'zod';

const blank = (v) => (v === '' ? undefined : v);
const bool = z.preprocess((v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : v), z.boolean());

/** Provider presets. Everything is overridable through LLM_* variables. */
export const PRESETS = {
  // Free Google Gemini through its OpenAI-compatible endpoint (default).
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-3.8-flash',
    reasoningEffort: 'low', // keeps latency and token use down; Gemini 3 cannot disable reasoning entirely
    temperature: undefined, // Gemini 3 works best at its default temperature
    maxRpm: 8, // stay under free-tier request-per-minute limits
  },
  openai: { baseUrl: undefined, model: 'gpt-4o-mini', reasoningEffort: undefined, temperature: 0.1, maxRpm: 0 },
  // Any other OpenAI-compatible API (Groq, OpenRouter, Ollama...). Needs LLM_BASE_URL + LLM_MODEL.
  custom: { baseUrl: undefined, model: undefined, reasoningEffort: undefined, temperature: undefined, maxRpm: 0 },
};

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.string().default('info'),
  MONGO_URI: z.string().default('mongodb://localhost:27017/ai-code-review'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().default(0),
  DASHBOARD_API_KEY: z.preprocess(blank, z.string().min(16).optional()),

  GITHUB_WEBHOOK_SECRET: z.string().min(8, 'GITHUB_WEBHOOK_SECRET must be at least 8 chars'),
  GITHUB_API_URL: z.preprocess(blank, z.string().url().optional()),
  GITHUB_TOKEN: z.preprocess(blank, z.string().optional()),
  GITHUB_APP_ID: z.preprocess(blank, z.string().optional()),
  GITHUB_APP_PRIVATE_KEY: z.preprocess(blank, z.string().optional()),

  LLM_PROVIDER: z.enum(['gemini', 'openai', 'custom']).default('gemini'),
  LLM_API_KEY: z.preprocess(blank, z.string().optional()),
  GEMINI_API_KEY: z.preprocess(blank, z.string().optional()),
  OPENAI_API_KEY: z.preprocess(blank, z.string().optional()),
  LLM_BASE_URL: z.preprocess(blank, z.string().url().optional()),
  LLM_MODEL: z.preprocess(blank, z.string().optional()),
  LLM_TEMPERATURE: z.preprocess(blank, z.coerce.number().min(0).max(2).optional()),
  LLM_REASONING_EFFORT: z.preprocess(blank, z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional()),
  LLM_MAX_RPM: z.preprocess(blank, z.coerce.number().int().min(0).optional()),

  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(2).max(20).default(8),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(0).max(40).default(12),
  AGENT_TOKEN_BUDGET: z.coerce.number().int().min(5000).default(120000),
  MAX_FILES: z.coerce.number().int().min(1).default(40),
  MAX_DIFF_CHARS: z.coerce.number().int().min(2000).default(60000),
  MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  MIN_SEVERITY: z.enum(['info', 'low', 'medium', 'high', 'critical']).default('low'),
  MAX_INLINE_COMMENTS: z.coerce.number().int().min(1).max(50).default(12),
  POST_WHEN_CLEAN: bool.default(true),
  DRY_RUN: bool.default(false),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  WORKER_RATE_PER_MIN: z.coerce.number().int().min(1).default(30),
});

export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${msg}`);
  }
  const e = parsed.data;
  const preset = PRESETS[e.LLM_PROVIDER];
  const apiKey =
    e.LLM_API_KEY ?? (e.LLM_PROVIDER === 'gemini' ? e.GEMINI_API_KEY : e.OPENAI_API_KEY) ?? e.GEMINI_API_KEY ?? e.OPENAI_API_KEY;

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    mongoUri: e.MONGO_URI,
    redisUrl: e.REDIS_URL,
    corsOrigin: e.CORS_ORIGIN.split(',').map((s) => s.trim()),
    trustProxy: e.TRUST_PROXY,
    dashboardApiKey: e.DASHBOARD_API_KEY,
    webhookSecret: e.GITHUB_WEBHOOK_SECRET,
    githubApiUrl: e.GITHUB_API_URL,
    githubToken: e.GITHUB_TOKEN,
    githubAppId: e.GITHUB_APP_ID,
    githubPrivateKey: e.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    llm: {
      provider: e.LLM_PROVIDER,
      apiKey,
      baseUrl: e.LLM_BASE_URL ?? preset.baseUrl,
      model: e.LLM_MODEL ?? preset.model,
      temperature: e.LLM_TEMPERATURE ?? preset.temperature,
      reasoningEffort: e.LLM_REASONING_EFFORT ?? preset.reasoningEffort,
      maxRpm: e.LLM_MAX_RPM ?? preset.maxRpm,
    },
    agent: {
      maxIterations: e.AGENT_MAX_ITERATIONS,
      maxToolCalls: e.AGENT_MAX_TOOL_CALLS,
      tokenBudget: e.AGENT_TOKEN_BUDGET,
      maxToolOutputChars: 12000,
    },
    review: {
      maxFiles: e.MAX_FILES,
      maxDiffChars: e.MAX_DIFF_CHARS,
      minConfidence: e.MIN_CONFIDENCE,
      minSeverity: e.MIN_SEVERITY,
      maxInline: e.MAX_INLINE_COMMENTS,
      postWhenClean: e.POST_WHEN_CLEAN,
      dryRun: e.DRY_RUN,
    },
    worker: { concurrency: e.WORKER_CONCURRENCY, ratePerMin: e.WORKER_RATE_PER_MIN },
  };
}

/** Extra checks that only the worker process needs. */
export function assertWorkerConfig(config) {
  const problems = [];
  const { llm } = config;
  if (!llm.apiKey) {
    problems.push(
      llm.provider === 'gemini'
        ? 'LLM_API_KEY is required. Get a free Gemini key at https://aistudio.google.com/apikey'
        : 'LLM_API_KEY is required for the worker',
    );
  }
  if (llm.provider === 'custom' && (!llm.baseUrl || !llm.model)) problems.push('LLM_PROVIDER=custom needs both LLM_BASE_URL and LLM_MODEL');
  const hasApp = config.githubAppId && config.githubPrivateKey;
  if (!hasApp && !config.githubToken) problems.push('Set GITHUB_TOKEN or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY');
  if (problems.length) throw new Error(`Invalid worker configuration:\n  ${problems.join('\n  ')}`);
}
