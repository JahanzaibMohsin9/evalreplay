import { describe, expect, it } from 'vitest';
import { evaluateAssertion, evaluateCase } from './assert.js';
import type { Assertion, Case } from './cases.js';
import { sampleTrace } from './fixtures.js';
import { computeTotals, type Step, type Trace } from './trace.js';

const llm = (overrides: Partial<Extract<Step, { type: 'llm' }>> = {}): Step => ({
  type: 'llm',
  provider: 'openai',
  model: 'gpt-4.1-mini',
  inputTokens: 500,
  outputTokens: 50,
  costUsd: 0.001,
  latencyMs: 800,
  ...overrides,
});

const tool = (name: string, overrides: Partial<Extract<Step, { type: 'tool' }>> = {}): Step => ({
  type: 'tool',
  name,
  args: {},
  latencyMs: 100,
  ...overrides,
});

/** A trace with these steps and totals computed from them. */
function traceWith(steps: Step[], overrides: Partial<Trace> = {}): Trace {
  return sampleTrace({ steps, totals: computeTotals(steps, 3000), ...overrides });
}

// llm, compare_routes, llm, get_fx, compare_routes, llm
const PAYMENT = traceWith([
  llm(),
  tool('compare_routes', { args: { amount: 1200, currency: 'EUR' } }),
  llm(),
  tool('get_fx', { args: { from: 'PKR', to: 'EUR' } }),
  tool('compare_routes', { args: { amount: 1200, currency: 'GBP' } }),
  llm({ costUsd: 0.004, latencyMs: 1900 }),
]);

const run = (a: Assertion, trace: Trace = PAYMENT) => evaluateAssertion(a, trace);

describe('tool_called', () => {
  it('passes and lists the steps', async () => {
    expect(await run({ kind: 'tool_called', tool: 'compare_routes' })).toMatchObject({
      label: 'tool_called: compare_routes',
      pass: true,
      message: 'compare_routes was called 2 times (steps 2, 5)',
    });
  });

  it('fails when the tool was never called, naming the tools that were', async () => {
    expect(await run({ kind: 'tool_called', tool: 'execute_payment' })).toEqual({
      assertion: { kind: 'tool_called', tool: 'execute_payment' },
      label: 'tool_called: execute_payment',
      pass: false,
      message: 'execute_payment was never called (tools called: compare_routes, get_fx)',
    });
    expect((await run({ kind: 'tool_called', tool: 'x' }, traceWith([llm()]))).message).toBe(
      'x was never called (no tools were called)',
    );
  });

  it('checks times, pointing at the first extra call', async () => {
    expect(await run({ kind: 'tool_called', tool: 'compare_routes', times: 1 })).toMatchObject({
      label: 'tool_called: compare_routes (once)',
      pass: false,
      message: 'compare_routes was called 2 times (steps 2, 5), expected once',
      stepIndex: 4,
    });
    const tooFew = await run({ kind: 'tool_called', tool: 'get_fx', times: 3 });
    expect(tooFew).toMatchObject({
      pass: false,
      message: 'get_fx was called once (step 4), expected 3 times',
    });
    expect(tooFew.stepIndex).toBeUndefined();
    expect((await run({ kind: 'tool_called', tool: 'compare_routes', times: 2 })).pass).toBe(true);
  });

  it('counts tool steps, not tool calls the model only proposed', async () => {
    const proposed = traceWith([
      llm({ output: { toolCalls: [{ name: 'execute_payment', args: {} }] } }),
    ]);
    expect((await run({ kind: 'tool_called', tool: 'execute_payment' }, proposed)).pass).toBe(
      false,
    );
  });
});

describe('tool_not_called', () => {
  it('passes when the tool never ran', async () => {
    expect(await run({ kind: 'tool_not_called', tool: 'execute_payment' })).toMatchObject({
      pass: true,
      message: 'execute_payment was never called',
    });
  });

  it('fails at the first call', async () => {
    expect(await run({ kind: 'tool_not_called', tool: 'compare_routes' })).toMatchObject({
      pass: false,
      message: 'compare_routes was called 2 times (steps 2, 5)',
      stepIndex: 1,
    });
  });
});

describe('tool_order', () => {
  it('passes with other calls in between', async () => {
    expect(
      await run({ kind: 'tool_order', tools: ['compare_routes', 'get_fx', 'compare_routes'] }),
    ).toMatchObject({
      label: 'tool_order: compare_routes → get_fx → compare_routes',
      pass: true,
      message: 'called in order at steps 2, 4, 5',
    });
  });

  it('fails when a tool came only before the one it should follow', async () => {
    const trace = traceWith([tool('get_fx'), tool('compare_routes')]);
    expect(
      await run({ kind: 'tool_order', tools: ['compare_routes', 'get_fx'] }, trace),
    ).toMatchObject({
      pass: false,
      message: 'get_fx was not called after compare_routes (step 2); it was called at step 1',
      stepIndex: 0,
    });
  });

  it('fails when a tool was never called', async () => {
    expect(
      await run({ kind: 'tool_order', tools: ['compare_routes', 'execute_payment'] }),
    ).toMatchObject({
      pass: false,
      message: 'execute_payment was never called (tools called: compare_routes, get_fx)',
    });
  });
});

describe('tool_args_match', () => {
  const schema = {
    type: 'object',
    required: ['amount', 'currency'],
    properties: { amount: { type: 'number' }, currency: { enum: ['EUR', 'USD'] } },
  };

  it('passes when every call is valid', async () => {
    const trace = traceWith([tool('compare_routes', { args: { amount: 5, currency: 'USD' } })]);
    expect(
      await run({ kind: 'tool_args_match', tool: 'compare_routes', schema }, trace),
    ).toMatchObject({
      pass: true,
      message: 'arguments valid in the call (step 1)',
    });
  });

  it('fails at the first invalid call and names the others', async () => {
    const trace = traceWith([
      tool('compare_routes', { args: { amount: 5, currency: 'USD' } }),
      tool('compare_routes', { args: { amount: '5', currency: 'GBP' } }),
      tool('compare_routes', { args: {} }),
    ]);
    expect(
      await run({ kind: 'tool_args_match', tool: 'compare_routes', schema }, trace),
    ).toMatchObject({
      pass: false,
      message:
        'step 2: args/amount must be number; args/currency must be equal to one of the allowed values: ["EUR","USD"] (also invalid: step 3)',
      stepIndex: 1,
    });
  });

  it('fails when the tool was never called', async () => {
    expect(await run({ kind: 'tool_args_match', tool: 'execute_payment', schema })).toMatchObject({
      pass: false,
      message: 'execute_payment was never called, so it has no arguments to check',
    });
  });

  it('knows formats and older drafts', async () => {
    const trace = traceWith([tool('notify', { args: { email: 'not-an-email' } })]);
    const draft7 = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
    };
    expect(
      await run({ kind: 'tool_args_match', tool: 'notify', schema: draft7 }, trace),
    ).toMatchObject({
      pass: false,
      message: 'step 1: args/email must match format "email"',
    });
  });

  it('reports a schema it cannot compile instead of throwing', async () => {
    const result = await run({ kind: 'tool_args_match', tool: 'get_fx', schema: { type: 'nope' } });
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/^could not check: /);
  });
});

describe('output_contains and output_matches', () => {
  const text = sampleTrace().output.text;

  it('checks every text', async () => {
    expect(
      await run({ kind: 'output_contains', texts: ['bank transfer', 'approval'] }),
    ).toMatchObject({
      pass: true,
      message: 'output contains "bank transfer", "approval"',
    });
    expect(
      await run({ kind: 'output_contains', texts: ['approval', 'IBAN', 'fee'] }),
    ).toMatchObject({
      pass: false,
      message: `output does not contain "IBAN", "fee"; output: ${JSON.stringify(text)}`,
    });
  });

  it('is case-sensitive', async () => {
    expect((await run({ kind: 'output_contains', texts: ['APPROVAL'] })).pass).toBe(false);
  });

  it('shortens long output', async () => {
    const trace = traceWith([], { output: { text: 'x'.repeat(500) } });
    const { message } = await run({ kind: 'output_contains', texts: ['y'] }, trace);
    expect(message).toBe(`output does not contain "y"; output: "${'x'.repeat(120)}…"`);
  });

  it('matches a regular expression with flags', async () => {
    expect(
      await run({ kind: 'output_matches', pattern: 'BANK\\s+\\w+', flags: 'i' }),
    ).toMatchObject({
      label: 'output_matches: /BANK\\s+\\w+/i',
      pass: true,
      message: 'output matches at "bank transfer"',
    });
    expect((await run({ kind: 'output_matches', pattern: '^Sent' })).pass).toBe(false);
  });

  it('fails when there is no text output, and says why the run failed', async () => {
    const trace = traceWith([], {
      output: {},
      error: { message: 'rate limited', type: 'RateLimitError' },
    });
    expect(await run({ kind: 'output_contains', texts: ['a'] }, trace)).toMatchObject({
      pass: false,
      message: 'the run has no text output (the run failed: rate limited)',
    });
    expect((await run({ kind: 'output_matches', pattern: '.' }, trace)).message).toBe(
      'the run has no text output (the run failed: rate limited)',
    );
  });
});

describe('output_schema', () => {
  const schema = {
    type: 'object',
    required: ['route', 'feeEur'],
    properties: { route: { type: 'string' }, feeEur: { type: 'number', minimum: 0 } },
    additionalProperties: false,
  };

  it('validates the structured output', async () => {
    const good = traceWith([], { output: { structured: { route: 'bank', feeEur: 4.5 } } });
    expect(await run({ kind: 'output_schema', schema }, good)).toMatchObject({
      pass: true,
      message: 'structured output is valid',
    });
    const bad = traceWith([], { output: { structured: { route: 'bank', feeEur: -1, extra: 1 } } });
    expect(await run({ kind: 'output_schema', schema }, bad)).toMatchObject({
      pass: false,
      message: 'output must NOT have additional properties (extra); output/feeEur must be >= 0',
    });
  });

  it('falls back to text output parsed as JSON', async () => {
    const json = traceWith([], { output: { text: '{"route":"bank","feeEur":0}' } });
    expect(await run({ kind: 'output_schema', schema }, json)).toMatchObject({
      pass: true,
      message: 'text output, parsed as JSON, is valid',
    });
    expect(await run({ kind: 'output_schema', schema })).toMatchObject({
      pass: false,
      message: expect.stringMatching(
        /^the run has no structured output and its text is not JSON: "The cheapest/,
      ),
    });
  });
});

describe('limits', () => {
  it('max_cost_usd compares the total and names the most expensive step', async () => {
    expect(await run({ kind: 'max_cost_usd', max: 0.25 })).toMatchObject({
      label: 'max_cost_usd: 0.25',
      pass: true,
      message: 'cost $0.006 (limit $0.25)',
    });
    expect(await run({ kind: 'max_cost_usd', max: 0.005 })).toMatchObject({
      pass: false,
      message: 'cost $0.006, over the $0.005 limit; most expensive: step 6 (gpt-4.1-mini, $0.004)',
      stepIndex: 5,
    });
  });

  it('max_cost_usd fails when the cost is unknown, never treating it as free', async () => {
    const trace = traceWith([llm(), llm({ costUsd: undefined, model: 'local-llama' })]);
    expect(await run({ kind: 'max_cost_usd', max: 100 }, trace)).toMatchObject({
      pass: false,
      message: 'the cost is unknown: step 2 (local-llama) has no price',
      stepIndex: 1,
    });
  });

  it('max_latency_ms names the slowest step', async () => {
    expect((await run({ kind: 'max_latency_ms', max: 3000 })).pass).toBe(true);
    expect(await run({ kind: 'max_latency_ms', max: 2500 })).toMatchObject({
      pass: false,
      message: 'took 3000 ms, over the 2500 ms limit; slowest: step 6 (gpt-4.1-mini, 1900 ms)',
      stepIndex: 5,
    });
  });

  it('max_steps points at the first step over the limit', async () => {
    expect(await run({ kind: 'max_steps', max: 6 })).toMatchObject({
      pass: true,
      message: '6 steps (limit 6)',
    });
    expect(await run({ kind: 'max_steps', max: 4 })).toMatchObject({
      pass: false,
      message: '6 steps, over the limit of 4',
      stepIndex: 4,
    });
  });
});

describe('no_tool_errors', () => {
  it('passes when no call threw', async () => {
    expect(await run({ kind: 'no_tool_errors' })).toMatchObject({
      pass: true,
      message: 'no tool call threw (3 calls)',
    });
  });

  it('fails at the first error and lists the rest', async () => {
    const trace = traceWith([
      tool('get_fx', { error: null }),
      tool('compare_routes', { error: { type: 'TimeoutError', message: 'no answer in 10 s' } }),
      tool('get_fx', { error: { message: 'bad currency' } }),
    ]);
    expect(await run({ kind: 'no_tool_errors' }, trace)).toMatchObject({
      pass: false,
      message:
        'step 2 (compare_routes) threw TimeoutError: no answer in 10 s (also failed: step 3)',
      stepIndex: 1,
    });
  });
});

describe('custom', () => {
  const custom = (check: (trace: Trace) => unknown): Assertion => ({
    kind: 'custom',
    name: 'mentions a fee',
    check: check as never,
  });

  it('passes on true and fails with the returned message', async () => {
    expect(await run(custom(() => true))).toMatchObject({
      label: 'custom: mentions a fee',
      pass: true,
    });
    expect(await run(custom(async () => 'the answer never mentions a fee'))).toMatchObject({
      pass: false,
      message: 'the answer never mentions a fee',
    });
    expect((await run(custom(() => false))).message).toBe('check returned false');
  });

  it('reports a check that throws or returns something else', async () => {
    expect(
      (
        await run(
          custom(() => {
            throw new Error('boom');
          }),
        )
      ).message,
    ).toBe('check threw: boom');
    expect((await run(custom(() => 1))).message).toBe(
      'check returned number; return true, false or a message',
    );
  });

  it('gets a copy of the trace', async () => {
    const trace = traceWith([tool('get_fx')]);
    await run(
      custom((t) => {
        t.steps.length = 0;
        return true;
      }),
      trace,
    );
    expect(trace.steps).toHaveLength(1);
  });
});

describe('evaluateCase', () => {
  const payCase: Case = {
    id: 'pay-tuition-eur',
    tags: [],
    input: { messages: [{ role: 'user', content: 'Pay' }] },
    mode: 'live',
    runs: 1,
    vars: {},
    file: '/cases/pay.yaml',
    assert: [
      { kind: 'tool_called', tool: 'compare_routes' },
      { kind: 'tool_not_called', tool: 'execute_payment' },
      { kind: 'max_steps', max: 4 },
    ],
  };

  it('returns one result per assertion, in order', async () => {
    const result = await evaluateCase(payCase, PAYMENT);
    expect(result.caseId).toBe('pay-tuition-eur');
    expect(result.traceId).toBe(PAYMENT.id);
    expect(result.pass).toBe(false);
    expect(result.results.map((r) => [r.label, r.pass])).toEqual([
      ['tool_called: compare_routes', true],
      ['tool_not_called: execute_payment', true],
      ['max_steps: 4', false],
    ]);
    expect(result.runError).toBeUndefined();
  });

  it('fails when the run itself failed, even if every assertion passed', async () => {
    const error = { message: 'context length exceeded' };
    const trace = traceWith([tool('compare_routes')], { error });
    const result = await evaluateCase(payCase, trace);
    expect(result.results.every((r) => r.pass)).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.runError).toEqual(error);
  });
});
