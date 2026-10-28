import { describe, expect, it } from 'vitest';
import { sampleTrace } from './fixtures.js';
import { type Step, TraceSchema, computeTotals, traceJsonSchema } from './trace.js';

const issues = (value: unknown) => {
  const result = TraceSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('TraceSchema', () => {
  it('accepts a complete trace', () => {
    expect(issues(sampleTrace())).toEqual([]);
  });

  it('accepts a minimal trace: no steps, no output text, no cost', () => {
    const minimal = {
      schemaVersion: 1,
      id: 'run_1',
      startedAt: '2026-10-24T10:00:00+05:00',
      agent: { name: 'demo' },
      input: { messages: [] },
      steps: [],
      output: {},
      totals: { latencyMs: 0, steps: 0 },
    };
    expect(issues(minimal)).toEqual([]);
  });

  it('keeps fields it does not know, at every level', () => {
    const trace = sampleTrace({ futureField: 'kept' } as never);
    (trace.steps[1] as Record<string, unknown>).retries = 2;
    const parsed = TraceSchema.parse(trace) as Record<string, unknown>;
    expect(parsed.futureField).toBe('kept');
    expect((parsed.steps as Record<string, unknown>[])[1]).toMatchObject({ retries: 2 });
  });

  it('rejects a trace without schemaVersion or with another version', () => {
    const { schemaVersion: _, ...unversioned } = sampleTrace();
    expect(issues(unversioned)).toEqual([expect.stringMatching(/^schemaVersion:/)]);
    expect(issues({ ...sampleTrace(), schemaVersion: 2 })).toEqual([
      expect.stringMatching(/^schemaVersion:/),
    ]);
  });

  it('names the failing step field', () => {
    const trace = sampleTrace();
    (trace.steps[0] as Record<string, unknown>).inputTokens = -1;
    expect(issues(trace)).toEqual([expect.stringMatching(/^steps\.0\.inputTokens:/)]);
  });

  it('rejects an unknown step type', () => {
    const trace = sampleTrace();
    (trace.steps[0] as Record<string, unknown>).type = 'retrieval';
    expect(issues(trace)).toEqual([expect.stringMatching(/^steps\.0\.type:/)]);
  });

  it('rejects a timestamp that is not ISO 8601', () => {
    expect(issues({ ...sampleTrace(), startedAt: '24/10/2026 10:00' })).toEqual([
      expect.stringMatching(/^startedAt:/),
    ]);
  });

  it('rejects totals.steps that does not match the steps', () => {
    const trace = sampleTrace();
    trace.totals.steps = 7;
    expect(issues(trace)).toEqual(['totals.steps: totals.steps is 7 but the trace has 2 steps']);
  });
});

describe('computeTotals', () => {
  const llm = (costUsd?: number): Step => ({
    type: 'llm',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    inputTokens: 100,
    outputTokens: 20,
    latencyMs: 500,
    ...(costUsd === undefined ? {} : { costUsd }),
  });
  const tool: Step = { type: 'tool', name: 'lookup', args: {}, latencyMs: 30 };

  it('sums tokens and cost over the model calls', () => {
    expect(computeTotals([llm(0.001), tool, llm(0.002)], 1_200)).toEqual({
      costUsd: 0.003,
      latencyMs: 1_200,
      steps: 3,
      inputTokens: 200,
      outputTokens: 40,
    });
  });

  it('leaves cost out when any model call has none', () => {
    expect(computeTotals([llm(0.001), llm()], 900)).not.toHaveProperty('costUsd');
  });

  it('produces totals the schema accepts', () => {
    const steps = sampleTrace().steps;
    expect(issues(sampleTrace({ totals: computeTotals(steps, 5_400) }))).toEqual([]);
  });
});

describe('traceJsonSchema', () => {
  it('matches the published schema file', async () => {
    // after changing the format on purpose, run `pnpm test:update` and commit the file
    await expect(`${JSON.stringify(traceJsonSchema(), null, 2)}\n`).toMatchFileSnapshot(
      '../schema/trace.schema.json',
    );
  });
});
