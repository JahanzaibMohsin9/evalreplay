# Recording model calls

A recorder wraps an SDK client so every model call your agent makes is added to the trace of the run that made it: the model, tokens, cost, latency, finish reason, text and the tool calls the model asked for. Without one, a trace has only tool calls and the final output, and the cost of a run is unknown.

```bash
pnpm add -D @evalreplay/recorder-openai     # for the openai package
pnpm add -D @evalreplay/recorder-anthropic  # for @anthropic-ai/sdk
```

Wrap the client where you create it. The recorders don't need an API key and send nothing anywhere: they read the responses your agent already gets.

```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { recordAnthropic } from '@evalreplay/recorder-anthropic';
import { recordOpenAI } from '@evalreplay/recorder-openai';

const claude = recordAnthropic(new Anthropic());
const openai = recordOpenAI(new OpenAI());
const deepseek = recordOpenAI(new OpenAI({ baseURL: 'https://api.deepseek.com' }));
```

A recorder returns the same client, with nothing else changed: types, helpers like `.withResponse()`, and errors all stay as they were. Outside an evalreplay run it records nothing, so the wrapped client can stay in your app's code. Wrapping a client twice still records each call once.

When your code creates its clients where you can't wrap them, pass the SDK class to record every client it creates:

```ts
recordOpenAI(OpenAI);
recordAnthropic(Anthropic);
```

The [CarryPay example](../examples/carrypay) does this, since CarryPay's agent creates a client for each wake-up.

## What gets recorded

| SDK                 | Methods                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/sdk` | `messages.create` and `beta.messages.create`, which `stream()`, `parse()` and the tool runner also use  |
| `openai`            | `chat.completions.create` and `responses.create`, which `parse()`, `stream()` and `runTools()` also use |

Streamed responses are recorded once the agent has read the stream, or as far as it read. A failed request is recorded with its error and a cost of 0, and still throws as before.

Tokens follow the [trace format](trace-format.md): `inputTokens` counts every input token, `cachedInputTokens` the ones read from the provider's cache, and `cacheWriteInputTokens` the ones written to it.

The OpenAI recorder names the provider from the client's base URL (`api.deepseek.com` → `deepseek`); pass `provider` to set it yourself.

## Prices

The Anthropic recorder knows Claude's list prices (as of 6 October 2026, in `CLAUDE_PRICES`), including cache reads and writes, fast mode and Claude Haiku 5.5's higher price above 100K-token prompts. The OpenAI recorder knows none, because OpenAI and the compatible providers change their prices often. Give a price for every model you use, in USD per million tokens, either in the config:

```ts
export default defineConfig({
  cases: 'cases/**/*.yaml',
  agent,
  // example numbers: copy the current ones from your provider's pricing page
  prices: {
    'gpt-5.4-mini': { input: 0.25, output: 2, cachedInput: 0.025 },
    'deepseek-v4-pro': { input: 0.5, output: 2, cachedInput: 0.05 },
  },
});
```

or to the recorder, as `recordOpenAI(client, { prices })`, which also overrides a Claude price in `recordAnthropic`. A price for a model id also prices its dated versions (`gpt-5.4-mini-2026-03-17`), but no other near match.

A model call with no price has no cost, and neither does its run: `max_cost_usd` fails rather than count it as free. The same goes for a streamed OpenAI chat completion requested without `stream_options: { include_usage: true }`, which reports no tokens: its step is marked `usageMissing`.

## Outside a run

Pass `onStep` to see every recorded call, inside a run or not:

```ts
recordOpenAI(new OpenAI(), { onStep: (step) => console.log(step.model, step.costUsd) });
```
