import { currentRun } from './context.js';
import type { LlmStep } from './trace.js';

// Shared by the recorder packages. A recorder wraps an SDK method, watches the promise the SDK
// returns without replacing it (so helpers like `.withResponse()` keep working), and turns the
// response or the streamed events into an LlmStep.

/** Where a recorded step goes: the run that made the call, and `onStep` if given. */
export function stepSink(onStep?: (step: LlmStep) => void): (step: LlmStep) => void {
  const run = currentRun(); // now, while the call is being made inside the run
  return (step) => {
    run?.recordStep(step);
    onStep?.(step);
  };
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // a recorder bug must not break the agent
    process.emitWarning(`evalreplay recorder: ${(err as Error).message}`);
  }
}

export interface StreamHooks<E> {
  event(event: E): void;
  /** Called once: when the stream finishes, fails, or the reader stops early. */
  end(error?: unknown): void;
}

export interface CallHooks<T> {
  done(value: T): void;
  failed(error: unknown): void;
  /** For a streamed response: hooks for its events, or undefined when `value` is not a stream. */
  stream?(value: T): StreamHooks<unknown> | undefined;
}

/** Observes the events of an async iterable as its reader takes them. */
function observeStream(stream: object, hooks: StreamHooks<unknown>): void {
  const target = stream as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> };
  const original = target[Symbol.asyncIterator].bind(target);
  let ended = false;
  const end = (error?: unknown) => {
    if (ended) return;
    ended = true;
    safely(() => hooks.end(error));
  };
  target[Symbol.asyncIterator] = () => {
    const it = original();
    const wrapped: AsyncIterableIterator<unknown> = {
      async next() {
        try {
          const r = await it.next();
          if (r.done) end();
          else safely(() => hooks.event(r.value));
          return r;
        } catch (err) {
          end(err);
          throw err;
        }
      },
      async return(value?: unknown) {
        end();
        return it.return ? it.return(value) : { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return wrapped;
      },
    };
    return wrapped;
  };
}

/** The two fields of the SDKs' APIPromise this relies on (OpenAI's and Anthropic's alike). */
interface ApiPromiseLike {
  responsePromise: PromiseLike<unknown>;
  parseResponse: (...args: unknown[]) => unknown;
  _thenUnwrap?: (transform: (data: unknown, props: unknown) => unknown) => unknown;
}

const isApiPromise = (v: unknown): v is ApiPromiseLike =>
  typeof (v as ApiPromiseLike).parseResponse === 'function' &&
  typeof (v as ApiPromiseLike).responsePromise?.then === 'function';

/** Calls the hooks when a model call settles, or as its stream is read. */
export function observeModelCall<T>(call: PromiseLike<T>, hooks: CallHooks<T>): void {
  let settled = false;
  const done = (value: T) => {
    if (settled) return;
    settled = true;
    const stream = hooks.stream?.(value);
    if (stream) observeStream(value as object, stream);
    else safely(() => hooks.done(value));
  };
  const failed = (err: unknown) => {
    if (settled) return;
    settled = true;
    safely(() => hooks.failed(err));
  };

  if (!isApiPromise(call)) {
    call.then(done, failed);
    return;
  }
  // An SDK APIPromise parses the HTTP body when its caller awaits it, and helpers such as
  // `parse()` derive a second promise that parses the body itself. Awaiting it here would read
  // the body first and break them, so watch the parse step instead, whoever triggers it.
  const parse = call.parseResponse;
  call.parseResponse = async (...args: unknown[]) => {
    try {
      const value = (await parse.apply(call, args)) as T;
      done(value);
      return value;
    } catch (err) {
      failed(err);
      throw err;
    }
  };
  // some SDK versions give the derived promise its own copy of the parser, so watch the value
  // it hands to the helper's transform as well
  const unwrap = call._thenUnwrap;
  if (typeof unwrap === 'function') {
    call._thenUnwrap = (transform) =>
      unwrap.call(call, (data, props) => {
        done(data as T);
        return transform(data, props);
      });
  }
  call.responsePromise.then(undefined, failed); // a request error, before any parsing
}

const WRAPPED = Symbol.for('evalreplay.recorder.wrapped');

type Method = (...args: unknown[]) => unknown;

/**
 * Replaces `target[name]` with `wrap(original, self)`, once: wrapping a client twice records each
 * call once. `self` is the object the method is called on. With `prototype`, `target` is a class
 * prototype and every instance's calls go through the wrapper. Returns false when the method is
 * missing.
 */
export function wrapMethod(
  target: object | undefined,
  name: string,
  wrap: (original: Method, self: object) => Method,
  options: { prototype?: boolean } = {},
): boolean {
  const t = target as Record<string, unknown> | undefined;
  const original = t?.[name];
  if (typeof original !== 'function' || !t) return false;
  if ((original as { [WRAPPED]?: true })[WRAPPED]) return true;
  const wrapped: Method = options.prototype
    ? function (this: object, ...args: unknown[]) {
        return wrap((original as Method).bind(this), this)(...args);
      }
    : wrap(original.bind(t) as Method, t);
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  t[name] = wrapped;
  return true;
}

/** Milliseconds since `start` (from `performance.now()`), to the microsecond. */
export const msSince = (start: number) => Math.round((performance.now() - start) * 1000) / 1000;
