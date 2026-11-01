import { z } from 'zod';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const CATEGORIES = ['security', 'bug', 'performance', 'maintainability', 'style', 'testing', 'documentation'];
export const SEVERITY_RANK = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

export const findingSchema = z.object({
  path: z.string().min(1).max(500),
  line: z.number().int().positive(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  confidence: z.number().min(0).max(1),
  title: z.string().min(3).max(120),
  body: z.string().min(5).max(1500),
  suggestion: z.string().max(1500).optional(),
});

export const submissionSchema = z.object({
  summary: z.string().min(1).max(1500),
  findings: z.array(findingSchema).max(40),
});

// NOTE: schemas deliberately avoid `additionalProperties`, empty `properties` and empty `required`:
// Gemini's OpenAI-compatible endpoint validates against a stricter OpenAPI subset. Zod re-validates server-side.
/** Terminal tool: the agent MUST finish by calling this. Doubles as structured output. */
export const SUBMIT_TOOL = {
  type: 'function',
  function: {
    name: 'submit_review',
    description:
      'Submit the final review. Call exactly once when you are done investigating. An empty findings array is valid if the change looks good.',
    parameters: {
      type: 'object',
      required: ['summary', 'findings'],
      properties: {
        summary: { type: 'string', description: '2-4 sentence overview of what the PR does and its overall quality.' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'line', 'severity', 'category', 'confidence', 'title', 'body'],
            properties: {
              path: { type: 'string', description: 'File path exactly as listed in the PR.' },
              line: { type: 'integer', description: 'Line number in the NEW version of the file (left column of the diff).' },
              severity: { type: 'string', enum: SEVERITIES },
              category: { type: 'string', enum: CATEGORIES },
              confidence: { type: 'number', description: '0-1. Probability this is a real, actionable issue.' },
              title: { type: 'string', description: 'Short headline, max 120 chars.' },
              body: { type: 'string', description: 'Why it is a problem and how to fix it.' },
              suggestion: {
                type: 'string',
                description: 'Optional. Exact replacement text for the single line `line` (no code fences).',
              },
            },
          },
        },
      },
    },
  },
};

export function parseSubmission(rawArgs) {
  let json;
  try {
    // some OpenAI-compatible providers return arguments already parsed
    json = typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : JSON.parse(rawArgs || '{}');
  } catch {
    return { ok: false, error: 'arguments were not valid JSON (possibly truncated)' };
  }
  const res = submissionSchema.safeParse(json);
  if (!res.success) {
    const msg = res.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, error: msg };
  }
  return { ok: true, value: res.data };
}
