# @evalreplay/recorder-openai

Records every call your agent makes through the [`openai`](https://www.npmjs.com/package/openai) SDK into the trace of its [evalreplay](https://github.com/JahanzaibMohsin9/evalreplay) run: model, tokens, cost, latency, finish reason, text and tool calls. Chat Completions and the Responses API, streamed or not, and OpenAI-compatible providers such as DeepSeek.

```ts
import OpenAI from 'openai';
import { recordOpenAI } from '@evalreplay/recorder-openai';

const openai = recordOpenAI(new OpenAI());
const deepseek = recordOpenAI(new OpenAI({ baseURL: 'https://api.deepseek.com' }));
// or, when your code creates its clients itself: recordOpenAI(OpenAI)
```

Outside an evalreplay run it records nothing. It ships no prices: add them to `prices` in `evalreplay.config.ts`, or the cost of a run stays unknown.

Docs: [recording model calls](https://github.com/JahanzaibMohsin9/evalreplay/blob/main/docs/recorders.md)
