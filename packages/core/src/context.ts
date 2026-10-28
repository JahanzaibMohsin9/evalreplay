import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { ErrorInfo, Step, ToolStep, Trace } from './trace.js';

/** Any function: tools take whatever arguments the agent passes. */
export type ToolFn = (...args: never[]) => unknown;

/** What the agent gets for one run of one case. */
export interface RunContext {
  readonly caseId: string;
  /** 1-based run number, up to the case's `runs`. */
  readonly run: number;
  /** In `replay`, wrapped tools return the results recorded in the case's `from_trace`. */
  readonly mode: 'replay' | 'live';
  /** Aborted when the run times out. */
  readonly signal: AbortSignal;
  /** Wraps every function in a `name → tool` object; see `wrapTool`. */
  wrapTools<T extends Record<string, ToolFn>>(tools: T): T;
  /**
   * Wraps one tool so each call is recorded as a tool step. A tool that takes one object
   * records it as the arguments; any other call records `{ arguments: [...] }`.
   */
  wrapTool<F extends ToolFn>(name: string, fn: F): F;
  /**
   * Records one tool call, for agents that dispatch tools by name. `call` runs the tool in live
   * mode; in replay mode it is skipped and the recorded result is returned instead.
   */
  callTool<R>(name: string, args: Record<string, unknown>, call: () => R): R;
  /** Adds a step to the trace; recorders use it for model calls. */
  recordStep(step: Step): void;
}

/** A tool call in replay mode that the recorded trace has no result for. */
export class ReplayMissError extends Error {
  override readonly name = 'ReplayMissError';
}

/** A JSON copy, so the trace keeps what was passed even if the agent changes it later. */
function jsonCopy(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    return { unserializable: (err as Error).message };
  }
}

export function errorInfo(err: unknown): ErrorInfo {
  if (err instanceof Error) {
    return err.name && err.name !== 'Error'
      ? { message: err.message, type: err.name }
      : { message: err.message };
  }
  return { message: String(err) };
}

function errorFrom(info: ErrorInfo): Error {
  const err = new Error(info.message);
  if (info.type) err.name = info.type;
  return err;
}

const isPromiseLike = (v: unknown): v is PromiseLike<unknown> =>
  typeof (v as { then?: unknown } | null)?.then === 'function';

const elapsed = (since: number) => Math.round((performance.now() - since) * 1000) / 1000;

/**
 * The tool results of a recorded trace. A call gets the first unused recorded call to the same
 * tool with equal arguments, or else the next unused call to that tool: a model may word its
 * arguments a little differently from one run to the next.
 */
export class ToolReplay {
  private readonly calls: { step: ToolStep; used: boolean }[];

  constructor(readonly trace: Trace) {
    this.calls = trace.steps.flatMap((step) =>
      step.type === 'tool' ? [{ step, used: false }] : [],
    );
  }

  take(name: string, args: unknown): ToolStep {
    const unused = this.calls.filter((c) => !c.used && c.step.name === name);
    const hit = unused.find((c) => isDeepStrictEqual(c.step.args, args)) ?? unused[0];
    if (!hit) {
      const recorded = this.calls.filter((c) => c.step.name === name).length;
      throw new ReplayMissError(
        recorded
          ? `no recorded result left for ${name}: trace ${this.trace.id} calls it ${recorded === 1 ? 'once' : `${recorded} times`}, and every call has been replayed`
          : `no recorded result for ${name}: trace ${this.trace.id} never calls it`,
      );
    }
    hit.used = true;
    return hit.step;
  }
}

export interface ContextOptions {
  caseId: string;
  run: number;
  signal: AbortSignal;
  /** Steps are appended here as they start. */
  steps: Step[];
  /** Set in replay mode. */
  replay?: ToolReplay;
}

export function createRunContext(o: ContextOptions): RunContext {
  const callTool = <R>(name: string, args: Record<string, unknown>, call: () => R): R => {
    const step: ToolStep = {
      type: 'tool',
      startedAt: new Date().toISOString(),
      name,
      args: (jsonCopy(args) ?? {}) as Record<string, unknown>,
      latencyMs: 0,
    };
    o.steps.push(step); // at the start, so steps stay in call order
    const t0 = performance.now();
    const done = (result: unknown) => {
      step.latencyMs = elapsed(t0);
      step.result = jsonCopy(result);
      step.error = null;
      return result;
    };
    const failed = (err: unknown): never => {
      step.latencyMs = elapsed(t0);
      step.error = errorInfo(err);
      throw err;
    };

    if (o.replay) {
      step.replayed = true;
      let recorded: ToolStep;
      try {
        recorded = o.replay.take(name, step.args);
      } catch (err) {
        return failed(err);
      }
      if (recorded.error) return failed(errorFrom(recorded.error));
      // returned directly, not as a promise: `await` works on both
      return done(structuredClone(recorded.result)) as R;
    }

    let out: R;
    try {
      out = call();
    } catch (err) {
      return failed(err);
    }
    // a sync tool stays sync, so wrapping it doesn't change the agent's code
    return (isPromiseLike(out) ? Promise.resolve(out).then(done, failed) : done(out)) as R;
  };

  const wrapTool = <F extends ToolFn>(name: string, fn: F): F =>
    function (this: unknown, ...args: unknown[]) {
      const [first] = args;
      const recorded =
        args.length === 0
          ? {}
          : args.length === 1 &&
              typeof first === 'object' &&
              first !== null &&
              !Array.isArray(first)
            ? (first as Record<string, unknown>)
            : { arguments: args };
      return callTool(name, recorded, () =>
        (fn as unknown as (...a: unknown[]) => unknown).apply(this, args),
      );
    } as unknown as F;

  return {
    caseId: o.caseId,
    run: o.run,
    mode: o.replay ? 'replay' : 'live',
    signal: o.signal,
    callTool,
    wrapTool,
    wrapTools: <T extends Record<string, ToolFn>>(tools: T) =>
      Object.fromEntries(
        Object.entries(tools).map(([name, fn]) => [name, wrapTool(name, fn)]),
      ) as T,
    recordStep: (step) => {
      o.steps.push(structuredClone(step));
    },
  };
}
