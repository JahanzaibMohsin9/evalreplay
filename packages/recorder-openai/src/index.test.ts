import { type LlmStep, runCases } from '@evalreplay/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerOf, recordOpenAI } from './index.js';

// The real SDK with a fake fetch: requests never leave the process, and no API key is needed.

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1_790_000_000,
  model: 'gpt-5.4-mini-2026-03-17',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: 'Comparing routes.',
        refusal: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'compare_routes', arguments: '{"amount":1200,"currency":"EUR"}' },
          },
          { id: 'call_2', type: 'function', function: { name: 'get_fx', arguments: '{"to":' } },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 5000,
    completion_tokens: 300,
    total_tokens: 5300,
    prompt_tokens_details: { cached_tokens: 4000 },
  },
};

const RESPONSE = {
  id: 'resp_1',
  object: 'response',
  created_at: 1_790_000_000,
  model: 'gpt-5.4',
  status: 'completed',
  incomplete_details: null,
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [] },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'The cheapest is SEPA.', annotations: [] }],
    },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_9',
      name: 'get_fx',
      arguments: '{"to":"EUR"}',
      status: 'completed',
    },
  ],
  usage: {
    input_tokens: 2000,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 100,
    output_tokens_details: { reasoning_tokens: 40 },
    total_tokens: 2100,
  },
};

const sse = (events: object[], named = false) =>
  events
    .map(
      (e) =>
        `${named ? `event: ${(e as { type: string }).type}\n` : ''}data: ${JSON.stringify(e)}\n\n`,
    )
    .join('') + (named ? '' : 'data: [DONE]\n\n');

const chunk = (delta: object, extra: object = {}) => ({
  id: 'chatcmpl-2',
  object: 'chat.completion.chunk',
  created: 1_790_000_000,
  model: 'deepseek-v4-pro',
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});

const CHAT_STREAM = (usage: boolean) =>
  sse([
    chunk({ role: 'assistant', content: 'The cheapest ' }),
    chunk({ content: 'is SEPA.' }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call_3',
          type: 'function',
          function: { name: 'get_fx', arguments: '{"to"' },
        },
      ],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ':"EUR"}' } }] }),
    { ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ...(usage
      ? [
          {
            ...chunk({}),
            choices: [],
            usage: {
              prompt_tokens: 800,
              completion_tokens: 20,
              total_tokens: 820,
              prompt_cache_hit_tokens: 600,
            },
          },
        ]
      : []),
  ]);

type Reply = { status?: number; json?: unknown; sse?: string };

function client(baseURL: string | undefined, ...replies: Reply[]) {
  const fetch = async () => {
    const r = replies.shift() ?? { status: 500, json: { error: { message: 'no reply left' } } };
    return r.sse === undefined
      ? new Response(JSON.stringify(r.json), {
          status: r.status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(r.sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return new OpenAI({ apiKey: 'test', fetch, maxRetries: 0, ...(baseURL ? { baseURL } : {}) });
}

const chat = { model: 'gpt-5.4-mini', messages: [{ role: 'user' as const, content: 'Pay' }] };
const PRICES = { 'gpt-5.4-mini': { input: 0.25, output: 2, cachedInput: 0.025 } };

function recorded(c: OpenAI, prices = {}) {
  const steps: LlmStep[] = [];
  recordOpenAI(c, { prices, onStep: (s) => steps.push(s) });
  return steps;
}

describe('chat.completions.create', () => {
  it('records the model, tokens, finish reason, text and tool calls', async () => {
    const c = client(undefined, { json: COMPLETION });
    const steps = recorded(c, PRICES);
    const completion = await c.chat.completions.create(chat);
    expect(completion.id).toBe('chatcmpl-1');
    expect(steps).toEqual([
      {
        type: 'llm',
        startedAt: expect.any(String),
        provider: 'openai',
        model: 'gpt-5.4-mini-2026-03-17',
        inputTokens: 5000,
        outputTokens: 300,
        cachedInputTokens: 4000,
        // the dated id gets the price of gpt-5.4-mini: (1000 × 0.25 + 4000 × 0.025 + 300 × 2) / 1M
        costUsd: expect.closeTo(0.00095, 10),
        latencyMs: expect.any(Number),
        finishReason: 'tool_calls',
        output: {
          text: 'Comparing routes.',
          toolCalls: [
            { id: 'call_1', name: 'compare_routes', args: { amount: 1200, currency: 'EUR' } },
            { id: 'call_2', name: 'get_fx', args: { invalidJson: '{"to":' } },
          ],
        },
      },
    ]);
  });

  it('leaves the cost out without a price', async () => {
    const c = client(undefined, { json: COMPLETION });
    const steps = recorded(c);
    await c.chat.completions.create(chat);
    expect(steps[0]?.costUsd).toBeUndefined();
    expect(steps[0]?.inputTokens).toBe(5000);
  });

  it('names an OpenAI-compatible provider from the base URL, and reads DeepSeek cache hits', async () => {
    const c = client('https://api.deepseek.com', {
      json: {
        ...COMPLETION,
        model: 'deepseek-v4-pro',
        usage: {
          prompt_tokens: 900,
          completion_tokens: 10,
          total_tokens: 910,
          prompt_cache_hit_tokens: 700,
        },
      },
    });
    const steps = recorded(c);
    await c.chat.completions.create({ ...chat, model: 'deepseek-v4-pro' });
    expect(steps[0]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      cachedInputTokens: 700,
    });
  });

  it('records parse() through create, keeping its parsed result', async () => {
    const c = client(undefined, {
      json: {
        ...COMPLETION,
        choices: [
          {
            ...COMPLETION.choices[0],
            message: { role: 'assistant', content: 'ok', refusal: null },
          },
        ],
      },
    });
    const steps = recorded(c);
    const parsed = await c.chat.completions.parse(chat);
    expect(parsed.choices[0]?.message.content).toBe('ok');
    expect(steps).toHaveLength(1);
  });

  it('records a failed request at no cost, and still throws it', async () => {
    const c = client(undefined, {
      status: 429,
      json: { error: { message: 'Rate limit reached', type: 'requests' } },
    });
    const steps = recorded(c);
    await expect(c.chat.completions.create(chat)).rejects.toBeInstanceOf(OpenAI.RateLimitError);
    expect(steps[0]).toMatchObject({
      model: 'gpt-5.4-mini',
      costUsd: 0,
      error: { type: 'RateLimitError', message: expect.stringContaining('Rate limit reached') },
    });
  });
});

describe('chat streaming', () => {
  it('puts the step together from the chunks, with usage when the stream reports it', async () => {
    const c = client('https://api.deepseek.com', { sse: CHAT_STREAM(true) });
    const steps = recorded(c, { 'deepseek-v4-pro': { input: 1, output: 2 } });
    const stream = await c.chat.completions.create({
      ...chat,
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    for await (const ch of stream) text += ch.choices[0]?.delta.content ?? '';
    expect(text).toBe('The cheapest is SEPA.');
    expect(steps).toEqual([
      expect.objectContaining({
        model: 'deepseek-v4-pro',
        inputTokens: 800,
        outputTokens: 20,
        cachedInputTokens: 600,
        costUsd: expect.closeTo((800 + 20 * 2) / 1e6, 10),
        finishReason: 'tool_calls',
        output: {
          text: 'The cheapest is SEPA.',
          toolCalls: [{ id: 'call_3', name: 'get_fx', args: { to: 'EUR' } }],
        },
      }),
    ]);
  });

  it('marks the usage as missing when the stream reports none', async () => {
    const c = client(undefined, { sse: CHAT_STREAM(false) });
    const steps = recorded(c, PRICES);
    const stream = await c.chat.completions.create({ ...chat, stream: true });
    for await (const _ of stream) {
      // read it all
    }
    expect(steps[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, usageMissing: true });
    expect(steps[0]?.costUsd).toBeUndefined();
  });

  it('records chat.completions.stream() once', async () => {
    const c = client(undefined, { sse: CHAT_STREAM(true) });
    const steps = recorded(c);
    const final = await c.chat.completions.stream(chat).finalChatCompletion();
    expect(final.choices[0]?.message.content).toBe('The cheapest is SEPA.');
    expect(steps).toHaveLength(1);
    expect(steps[0]?.output?.toolCalls?.[0]?.args).toEqual({ to: 'EUR' });
  });
});

describe('responses', () => {
  const step = {
    model: 'gpt-5.4',
    inputTokens: 2000,
    outputTokens: 100,
    finishReason: 'completed',
    output: {
      text: 'The cheapest is SEPA.',
      toolCalls: [{ id: 'call_9', name: 'get_fx', args: { to: 'EUR' } }],
    },
  };

  it('records responses.create', async () => {
    const c = client(undefined, { json: RESPONSE });
    const steps = recorded(c);
    const r = await c.responses.create({ model: 'gpt-5.4', input: 'Pay' });
    expect(r.id).toBe('resp_1');
    expect(steps[0]).toMatchObject(step);
  });

  it('records a streamed response from its final event', async () => {
    const events = [
      {
        type: 'response.created',
        sequence_number: 0,
        response: { ...RESPONSE, status: 'in_progress', output: [], usage: null },
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 1,
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        delta: 'The cheapest is SEPA.',
        logprobs: [],
      },
      { type: 'response.completed', sequence_number: 2, response: RESPONSE },
    ];
    const c = client(undefined, { sse: sse(events, true) });
    const steps = recorded(c);
    const stream = await c.responses.create({ model: 'gpt-5.4', input: 'Pay', stream: true });
    for await (const _ of stream) {
      // read it all
    }
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject(step);
  });

  it('reports why a response is incomplete', async () => {
    const c = client(undefined, {
      json: {
        ...RESPONSE,
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    });
    const steps = recorded(c);
    await c.responses.create({ model: 'gpt-5.4', input: 'Pay' });
    expect(steps[0]?.finishReason).toBe('max_output_tokens');
  });
});

describe('the OpenAI class', () => {
  it('records every client it creates, each with its own provider', async () => {
    const proto = OpenAI.Chat.Completions.prototype;
    const original = proto.create;
    try {
      const steps: LlmStep[] = [];
      recordOpenAI(OpenAI, { onStep: (s) => steps.push(s) });
      // created after, the way an app creates clients inside its own code
      await client(undefined, { json: COMPLETION }).chat.completions.create(chat);
      await client('https://api.deepseek.com', { json: COMPLETION }).chat.completions.create(chat);
      expect(steps.map((s) => s.provider)).toEqual(['openai', 'deepseek']);
    } finally {
      proto.create = original;
    }
  });
});

describe('providerOf', () => {
  it('names the provider from the base URL', () => {
    expect(providerOf(undefined)).toBe('openai');
    expect(providerOf('https://api.openai.com/v1')).toBe('openai');
    expect(providerOf('https://api.deepseek.com')).toBe('deepseek');
    expect(providerOf('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(providerOf('http://localhost:11434/v1')).toBe('local');
    expect(providerOf('http://127.0.0.1:8000')).toBe('local');
  });
});

describe('inside a run', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evalreplay-openai-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records into the run, priced by the config when the recorder has no price', async () => {
    await mkdir(join(dir, 'cases'));
    await writeFile(
      join(dir, 'cases/a.yaml'),
      'id: a\ninput: Pay\nassert:\n  - max_cost_usd: 0.01\n  - max_steps: 1\n',
    );
    const c = recordOpenAI(client(undefined, { json: COMPLETION }));
    const { report, traces } = await runCases(
      {
        cases: 'cases/*.yaml',
        prices: PRICES,
        agent: async () =>
          (await c.chat.completions.create(chat)).choices[0]?.message.content ?? '',
      },
      { cwd: dir },
    );
    expect(report.summary).toMatchObject({ runsPassed: 1, costUsd: expect.closeTo(0.00095, 10) });
    expect(traces[0]?.steps[0]).toMatchObject({
      type: 'llm',
      provider: 'openai',
      costUsd: expect.closeTo(0.00095, 10),
    });
  });
});
