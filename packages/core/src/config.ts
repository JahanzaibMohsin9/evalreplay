import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { z } from 'zod';
import type { RunContext } from './context.js';
import type { Prices } from './prices.js';
import type { Message } from './trace.js';

/** The case input the agent gets: the message list, ending with the user's message. */
export interface AgentInput {
  messages: Message[];
}

/** Text, structured output, or both. */
// void, so an agent that returns nothing (`async () => {}`) type-checks
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export type AgentOutput = string | { text?: string; structured?: unknown } | undefined | void;

/** The function the runner calls once per run of a case. */
export type AgentFn = (input: AgentInput, ctx: RunContext) => AgentOutput | Promise<AgentOutput>;

export interface Config {
  /** Glob patterns for case files. */
  cases: string | string[];
  agent: AgentFn;
  /** Where the traces named by `from_trace` are. Default: `.evalreplay/traces/**\/*.jsonl`. */
  traces?: string | string[];
  /** Agent name written into each trace. Default: `agent`. */
  name?: string;
  /** Agent version written into each trace, e.g. a git SHA. */
  version?: string;
  /** Runs at the same time. Default: 4. */
  concurrency?: number;
  /** A run that takes longer fails with a TimeoutError. Default: 120000 (2 minutes). */
  timeoutMs?: number;
  /** Where `report.json`, `report.md` and `traces.jsonl` go. Default: `.evalreplay/report`. */
  outDir?: string;
  /**
   * USD per million tokens by model id, for model calls a recorder couldn't price (the Anthropic
   * recorder knows Claude's list prices; the OpenAI one knows none).
   */
  prices?: Prices;
}

export const DEFAULTS = {
  traces: '.evalreplay/traces/**/*.jsonl',
  name: 'agent',
  concurrency: 4,
  timeoutMs: 120_000,
  outDir: '.evalreplay/report',
} as const;

const patterns = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const ConfigSchema = z.strictObject({
  cases: patterns,
  agent: z.custom<AgentFn>((v) => typeof v === 'function', 'expected a function'),
  traces: patterns.optional(),
  name: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  concurrency: z.int().min(1).optional(),
  timeoutMs: z.number().positive().optional(),
  outDir: z.string().min(1).optional(),
  prices: z
    .record(
      z.string(),
      z.strictObject({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cachedInput: z.number().nonnegative().optional(),
        cacheWrite: z.number().nonnegative().optional(),
      }),
    )
    .optional(),
});

/** Declares the config in `evalreplay.config.ts`: `export default defineConfig({ ... })`. */
export function defineConfig(config: Config): Config {
  return config;
}

/** A config that is missing or invalid. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Checks a config value, throwing a ConfigError that lists every problem. */
export function validateConfig(raw: unknown, file = 'config'): Config {
  const parsed = ConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map(
    (i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`,
  );
  throw new ConfigError(`${file}: ${problems.join('; ')}`);
}

export const CONFIG_FILES = [
  'evalreplay.config.ts',
  'evalreplay.config.mts',
  'evalreplay.config.js',
  'evalreplay.config.mjs',
];

export interface LoadedConfig {
  config: Config;
  /** The config file's folder: the paths in the config are relative to it. */
  dir: string;
  file: string;
}

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: false });

/** Loads a config file, or the first of CONFIG_FILES in `cwd` when none is given. */
export async function loadConfig(file?: string, cwd = process.cwd()): Promise<LoadedConfig> {
  let path: string | undefined;
  if (file !== undefined) {
    path = resolve(cwd, file);
  } else {
    for (const name of CONFIG_FILES) {
      try {
        await access(resolve(cwd, name));
        path = resolve(cwd, name);
        break;
      } catch {
        // try the next name
      }
    }
    if (path === undefined) {
      throw new ConfigError(`no config file in ${cwd} (expected ${CONFIG_FILES.join(', ')})`);
    }
  }

  let exported: unknown;
  try {
    exported = (await jiti.import<{ default?: unknown }>(path)).default;
  } catch (err) {
    throw new ConfigError(`cannot load ${path}: ${(err as Error).message}`, { cause: err });
  }
  if (exported === undefined) {
    throw new ConfigError(
      `${path}: no default export; use \`export default defineConfig({ ... })\``,
    );
  }
  return { config: validateConfig(exported, path), dir: dirname(path), file: path };
}
