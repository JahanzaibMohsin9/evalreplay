import type { Trace } from './trace.js';

/** A small, valid trace modelled on CarryPay's tuition payment: one model call, one tool call. */
export function sampleTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    schemaVersion: 1,
    id: 'run_01JB3K6Z0Q8N4V7X2C5M9T1R6D',
    startedAt: '2026-10-24T10:00:00Z',
    agent: { name: 'carrypay', version: '3be9d34' },
    input: {
      messages: [{ role: 'user', content: "Pay my son's tuition invoice to TU Munich" }],
    },
    steps: [
      {
        type: 'llm',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        inputTokens: 812,
        outputTokens: 140,
        costUsd: 0.0012,
        latencyMs: 900,
        output: {
          toolCalls: [
            { id: 'call_1', name: 'compare_routes', args: { amount: 1200, currency: 'EUR' } },
          ],
        },
      },
      {
        type: 'tool',
        name: 'compare_routes',
        callId: 'call_1',
        args: { amount: 1200, currency: 'EUR' },
        result: { cheapest: 'bank_transfer', feeEur: 4.5 },
        error: null,
        latencyMs: 340,
      },
    ],
    output: { text: 'The cheapest route is a bank transfer. It needs your approval.' },
    totals: { costUsd: 0.0012, latencyMs: 5400, steps: 2, inputTokens: 812, outputTokens: 140 },
    metadata: { tags: ['payments'] },
    ...overrides,
  };
}
