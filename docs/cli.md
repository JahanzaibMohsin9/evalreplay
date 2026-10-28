# Command line

```bash
pnpm add -D evalreplay
```

Every command reads `evalreplay.config.ts` (or `.mts`, `.js`, `.mjs`) in the current folder; pass `--config <file>` for another one. See [Running cases](running.md) for the config.

## evalreplay run

Runs every case and prints each run as it finishes, then every failure and the totals:

```
✓ pay-tuition run 1/3  1.2 s · $0.0031
✗ refund-gbp  0.9 s · $0.0024  tool_not_called: execute_payment

✗ refund-gbp  0/1 run passed  cases/payments/refund.yaml
    tool_not_called: execute_payment: execute_payment was called once (step 4)
    trace run_4f0c…

1 of 2 cases passed · 3 of 4 runs passed (75%) · $0.0117 · 3.1 s

Report: .evalreplay/report/report.md · traces: .evalreplay/report/traces.jsonl
```

| Option                       | Meaning                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `--case <id>`                | Only this case; repeat for more                                                       |
| `--tag <tag>`                | Only cases with this tag; repeat for more                                             |
| `--compare <file\|baseline>` | Compare with a saved report; `baseline` means `.evalreplay/baseline.json`             |
| `--max-cost-increase <pct>`  | With `--compare`, a bigger rise in a case's cost per run is a regression (default 20) |
| `--concurrency <n>`          | Runs at the same time, instead of the config's                                        |
| `--out <dir>`                | Where the report goes, instead of the config's `outDir`                               |

It writes `report.md`, `report.json` and `traces.jsonl` (see [the report](running.md#the-report)).

## Comparing with a baseline

Agents vary from run to run, so a case that passes 4 of 5 runs isn't necessarily broken. A baseline lets CI fail only when something got worse:

```bash
evalreplay run                     # on main
evalreplay baseline save           # keeps the report as .evalreplay/baseline.json; commit it
evalreplay run --compare baseline  # on a pull request
```

A case got worse when its pass rate dropped, when it ran before and now can't, or when its average cost per run rose more than 20% (`--max-cost-increase`). New cases and cases that are no longer run are listed but don't count as worse. The comparison is printed, added to `report.md` and saved in `report.json` as `comparison`.

## evalreplay capture

Turns a recorded run into a case file:

```bash
evalreplay capture run_4f0c9d…               # writes cases/<id>.yaml
evalreplay capture run_4f0c9d… --id refund-gbp --out cases/payments/refund.yaml
```

The case replays the run: same input, and `from_trace` set so the tools return what they returned that time. Its assertions describe what the run did (the tools it called and their order, no tool errors, and a step and cost limit with some headroom). They are a starting point: edit them to say what the agent must do, for example `tool_not_called` for a tool that needs approval.

The trace is looked up in the config's `traces` files and in the last run's `traces.jsonl`. A trace from the last run is copied to `.evalreplay/traces/captured.jsonl`, since the next run overwrites `traces.jsonl`. `--force` overwrites an existing case file.

## evalreplay baseline save

| Option                 | Default                            |
| ---------------------- | ---------------------------------- |
| `--from <report.json>` | the last run's report, in `outDir` |
| `--to <file>`          | `.evalreplay/baseline.json`        |

## Exit codes

| Code | When                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------- |
| 0    | Every case passed; with `--compare`, no case got worse                                          |
| 1    | A case failed (with `--compare`: got worse), a case file didn't load, or `--case` named no case |
| 2    | A usage or config error: unknown option, missing config, missing baseline                       |

Colors are on in a terminal and off otherwise; `NO_COLOR` turns them off and `FORCE_COLOR` on.
