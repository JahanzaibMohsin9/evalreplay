# Running cases

The runner calls your agent once per run of each [case](cases.md), records a trace of the run and checks it against the case's assertions.

## Connect your agent

Export a config from `evalreplay.config.ts` in your project:

```ts
// evalreplay.config.ts
import { defineConfig } from '@evalreplay/core';
import { runAgent } from './src/agent';
import { tools } from './src/tools';

export default defineConfig({
  cases: 'cases/**/*.{yaml,case.ts}',
  agent: async (input, ctx) => runAgent(input.messages, { tools: ctx.wrapTools(tools) }),
});
```

`agent` gets the case input (`{ messages }`) and a run context, and returns the answer: a string, `{ text, structured }`, or a value that becomes the structured output.

| Field         | Default                         | Meaning                                                                                       |
| ------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `cases`       |                                 | Glob patterns for case files                                                                  |
| `agent`       |                                 | The function the runner calls                                                                 |
| `traces`      | `.evalreplay/traces/**/*.jsonl` | Where the traces named by `from_trace` are                                                    |
| `concurrency` | `4`                             | Runs at the same time                                                                         |
| `timeoutMs`   | `120000`                        | A run that takes longer fails with a `TimeoutError`                                           |
| `outDir`      | `.evalreplay/report`            | Where the report and the runs' traces are written                                             |
| `name`        | `agent`                         | Agent name written into each trace                                                            |
| `version`     |                                 | Agent version written into each trace, e.g. a git SHA                                         |
| `prices`      |                                 | USD per million tokens by model id, for model calls a [recorder](recorders.md) couldn't price |

Paths in the config are relative to the config file. A config file with an unknown key, such as a misspelled `concurency`, is an error.

## Tools

Wrap the tools your agent calls, so the runner can record them and, in replay mode, return recorded results:

```ts
const t = ctx.wrapTools({ compare_routes, execute_payment }); // an object of functions
const lookup = ctx.wrapTool('lookup', lookupFn); // one function

// for agents that dispatch tools by name
const output = ctx.callTool(name, args, () => executeTool(name, args));
```

Each call becomes a tool step in the trace, with its arguments, result or error, and latency. A tool that takes one object records it as the arguments; any other call records `{ arguments: [...] }`. A sync tool stays sync, so wrapping it doesn't change the agent's code. An error a tool throws is recorded and still reaches the agent.

The context also has `caseId`, `run` (from 1), `mode`, a `signal` that aborts when the run times out, and `recordStep(step)`, which recorders use to add model calls.

## Replay mode

A case with `from_trace` runs in replay mode: the model runs for real, but wrapped tools return the results recorded in that trace instead of running. Tests don't touch real systems, and every run sees the same tool results.

A call gets the first unused recorded call to the same tool with equal arguments, or else the next unused call to that tool in recorded order, since a model may word its arguments a little differently between runs. A tool error in the recording is thrown again. A call the recording has no result for throws a `ReplayMissError`, which `no_tool_errors` reports. Replayed tools return the value directly rather than a promise; `await` works on both.

Tools you don't wrap still run for real in replay mode.

## Running

```ts
import { resolve } from 'node:path';
import { loadConfig, runCases, writeReport } from '@evalreplay/core';

const { config, dir } = await loadConfig(); // finds evalreplay.config.ts
const { report, traces } = await runCases(config, { cwd: dir });
await writeReport(report, traces, resolve(dir, config.outDir ?? '.evalreplay/report'));
```

The `evalreplay run` command in phase 1 will do this for you.

`runCases` takes a `filter` to run some of the cases, and `onRun`, called after every run, to show progress. Case files that don't load are reported in `report.errors`, and the other cases still run.

A run fails when any assertion fails, or when the agent throws or times out. A case passes when every run passes. A replay case whose `from_trace` isn't in the trace files fails without running.

## The report

`writeReport` writes three files:

- `report.md`: the pass rate, a table of cases, and every failure with its assertion, message and trace id.
- `report.json`: the same data for tools: for each case its runs, and for each run its assertions, cost, latency and step count.
- `traces.jsonl`: the trace of every run, in the [trace format](trace-format.md).

```
**1 of 2 cases passed** · 6 of 8 runs passed (75%) · cost $0.031 · 14.2 s
```

Cost is only known when every model call has a price. Until a [recorder](recorders.md) records your agent's model calls, the cost is reported as unknown and `max_cost_usd` fails, rather than counting the runs as free.
