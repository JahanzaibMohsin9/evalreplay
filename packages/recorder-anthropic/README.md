# @evalreplay/recorder-anthropic

Records every call your agent makes through the [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) into the trace of its [evalreplay](https://github.com/JahanzaibMohsin9/evalreplay) run: model, tokens (cache reads and writes too), cost, latency, stop reason, text and tool calls. `messages` and `beta.messages`, streamed or not, including `parse()` and the tool runner.

```ts
import Anthropic from '@anthropic-ai/sdk';
import { recordAnthropic } from '@evalreplay/recorder-anthropic';

const claude = recordAnthropic(new Anthropic());
// or, when your code creates its clients itself: recordAnthropic(Anthropic)
```

Outside an evalreplay run it records nothing. Calls are priced at Claude's list prices (`CLAUDE_PRICES`, dated `CLAUDE_PRICES_DATE`); pass `prices` to override them.

Docs: [recording model calls](https://github.com/JahanzaibMohsin9/evalreplay/blob/main/docs/recorders.md)
