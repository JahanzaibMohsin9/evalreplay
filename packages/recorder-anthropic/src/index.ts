import type Anthropic from '@anthropic-ai/sdk';
import {
  type LlmStep,
  type ModelPrice,
  type ToolCall,
  errorInfo,
  msSince,
  observeModelCall,
  stepSink,
  wrapMethod,
} from '@evalreplay/core';
import { CLAUDE_PRICES, type ClaudePrice, baseModelId, claudeCost } from './prices.js';

export { CLAUDE_PRICES, CLAUDE_PRICES_DATE, type ClaudePrice } from './prices.js';

export interface RecordAnthropicOptions {
  /** USD per million tokens by model id, over CLAUDE_PRICES. */
  prices?: Record<string, ModelPrice | ClaudePrice>;
  /** gen_ai.provider.name for the steps. Default: `anthropic`. */
  provider?: string;
  /** Also called with every step, inside a run or not, e.g. to log calls. */
  onStep?: (step: LlmStep) => void;
}

type Message = Anthropic.Message | Anthropic.Beta.BetaMessage;
type StreamEvent = Anthropic.RawMessageStreamEvent | Anthropic.Beta.BetaRawMessageStreamEvent;

/** The parts of a message a step needs: a whole Message, or one put together from its stream. */
interface Collected {
  model: string;
  usage: Partial<Record<keyof Anthropic.Usage | 'speed', unknown>>;
  stop_reason?: string | null;
  content: readonly { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

function stepFrom(
  m: Collected,
  base: Pick<LlmStep, 'type' | 'startedAt' | 'provider'>,
  latencyMs: number,
  prices: Record<string, ClaudePrice>,
): LlmStep {
  const u = m.usage;
  const uncached = num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  const cacheWrite1h = num(
    (u.cache_creation as { ephemeral_1h_input_tokens?: unknown } | null)?.ephemeral_1h_input_tokens,
  );
  const price = prices[m.model] ?? prices[baseModelId(m.model)];

  const texts = m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '');
  const toolCalls: ToolCall[] = m.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      ...(b.id ? { id: b.id } : {}),
      name: b.name ?? '',
      args: (typeof b.input === 'object' && b.input !== null ? b.input : {}) as Record<
        string,
        unknown
      >,
    }));

  return {
    ...base,
    model: m.model,
    inputTokens: uncached + cacheRead + cacheWrite,
    outputTokens: num(u.output_tokens),
    ...(cacheRead ? { cachedInputTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheWriteInputTokens: cacheWrite } : {}),
    ...(price
      ? {
          costUsd: claudeCost(price, {
            uncached,
            cacheRead,
            cacheWrite5m: Math.max(0, cacheWrite - cacheWrite1h),
            cacheWrite1h,
            output: num(u.output_tokens),
            fast: u.speed === 'fast',
          }),
        }
      : {}),
    latencyMs,
    ...(m.stop_reason ? { finishReason: m.stop_reason } : {}),
    output: {
      ...(texts.length ? { text: texts.join('') } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    },
  };
}

/** Puts a message together from its stream events. */
class StreamedMessage implements Collected {
  model: string;
  usage: Collected['usage'] = {};
  stop_reason?: string | null;
  private readonly blocks = new Map<
    number,
    { type: string; text?: string; id?: string; name?: string; json?: string; input?: unknown }
  >();

  constructor(requestModel: string) {
    this.model = requestModel;
  }

  get content(): Collected['content'] {
    return [...this.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, b]) => {
        if (b.type !== 'tool_use' || b.json === undefined) return b;
        try {
          return { ...b, input: JSON.parse(b.json || '{}') };
        } catch {
          return { ...b, input: {} }; // a stream cut off mid-way through the arguments
        }
      });
  }

  private mergeUsage(usage: object | null | undefined) {
    // message_delta repeats the usage so far; a null means "not reported here"
    for (const [k, v] of Object.entries(usage ?? {}))
      if (v !== null && v !== undefined) this.usage[k as keyof Collected['usage']] = v;
  }

  add(e: StreamEvent) {
    switch (e.type) {
      case 'message_start':
        this.model = e.message.model;
        this.mergeUsage(e.message.usage);
        break;
      case 'content_block_start': {
        const b = e.content_block as { type: string; text?: string; id?: string; name?: string };
        this.blocks.set(e.index, {
          type: b.type,
          ...(b.type === 'text' ? { text: b.text ?? '' } : {}),
          ...(b.type === 'tool_use' ? { id: b.id, name: b.name, json: '' } : {}),
        });
        break;
      }
      case 'content_block_delta': {
        const b = this.blocks.get(e.index);
        if (b && e.delta.type === 'text_delta') b.text = (b.text ?? '') + e.delta.text;
        if (b && e.delta.type === 'input_json_delta')
          b.json = (b.json ?? '') + e.delta.partial_json;
        break;
      }
      case 'message_delta':
        this.stop_reason = e.delta.stop_reason;
        this.mergeUsage(e.usage);
        break;
    }
  }
}

const isStream = (v: unknown): v is AsyncIterable<StreamEvent> =>
  typeof (v as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] === 'function';

/**
 * Records every call the client makes to `messages.create` and `beta.messages.create`, which
 * `stream()`, `parse()` and the tool runner also go through. Inside an evalreplay run each call
 * becomes a model step of the run's trace; outside one, only `onStep` sees it. Returns the same
 * client, so wrap it where you create it: `recordAnthropic(new Anthropic())`.
 */
export function recordAnthropic<C extends object>(
  client: C,
  options: RecordAnthropicOptions = {},
): C {
  const prices: Record<string, ClaudePrice> = { ...CLAUDE_PRICES, ...options.prices };
  const provider = options.provider ?? 'anthropic';
  const c = client as { messages?: object; beta?: { messages?: object } };

  for (const resource of [c.messages, c.beta?.messages]) {
    wrapMethod(resource, 'create', (create) => (...args) => {
      const model = String((args[0] as { model?: unknown } | undefined)?.model ?? 'unknown');
      const emit = stepSink(options.onStep);
      const base = { type: 'llm', startedAt: new Date().toISOString(), provider } as const;
      const t0 = performance.now();
      const call = create(...args) as PromiseLike<Message | AsyncIterable<StreamEvent>>;

      observeModelCall(call, {
        done: (msg) => emit(stepFrom(msg as Message, base, msSince(t0), prices)),
        failed: (err) =>
          // a failed request isn't billed
          emit({
            ...base,
            model,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            latencyMs: msSince(t0),
            error: errorInfo(err),
          }),
        stream: (value) => {
          if (!isStream(value)) return undefined;
          const msg = new StreamedMessage(model);
          return {
            event: (e) => msg.add(e as StreamEvent),
            end: (err) => {
              const step = stepFrom(msg, base, msSince(t0), prices);
              emit(err === undefined ? step : { ...step, error: errorInfo(err) });
            },
          };
        },
      });
      return call;
    });
  }
  return client;
}
