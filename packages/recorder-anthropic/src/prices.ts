import type { ModelPrice } from '@evalreplay/core';

/** A Claude price, with the higher price some models charge above a prompt size. */
export interface ClaudePrice extends ModelPrice {
  longPrompt?: { aboveTokens: number; input: number; output: number };
}

/** The date of Anthropic's list prices in CLAUDE_PRICES. */
export const CLAUDE_PRICES_DATE = '2026-10-06';

// USD per million tokens, Anthropic API list prices. A cache read is 0.1x the input price unless
// Anthropic lists its own; cache writes are 1.25x (5-minute cache) and 2x (1-hour cache).
const price = (input: number, output: number, cachedInput = input * 0.1): ClaudePrice => ({
  input,
  output,
  cachedInput,
});

/** Claude list prices on CLAUDE_PRICES_DATE. Pass `prices` to the recorder to override them. */
export const CLAUDE_PRICES: Record<string, ClaudePrice> = {
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-mythos-5-1': price(10, 50, 0.25),
  'claude-fable-5': price(10, 50),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25),
  'claude-opus-4-8': price(5, 25),
  'claude-opus-4-7': price(5, 25),
  'claude-opus-4-6': price(5, 25),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-sonnet-5': price(2, 10),
  'claude-sonnet-4-6': price(3, 15),
  'claude-haiku-5-5': {
    ...price(0.1, 0.5),
    longPrompt: { aboveTokens: 100_000, input: 0.5, output: 2.5 },
  },
  'claude-haiku-4-5': price(1, 5),
};

/** The model id without a platform prefix or version suffix: `anthropic.x`, `x@20251101`, `x-20251101`. */
export function baseModelId(model: string): string {
  return model
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
    .replace(/@.*$/, '')
    .replace(/-\d{8}$/, '');
}

export interface ClaudeUsage {
  /** Input tokens not read from or written to the cache. */
  uncached: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  fast: boolean;
}

/** The cost of one call in USD. */
export function claudeCost(p: ClaudePrice, u: ClaudeUsage): number {
  const prompt = u.uncached + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  const long = p.longPrompt && prompt > p.longPrompt.aboveTokens ? p.longPrompt : undefined;
  const input = long?.input ?? p.input;
  const output = long?.output ?? p.output;
  const cached = long ? input * 0.1 : (p.cachedInput ?? input * 0.1);
  const total =
    u.uncached * input +
    u.cacheRead * cached +
    u.cacheWrite5m * (p.cacheWrite ?? input * 1.25) +
    u.cacheWrite1h * input * 2 +
    u.output * output;
  // fast mode is twice the standard price
  return ((u.fast ? 2 : 1) * total) / 1_000_000;
}
