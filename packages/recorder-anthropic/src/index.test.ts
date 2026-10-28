import Anthropic from '@anthropic-ai/sdk';
import { type LlmStep, type Trace, runCases } from '@evalreplay/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_PRICES, recordAnthropic } from './index.js';

// The real SDK with a fake fetch: requests never leave the process, and no API key is needed.

const MESSAGE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: 'Comparing routes. ' },
    {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'compare_routes',
      input: { amount: 1200, currency: 'EUR' },
    },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
    service_tier: 'standard',
  },
};

const sse = (events: object[]) =>
  events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');

const STREAM = sse([
  {
    type: 'message_start',
    message: {
      ...MESSAGE,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 300, output_tokens: 1 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The cheapest ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'is SEPA.' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_2', name: 'get_fx', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"to":' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '"EUR"}' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 42 },
  },
  { type: 'message_stop' },
]);

type Reply = { status?: number; json?: unknown; sse?: string };

/** A client whose requests get the replies in order. */
function client(...replies: Reply[]) {
  const fetch = async () => {
    const r = replies.shift() ?? {
      status: 500,
      json: { type: 'error', error: { type: 'api_error', message: 'no reply left' } },
    };
    return r.sse === undefined
      ? new Response(JSON.stringify(r.json), {
          status: r.status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(r.sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return new Anthropic({ apiKey: 'test', fetch, maxRetries: 0 });
}

const request = {
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  messages: [{ role: 'user' as const, content: 'Pay' }],
};

/** Records with onStep, outside a run. */
function recorded(c: Anthropic) {
  const steps: LlmStep[] = [];
  recordAnthropic(c, { onStep: (s) => steps.push(s) });
  return steps;
}

describe('messages.create', () => {
  it('records the model, tokens, cost, stop reason, text and tool calls', async () => {
    const c = client({ json: MESSAGE });
    const steps = recorded(c);
    const msg = await c.messages.create(request);
    expect(msg.id).toBe('msg_1');
    expect(steps).toEqual([
      {
        type: 'llm',
        startedAt: expect.any(String),
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        inputTokens: 5500,
        outputTokens: 200,
        cachedInputTokens: 4000,
        cacheWriteInputTokens: 500,
        // (1000 × 4 + 4000 × 0.2 + 500 × 5 + 200 × 20) / 1M
        costUsd: expect.closeTo(0.0113, 10),
        latencyMs: expect.any(Number),
        finishReason: 'tool_use',
        output: {
          text: 'Comparing routes. ',
          toolCalls: [
            { id: 'toolu_1', name: 'compare_routes', args: { amount: 1200, currency: 'EUR' } },
          ],
        },
      },
    ]);
  });

  it('records beta.messages.create and keeps withResponse working', async () => {
    const c = client({ json: { ...MESSAGE, model: 'claude-sonnet-5-5' } });
    const steps = recorded(c);
    const { data, response } = await c.beta.messages.create(request).withResponse();
    expect(response.status).toBe(200);
    expect(data.model).toBe('claude-sonnet-5-5');
    expect(steps[0]?.model).toBe('claude-sonnet-5-5');
  });

  it('prices 1-hour cache writes, fast mode, long Haiku prompts and dated ids', async () => {
    const usage = (u: object) => ({ json: { ...MESSAGE, usage: { ...MESSAGE.usage, ...u } } });
    const c = client(
      usage({
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
        cache_read_input_tokens: 0,
      }),
      usage({ speed: 'fast', cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      {
        json: {
          ...MESSAGE,
          model: 'claude-haiku-5-5',
          usage: { input_tokens: 150_000, output_tokens: 1000 },
        },
      },
      {
        json: {
          ...MESSAGE,
          model: 'claude-haiku-4-5-20251001',
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        },
      },
    );
    const steps = recorded(c);
    for (let i = 0; i < 4; i++) await c.messages.create(request);
    expect(steps.map((s) => s.costUsd)).toEqual([
      expect.closeTo((1000 * 4 + 1000 * 8 + 200 * 20) / 1e6, 10),
      expect.closeTo((2 * (1000 * 4 + 200 * 20)) / 1e6, 10),
      expect.closeTo((150_000 * 0.5 + 1000 * 2.5) / 1e6, 10),
      expect.closeTo(1, 10),
    ]);
  });

  it('leaves the cost out for a model it has no price for, unless given one', async () => {
    const unknown = { json: { ...MESSAGE, model: 'claude-next' } };
    const c = client(unknown, unknown);
    const steps = recorded(c);
    await c.messages.create(request);
    expect(steps[0]?.costUsd).toBeUndefined();

    const priced = client(unknown);
    const more: LlmStep[] = [];
    recordAnthropic(priced, {
      prices: { 'claude-next': { input: 1, output: 1 } },
      onStep: (s) => more.push(s),
    });
    await priced.messages.create(request);
    expect(more[0]?.costUsd).toBeCloseTo((1000 + 4000 * 0.1 + 500 * 1.25 + 200) / 1e6, 10);
  });

  it('records a failed request at no cost, and still throws it', async () => {
    const c = client({
      status: 400,
      json: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'max_tokens too large' },
      },
    });
    const steps = recorded(c);
    await expect(c.messages.create(request)).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    expect(steps[0]).toMatchObject({
      model: 'claude-opus-5-5',
      inputTokens: 0,
      costUsd: 0,
      error: { type: 'BadRequestError', message: expect.stringContaining('max_tokens too large') },
    });
  });

  it('records each call once when the client is wrapped twice', async () => {
    const c = client({ json: MESSAGE });
    const steps = recorded(c);
    recordAnthropic(c, { onStep: (s) => steps.push(s) });
    await c.messages.create(request);
    expect(steps).toHaveLength(1);
  });

  it('records parse() once, keeping its result', async () => {
    const c = client({ json: MESSAGE }, { json: MESSAGE });
    const steps = recorded(c);
    expect((await c.messages.parse(request)).id).toBe('msg_1');
    expect((await c.beta.messages.parse(request)).id).toBe('msg_1');
    expect(steps).toHaveLength(2);
  });
});

describe('the Anthropic class', () => {
  it('records every client it creates', async () => {
    const protos = [Anthropic.Messages.prototype, Anthropic.Beta.Messages.prototype];
    const originals = protos.map((p) => p.create);
    try {
      const steps: LlmStep[] = [];
      recordAnthropic(Anthropic, { onStep: (s) => steps.push(s) });
      const c = client({ json: MESSAGE }, { json: MESSAGE });
      await c.messages.create(request);
      await c.beta.messages.create(request);
      expect(steps).toHaveLength(2);
    } finally {
      protos.forEach((p, i) => {
        p.create = originals[i] as never;
      });
    }
  });
});

describe('streaming', () => {
  const streamed = {
    model: 'claude-opus-5-5',
    inputTokens: 300,
    outputTokens: 42,
    finishReason: 'tool_use',
    output: {
      text: 'The cheapest is SEPA.',
      toolCalls: [{ id: 'toolu_2', name: 'get_fx', args: { to: 'EUR' } }],
    },
  };

  it('records create({ stream: true }) once the stream has been read', async () => {
    const c = client({ sse: STREAM });
    const steps = recorded(c);
    const stream = await c.messages.create({ ...request, stream: true });
    expect(steps).toHaveLength(0);
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect(types).toHaveLength(11);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      ...streamed,
      costUsd: expect.closeTo((300 * 4 + 42 * 20) / 1e6, 10),
    });
  });

  it('records messages.stream() and finalMessage()', async () => {
    const c = client({ sse: STREAM });
    const steps = recorded(c);
    const final = await c.messages.stream(request).finalMessage();
    expect(final.content).toHaveLength(2);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject(streamed);
  });

  it('records what arrived when the reader stops early', async () => {
    const c = client({ sse: STREAM });
    const steps = recorded(c);
    const stream = await c.messages.create({ ...request, stream: true });
    for await (const event of stream) if (event.type === 'content_block_stop') break;
    expect(steps[0]).toMatchObject({
      inputTokens: 300,
      outputTokens: 1,
      output: { text: 'The cheapest is SEPA.' },
    });
  });
});

describe('inside a run', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evalreplay-anthropic-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adds each call to the trace of the run that made it, so cost is known', async () => {
    await mkdir(join(dir, 'cases'));
    await writeFile(
      join(dir, 'cases/a.yaml'),
      'id: a\ninput: Pay\nruns: 2\nassert:\n  - max_cost_usd: 0.05\n',
    );
    // wrapped once, outside any run, as an app would at startup
    const c = recordAnthropic(client({ json: MESSAGE }, { json: MESSAGE }));
    const { report, traces } = await runCases(
      {
        cases: 'cases/*.yaml',
        concurrency: 1,
        agent: async (input, ctx) => {
          const msg = await c.messages.create(request);
          ctx.callTool('compare_routes', { amount: 1200 }, () => ({ cheapest: 'sepa' }));
          return msg.content.find((b) => b.type === 'text')?.text;
        },
      },
      { cwd: dir },
    );
    expect(report.summary).toMatchObject({
      runs: 2,
      runsPassed: 2,
      costUsd: expect.closeTo(0.0226, 10),
    });
    expect(traces.map((t: Trace) => t.steps.map((s) => s.type))).toEqual([
      ['llm', 'tool'],
      ['llm', 'tool'],
    ]);
  });

  it('has prices for the current Claude models', () => {
    expect(Object.keys(CLAUDE_PRICES)).toContain('claude-opus-5-5');
  });
});
