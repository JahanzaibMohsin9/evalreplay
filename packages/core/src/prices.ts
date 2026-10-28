import type { LlmStep } from './trace.js';

/** A model's price in USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Input tokens read from the cache. Default: `input`. */
  cachedInput?: number;
  /** Input tokens written to the cache. Default: `input`. */
  cacheWrite?: number;
}

/** Prices by model id, e.g. `{ 'gpt-5.4-mini': { input: 0.25, output: 2 } }`. */
export type Prices = Record<string, ModelPrice>;

type Usage = Pick<
  LlmStep,
  'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens'
>;

/** The cost of one model call. `inputTokens` includes the cached and cache-write tokens. */
export function costOf(price: ModelPrice, usage: Usage): number {
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteInputTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cached - written);
  const total =
    uncached * price.input +
    cached * (price.cachedInput ?? price.input) +
    written * (price.cacheWrite ?? price.input) +
    usage.outputTokens * price.output;
  return total / 1_000_000;
}

// a provider's dated snapshot of a model: gpt-5.4-mini-2026-03-17, claude-x-20260401
const DATE_SUFFIX = /-\d{4}-?\d{2}-?\d{2}$/;

/**
 * The price for a model id, or for the same id without a date suffix, so `gpt-5.4-mini` also
 * prices `gpt-5.4-mini-2026-03-17`. Any other near match is not a price.
 */
export function priceFor(prices: Prices, model: string): ModelPrice | undefined {
  return prices[model] ?? prices[model.replace(DATE_SUFFIX, '')];
}
