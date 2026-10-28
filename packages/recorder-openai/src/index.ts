import {
  type LlmStep,
  type Prices,
  type ToolCall,
  costOf,
  errorInfo,
  msSince,
  observeModelCall,
  priceFor,
  stepSink,
  wrapMethod,
} from '@evalreplay/core';
import type OpenAI from 'openai';

export interface RecordOpenAIOptions {
  /**
   * USD per million tokens by model id. evalreplay ships no OpenAI prices: without one, a call's
   * cost is unknown unless the evalreplay config has a price for it.
   */
  prices?: Prices;
  /** gen_ai.provider.name for the steps. Default: from the client's base URL, e.g. `deepseek`. */
  provider?: string;
  /** Also called with every step, inside a run or not, e.g. to log calls. */
  onStep?: (step: LlmStep) => void;
}

type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type Response = OpenAI.Responses.Response;
type ResponseEvent = OpenAI.Responses.ResponseStreamEvent;
type Base = Pick<LlmStep, 'type' | 'startedAt' | 'provider'>;

/** `openai` for api.openai.com, otherwise the host's name: api.deepseek.com → `deepseek`. */
export function providerOf(baseURL: string | undefined): string {
  let host: string;
  try {
    host = new URL(baseURL ?? 'https://api.openai.com/v1').hostname;
  } catch {
    return 'openai';
  }
  if (host === 'localhost' || /^[\d.]+$|:/.test(host)) return 'local'; // e.g. a local model server
  const parts = host.split('.').filter((p) => p !== 'api' && p !== 'www');
  return parts.length > 1 ? (parts.at(-2) ?? host) : (parts[0] ?? host);
}

/** Tool arguments arrive as a JSON string; a model can send invalid JSON. */
function parseArgs(json: string | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  } catch {
    return { invalidJson: json };
  }
}

interface Tokens {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}

function step(
  base: Base,
  model: string,
  tokens: Tokens | undefined,
  latencyMs: number,
  prices: Prices,
  rest: Pick<LlmStep, 'finishReason' | 'output'>,
): LlmStep {
  const t = tokens ?? { input: 0, output: 0, cached: 0, cacheWrite: 0 };
  const usage = {
    inputTokens: t.input,
    outputTokens: t.output,
    ...(t.cached ? { cachedInputTokens: t.cached } : {}),
    ...(t.cacheWrite ? { cacheWriteInputTokens: t.cacheWrite } : {}),
  };
  const price = tokens && priceFor(prices, model);
  return {
    ...base,
    model,
    ...usage,
    ...(price ? { costUsd: costOf(price, usage) } : {}),
    latencyMs,
    ...(rest.finishReason ? { finishReason: rest.finishReason } : {}),
    ...(rest.output ? { output: rest.output } : {}),
    // a stream without stream_options.include_usage reports no tokens: the cost stays unknown
    ...(tokens ? {} : { usageMissing: true }),
  };
}

const output = (text: string | undefined, toolCalls: ToolCall[]): LlmStep['output'] => ({
  ...(text ? { text } : {}),
  ...(toolCalls.length ? { toolCalls } : {}),
});

function chatTokens(u: ChatCompletion['usage'] | null | undefined): Tokens | undefined {
  if (!u) return undefined;
  const details = u.prompt_tokens_details;
  return {
    input: u.prompt_tokens,
    output: u.completion_tokens,
    // DeepSeek reports cache hits in its own field
    cached:
      details?.cached_tokens ??
      (u as { prompt_cache_hit_tokens?: number }).prompt_cache_hit_tokens ??
      0,
    cacheWrite: details?.cache_write_tokens ?? 0,
  };
}

function fromChat(c: ChatCompletion, base: Base, ms: number, prices: Prices): LlmStep {
  const choice = c.choices[0];
  const toolCalls = (choice?.message.tool_calls ?? []).flatMap((call): ToolCall[] =>
    call.type === 'function'
      ? [{ id: call.id, name: call.function.name, args: parseArgs(call.function.arguments) }]
      : [],
  );
  return step(base, c.model, chatTokens(c.usage), ms, prices, {
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    output: output(choice?.message.content ?? undefined, toolCalls),
  });
}

function fromResponse(r: Response, base: Base, ms: number, prices: Prices): LlmStep {
  const items = r.output ?? [];
  const text = items
    .flatMap((item) => (item.type === 'message' ? item.content : []))
    .map((part) => (part.type === 'output_text' ? part.text : ''))
    .join('');
  const toolCalls = items.flatMap((item): ToolCall[] =>
    item.type === 'function_call'
      ? [{ id: item.call_id, name: item.name, args: parseArgs(item.arguments) }]
      : [],
  );
  const u = r.usage;
  const tokens = u
    ? {
        input: u.input_tokens,
        output: u.output_tokens,
        cached: u.input_tokens_details?.cached_tokens ?? 0,
        cacheWrite: u.input_tokens_details?.cache_write_tokens ?? 0,
      }
    : undefined;
  const finishReason =
    r.status === 'incomplete' ? (r.incomplete_details?.reason ?? 'incomplete') : r.status;
  return step(base, r.model, tokens, ms, prices, {
    ...(finishReason ? { finishReason } : {}),
    output: output(text || undefined, toolCalls),
  });
}

/** Puts a chat completion together from its chunks. */
class StreamedChat {
  model: string;
  usage: ChatCompletion['usage'] | null = null;
  finish?: string;
  text = '';
  private readonly calls = new Map<number, { id?: string; name: string; args: string }>();

  constructor(requestModel: string) {
    this.model = requestModel;
  }

  add(chunk: ChatChunk) {
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices.find((c) => c.index === 0);
    if (!choice) return;
    if (choice.finish_reason) this.finish = choice.finish_reason;
    this.text += choice.delta.content ?? '';
    for (const d of choice.delta.tool_calls ?? []) {
      const call = this.calls.get(d.index) ?? { name: '', args: '' };
      if (d.id) call.id = d.id;
      call.name += d.function?.name ?? '';
      call.args += d.function?.arguments ?? '';
      this.calls.set(d.index, call);
    }
  }

  step(base: Base, ms: number, prices: Prices): LlmStep {
    const toolCalls = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => ({ ...(c.id ? { id: c.id } : {}), name: c.name, args: parseArgs(c.args) }));
    return step(base, this.model, chatTokens(this.usage), ms, prices, {
      ...(this.finish ? { finishReason: this.finish } : {}),
      output: output(this.text || undefined, toolCalls),
    });
  }
}

const isStream = (v: unknown): boolean =>
  typeof (v as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] === 'function';

/**
 * Records every call the client makes to `chat.completions.create` and `responses.create`, which
 * `parse()`, `stream()` and `runTools()` also go through. Works with OpenAI-compatible providers
 * (a client with a `baseURL`). Inside an evalreplay run each call becomes a model step of the
 * run's trace; outside one, only `onStep` sees it. Returns the same client, so wrap it where you
 * create it: `recordOpenAI(new OpenAI())`.
 *
 * Pass the `OpenAI` class instead to record every client it creates, for code that creates its
 * clients where you can't wrap them: `recordOpenAI(OpenAI)`.
 */
export function recordOpenAI<C extends object>(client: C, options: RecordOpenAIOptions = {}): C {
  const prices = options.prices ?? {};
  type Resources = { chat?: { completions?: object }; responses?: object };
  type Classes = {
    Chat?: { Completions?: { prototype: object } };
    Responses?: { prototype: object };
  };
  const prototype = typeof client === 'function';

  const record =
    (kind: 'chat' | 'responses') =>
    (create: (...args: unknown[]) => unknown, self: object) =>
    (...args: unknown[]) => {
      // a resource knows its client, whose base URL names the provider
      const provider =
        options.provider ??
        providerOf((self as { _client?: { baseURL?: string } })._client?.baseURL);
      const model = String((args[0] as { model?: unknown } | undefined)?.model ?? 'unknown');
      const emit = stepSink(options.onStep);
      const base: Base = { type: 'llm', startedAt: new Date().toISOString(), provider };
      const t0 = performance.now();
      const call = create(...args) as PromiseLike<unknown>;
      const failed = (err: unknown): LlmStep => ({
        ...base,
        model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0, // a failed request isn't billed
        latencyMs: msSince(t0),
        error: errorInfo(err),
      });

      observeModelCall(call, {
        done: (value) =>
          emit(
            kind === 'chat'
              ? fromChat(value as ChatCompletion, base, msSince(t0), prices)
              : fromResponse(value as Response, base, msSince(t0), prices),
          ),
        failed: (err) => emit(failed(err)),
        stream: (value) => {
          if (!isStream(value)) return undefined;
          if (kind === 'chat') {
            const chat = new StreamedChat(model);
            return {
              event: (e) => chat.add(e as ChatChunk),
              end: (err) => {
                const s = chat.step(base, msSince(t0), prices);
                emit(err === undefined ? s : { ...s, error: errorInfo(err) });
              },
            };
          }
          let final: Response | undefined;
          return {
            event: (e) => {
              const ev = e as ResponseEvent;
              if (
                ev.type === 'response.completed' ||
                ev.type === 'response.incomplete' ||
                ev.type === 'response.failed'
              ) {
                final = ev.response;
              }
            },
            end: (err) => {
              const s = final
                ? fromResponse(final, base, msSince(t0), prices)
                : step(base, model, undefined, msSince(t0), prices, {});
              emit(err === undefined ? s : { ...s, error: errorInfo(err) });
            },
          };
        },
      });
      return call;
    };

  const [chat, responses] = prototype
    ? [(client as Classes).Chat?.Completions?.prototype, (client as Classes).Responses?.prototype]
    : [(client as Resources).chat?.completions, (client as Resources).responses];
  wrapMethod(chat, 'create', record('chat'), { prototype });
  wrapMethod(responses, 'create', record('responses'), { prototype });
  return client;
}
