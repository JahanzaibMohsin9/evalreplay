# evalreplay

[![CI](https://github.com/JahanzaibMohsin9/evalreplay/actions/workflows/ci.yml/badge.svg)](https://github.com/JahanzaibMohsin9/evalreplay/actions/workflows/ci.yml)

Turn what your AI agent actually did into tests that run in CI.

1. **Record** an agent run as a trace: model calls, tool calls with arguments and results, tokens, cost, latency, final output.
2. **Turn traces into test cases** with assertions: the right tool was called, its arguments are valid, the cost stayed under a limit.
3. **Re-run the cases on every pull request** and see the pass rate, the cost change and anything that got worse.

> Status: early development. The trace format, the case format and assertion checking in `@evalreplay/core` are in place; the runner, recorders and the CLI are next (see [PLAN.md](PLAN.md)).

## Packages

| Package                             | What it does                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| [`@evalreplay/core`](packages/core) | Trace format, test case format (YAML and `.case.ts`), case loader and assertion checking |

## Docs

- [Trace format](docs/trace-format.md)
- [Test cases](docs/cases.md)

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
