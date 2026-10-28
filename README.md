# evalreplay

[![CI](https://github.com/JahanzaibMohsin9/evalreplay/actions/workflows/ci.yml/badge.svg)](https://github.com/JahanzaibMohsin9/evalreplay/actions/workflows/ci.yml)

Turn what your AI agent actually did into tests that run in CI.

1. **Record** an agent run as a trace: model calls, tool calls with arguments and results, tokens, cost, latency, final output.
2. **Turn traces into test cases** with assertions: the right tool was called, its arguments are valid, the cost stayed under a limit.
3. **Re-run the cases on every pull request** and see the pass rate, the cost change and anything that got worse.

> Status: early development. `@evalreplay/core` has the trace format, the case format, assertion checking and the runner with replay mode and reports; recorders for the OpenAI and Anthropic SDKs record model calls, and the `evalreplay` CLI runs cases, captures runs as cases and compares with a baseline. The [CarryPay example](examples/carrypay) runs 16 cases against a real payment agent, offline. A GitHub Action runs the cases on pull requests and comments with the results. Publishing 0.1.0 to npm is next (see [PLAN.md](PLAN.md)).

## Packages

| Package                                                         | What it does                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [`@evalreplay/core`](packages/core)                             | Trace format, test case format (YAML and `.case.ts`), case loader, assertions, runner and reports                             |
| [`@evalreplay/recorder-openai`](packages/recorder-openai)       | Records OpenAI SDK calls (Chat Completions, Responses, OpenAI-compatible providers)                                           |
| [`@evalreplay/recorder-anthropic`](packages/recorder-anthropic) | Records Anthropic SDK calls, priced at Claude list prices                                                                     |
| [`evalreplay`](packages/cli)                                    | The command line: `run`, `capture`, `baseline save`, `run --compare baseline`                                                 |
| [GitHub Action](docs/github-action.md)                          | `uses: JahanzaibMohsin9/evalreplay@main`: runs the cases on a PR and comments with the pass rate, cost change and regressions |

## Example

[`examples/carrypay`](examples/carrypay): 16 cases for CarryPay's payment agent (verified addresses only, a payee checked before every payment, scams flagged), run against CarryPay's own code and its recorded decisions, with no API key. evalreplay's CI runs them, and checks that a broken tool fails the run.

## Docs

- [Trace format](docs/trace-format.md)
- [Test cases](docs/cases.md)
- [Running cases](docs/running.md)
- [Recording model calls](docs/recorders.md)
- [Command line](docs/cli.md)
- [GitHub Action](docs/github-action.md)

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
