import { z } from 'zod';

/**
 * The trace format version written into every trace. Adding an optional field keeps it;
 * renaming or removing a field, or changing what one means, bumps it (PLAN.md section 8).
 */
export const TRACE_SCHEMA_VERSION = 1;

// Objects are loose: fields this version doesn't know are kept, so a trace written by a newer
// recorder survives a read and re-write by an older evalreplay.

const count = z.int().nonnegative();
const durationMs = z.number().nonnegative();
const usd = z.number().nonnegative();
const timestamp = z.iso.datetime({ offset: true }).describe('ISO 8601 date-time');

export const ErrorInfoSchema = z
  .looseObject({
    message: z.string(),
    type: z.string().optional().describe('Error class or code, e.g. "TimeoutError"'),
  })
  .describe('An error raised by a tool call or by the run itself');

export const MessageSchema = z
  .looseObject({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z
      .union([z.string(), z.array(z.unknown())])
      .describe('Plain text, or provider-specific content parts'),
    name: z.string().optional(),
    toolCallId: z.string().optional().describe('For role "tool": the call this message answers'),
  })
  .describe('One chat message');

export const ToolCallSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
});

export const LlmStepSchema = z
  .looseObject({
    type: z.literal('llm'),
    startedAt: timestamp.optional(),
    provider: z.string().describe('gen_ai.provider.name, e.g. "openai", "anthropic"'),
    model: z.string().describe('gen_ai.request.model'),
    inputTokens: count.describe('gen_ai.usage.input_tokens'),
    outputTokens: count.describe('gen_ai.usage.output_tokens'),
    cachedInputTokens: count.optional().describe('Input tokens served from the provider cache'),
    costUsd: usd.optional().describe('Omitted when the price of the model is unknown'),
    latencyMs: durationMs,
    finishReason: z.string().optional().describe('gen_ai.response.finish_reasons[0]'),
    output: z
      .looseObject({
        text: z.string().optional(),
        toolCalls: z.array(ToolCallSchema).optional(),
      })
      .optional()
      .describe('What the model returned in this call'),
  })
  .describe('One model call');

export const ToolStepSchema = z
  .looseObject({
    type: z.literal('tool'),
    startedAt: timestamp.optional(),
    name: z.string().describe('gen_ai.tool.name'),
    callId: z
      .string()
      .optional()
      .describe('gen_ai.tool.call.id: links the call to the model output'),
    args: z.record(z.string(), z.unknown()),
    result: z.unknown().optional().describe('The value the tool returned; replay mode returns it'),
    error: ErrorInfoSchema.nullable().optional().describe('Set when the tool threw'),
    latencyMs: durationMs,
  })
  .describe('One tool call');

export const StepSchema = z.discriminatedUnion('type', [LlmStepSchema, ToolStepSchema]);

export const TotalsSchema = z.looseObject({
  costUsd: usd.optional().describe('Omitted when any model call has an unknown cost'),
  latencyMs: durationMs.describe('Wall time of the whole run'),
  steps: count.describe('Must equal steps.length'),
  inputTokens: count.optional(),
  outputTokens: count.optional(),
});

export const TraceSchema = z
  .looseObject({
    schemaVersion: z.literal(TRACE_SCHEMA_VERSION),
    id: z.string().min(1),
    startedAt: timestamp,
    agent: z.looseObject({
      name: z.string().min(1),
      version: z.string().optional().describe('e.g. the git SHA of the agent code'),
    }),
    input: z.looseObject({ messages: z.array(MessageSchema) }),
    steps: z.array(StepSchema),
    output: z.looseObject({
      text: z.string().optional(),
      structured: z.unknown().optional(),
    }),
    totals: TotalsSchema,
    error: ErrorInfoSchema.optional().describe('Set when the run itself failed'),
    metadata: z
      .looseObject({ tags: z.array(z.string()).optional() })
      .optional()
      .describe('Free-form; tags select cases and group reports'),
  })
  .superRefine((trace, ctx) => {
    if (trace.totals.steps !== trace.steps.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['totals', 'steps'],
        message: `totals.steps is ${trace.totals.steps} but the trace has ${trace.steps.length} steps`,
      });
    }
  })
  .describe('One recorded agent run (one line of a .jsonl trace file)');

export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type LlmStep = z.infer<typeof LlmStepSchema>;
export type ToolStep = z.infer<typeof ToolStepSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Totals = z.infer<typeof TotalsSchema>;
export type Trace = z.infer<typeof TraceSchema>;

/**
 * Sums the steps into `totals`. Cost is left out unless every model call has one, so an unknown
 * price never shows up as a cheaper run.
 */
export function computeTotals(steps: readonly Step[], latencyMs: number): Totals {
  const llm = steps.filter((s): s is LlmStep => s.type === 'llm');
  const totals: Totals = {
    latencyMs,
    steps: steps.length,
    inputTokens: llm.reduce((sum, s) => sum + s.inputTokens, 0),
    outputTokens: llm.reduce((sum, s) => sum + s.outputTokens, 0),
  };
  if (llm.every((s) => s.costUsd !== undefined)) {
    totals.costUsd = llm.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  }
  return totals;
}

/** The trace format as JSON Schema (draft 2020-12), for tools outside TypeScript. */
export function traceJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(TraceSchema, { target: 'draft-2020-12', io: 'input' });
}
