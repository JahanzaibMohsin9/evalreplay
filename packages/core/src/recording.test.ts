import { describe, expect, it } from 'vitest';
import { currentRun, createRunContext, withRun } from './context.js';
import { costOf, priceFor } from './prices.js';
import { observeModelCall, stepSink, wrapMethod } from './recording.js';
import type { LlmStep, Step } from './trace.js';

const llm = (overrides: Partial<LlmStep> = {}): LlmStep => ({
  type: 'llm',
  provider: 'openai',
  model: 'm',
  inputTokens: 0,
  outputTokens: 0,
  latencyMs: 1,
  ...overrides,
});

describe('prices', () => {
  it('prices uncached, cached, cache-write and output tokens', () => {
    const price = { input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 };
    const usage = {
      inputTokens: 10_000,
      cachedInputTokens: 6000,
      cacheWriteInputTokens: 1000,
      outputTokens: 500,
    };
    expect(costOf(price, usage)).toBeCloseTo(
      (3000 * 2 + 6000 * 0.2 + 1000 * 2.5 + 500 * 10) / 1e6,
      12,
    );
    expect(costOf({ input: 1, output: 1 }, usage)).toBeCloseTo(10_500 / 1e6, 12);
  });

  it('finds a price by id or by id without a date, and nothing else', () => {
    const prices = {
      'gpt-5.4': { input: 1, output: 1 },
      'gpt-5.4-mini': { input: 0.25, output: 2 },
    };
    expect(priceFor(prices, 'gpt-5.4-mini')?.input).toBe(0.25);
    expect(priceFor(prices, 'gpt-5.4-mini-2026-03-17')?.input).toBe(0.25);
    expect(priceFor(prices, 'gpt-5.4-nano')).toBeUndefined();
  });
});

describe('recording', () => {
  const ctx = (steps: Step[]) =>
    createRunContext({ caseId: 'c', run: 1, signal: new AbortController().signal, steps });

  it('knows the current run, including after an await', async () => {
    const steps: Step[] = [];
    const run = ctx(steps);
    expect(currentRun()).toBeUndefined();
    await withRun(run, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentRun()).toBe(run);
      stepSink()(llm({ model: 'inside' }));
    });
    stepSink()(llm({ model: 'outside' })); // no run: dropped
    expect(steps.map((s) => (s as LlmStep).model)).toEqual(['inside']);
  });

  it('sends a step to the run that made the call, even when it settles later', async () => {
    const steps: Step[] = [];
    let emit: ((s: LlmStep) => void) | undefined;
    withRun(ctx(steps), () => {
      emit = stepSink();
    });
    emit?.(llm());
    expect(steps).toHaveLength(1);
  });

  it('observes a plain promise and keeps a recorder bug away from the agent', async () => {
    const seen: unknown[] = [];
    observeModelCall(Promise.resolve(1), {
      done: (v) => seen.push(v),
      failed: () => seen.push('failed'),
    });
    observeModelCall(Promise.reject(new Error('x')), {
      done: () => {},
      failed: (e) => seen.push((e as Error).message),
    });
    observeModelCall(Promise.resolve(2), {
      done: () => {
        throw new Error('recorder bug');
      },
      failed: () => {},
    });
    await new Promise((r) => setTimeout(r, 1));
    expect(seen).toEqual([1, 'x']);
  });

  it('wraps a method once and skips a missing one', () => {
    const target = { create: (n: number) => n + 1 };
    const calls: unknown[] = [];
    const wrap =
      (original: (...a: unknown[]) => unknown) =>
      (...a: unknown[]) => {
        calls.push(a);
        return original(...a);
      };
    expect(wrapMethod(target, 'create', wrap)).toBe(true);
    expect(wrapMethod(target, 'create', wrap)).toBe(true);
    expect(target.create(1)).toBe(2);
    expect(calls).toHaveLength(1);
    expect(wrapMethod(target, 'missing', wrap)).toBe(false);
    expect(wrapMethod(undefined, 'create', wrap)).toBe(false);
  });
});
