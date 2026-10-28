# evalreplay

[![CI](https://github.com/JahanzaibMohsin9/evalreplay/actions/workflows/ci.yml/badge.svg)](https://github.com/JahanzaibMohsin9/evalreplay/actions/workflows/ci.yml)

Turn what your AI agent actually did into tests that run in CI.

1. **Record** an agent run as a trace: model calls, tool calls with arguments and results, tokens, cost, latency, final output.
2. **Turn traces into test cases** with assertions: the right tool was called, its arguments are valid, the cost stayed under a limit.
3. **Re-run the cases on every pull request** and see the pass rate, the cost change and anything that got worse.

> Status: early development. `@evalreplay/core` has the trace format, the case format, assertion checking and the runner with replay mode and reports; recorders for the OpenAI and Anthropic SDKs record model calls. The CLI is next (see [PLAN.md](PLAN.md)).

## Packages

| Package                                                         | What it does                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`@evalreplay/core`](packages/core)                             | Trace format, test case format (YAML and `.case.ts`), case loader, assertions, runner and reports |
| [`@evalreplay/recorder-openai`](packages/recorder-openai)       | Records OpenAI SDK calls (Chat Completions, Responses, OpenAI-compatible providers)               |
| [`@evalreplay/recorder-anthropic`](packages/recorder-anthropic) | Records Anthropic SDK calls, priced at Claude list prices                                         |

## Docs

- [Trace format](docs/trace-format.md)
- [Test cases](docs/cases.md)
- [Running cases](docs/running.md)
- [Recording model calls](docs/recorders.md)

## Development

Needs Node 22 or newer and pnpm 12 (`corepack enable`, or `npm install -g pnpm`).

```bash
pnpm install
pnpm test        # Vitest
pnpm lint        # ESLint
pnpm typecheck   # tsc
pnpm build
```

## License

[MIT](LICENSE)
