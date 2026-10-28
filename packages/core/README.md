# @evalreplay/core

The trace format, test cases, assertions, runner and reports of [evalreplay](https://github.com/JahanzaibMohsin9/evalreplay), which turns what your AI agent did into tests that run in CI.

Most projects install the [`evalreplay`](https://www.npmjs.com/package/evalreplay) command line, which depends on this package, and use it for `defineConfig`:

```ts
// evalreplay.config.ts
import { defineConfig } from '@evalreplay/core';
import { runAgent, tools } from './src/agent';

export default defineConfig({
  cases: 'cases/**/*.yaml',
  agent: (input, ctx) => runAgent(input.messages, { tools: ctx.wrapTools(tools) }),
});
```

Programmatic use: `loadCases`, `evaluateCase`, `runCases`, `writeReport`, `compareReports`, and the trace schema (`TraceSchema`, `@evalreplay/core/trace.schema.json`).

Docs: [trace format](https://github.com/JahanzaibMohsin9/evalreplay/blob/main/docs/trace-format.md) · [test cases](https://github.com/JahanzaibMohsin9/evalreplay/blob/main/docs/cases.md) · [running cases](https://github.com/JahanzaibMohsin9/evalreplay/blob/main/docs/running.md)
