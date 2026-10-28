# Project plan: agent traces → tests in CI

Name: **evalreplay** (npm `evalreplay` and scope `@evalreplay`, PyPI `evalreplay` and GitHub org `evalreplay` were all free on 28 Oct 2026; the first working name, traceproof, lost its npm scope and GitHub org to others). The local folder is still `D:\Projects\traceproof`.

## 1. What we are building

An open-source tool that turns what an AI agent actually did into repeatable tests that run in CI.

1. **Record** an agent run as a trace: model calls, tool calls with arguments and results, tokens, cost, latency, final output.
2. **Turn traces into test cases** with assertions (right tool called, valid arguments, cost under a limit, and so on).
3. **Re-run the cases on every pull request** and post a comment with pass rate, cost change and anything that got worse versus the baseline.

### Why this project

- Job ads ask for exactly this: Apify ("evals that turn real production traces into tests, catch regressions in CI"), Mastra (trace tooling, evals, tuning agents), n8n (benchmarks, quality signals, PR evidence), Supabase (agent execution, logging).
- It has real users (other developers), so stars, downloads and issues become proof.
- It fills every gap from the job search: GitHub Actions / CI, open source, AWS, Python agent frameworks, monorepo experience.

### Rules for the build

- TypeScript first (Node 22+, strict mode; Node 20 reached end of life in April 2026). Python package in phase 3.
- Every package has tests (Vitest; pytest for Python). CI must stay green.
- Keep the trace format stable and documented; everything else can change.
- No secrets in the repo. Use `.env.example` and GitHub Actions secrets.
- Small commits with clear messages. One feature per pull request, even when working alone.

## 2. Repository layout

```
evalreplay/
├── PLAN.md                     # this file
├── PROGRESS.md                 # running log: what was done, what's next (update every session)
├── README.md
├── package.json                # pnpm workspaces root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .github/
│   └── workflows/
│       ├── ci.yml              # lint, typecheck, test on every push/PR
│       └── release.yml         # publish to npm on tag
├── packages/
│   ├── core/                   # trace schema, case format, assertions, runner, reports
│   ├── cli/                    # `evalreplay` command
│   ├── recorder-openai/        # wraps the OpenAI SDK to record traces
│   ├── recorder-anthropic/     # wraps the Anthropic SDK (CarryPay's agent uses both)
│   ├── recorder-ai-sdk/        # Vercel AI SDK middleware recorder
│   ├── mcp/                    # test any MCP server's tools
│   └── github-action/          # GitHub Action that runs cases and comments on PRs
├── python/
│   └── evalreplay/             # pytest plugin + LangGraph recorder (phase 3)
├── apps/
│   └── dashboard/              # Next.js results dashboard (phase 4)
├── infra/                      # AWS CDK (or Terraform) for the dashboard (phase 4)
├── examples/
│   ├── carrypay/               # real cases from CarryPay's 45 eval runs
│   └── mastra/                 # example with a Mastra agent (phase 3)
└── docs/
    ├── trace-format.md
    ├── assertions.md
    └── github-action.md
```

## 3. Core design

### 3.1 Trace format (JSONL, one run per line)

Align field names with the OpenTelemetry GenAI semantic conventions (`gen_ai.*`) so OTel traces can be imported later.

```jsonc
{
  "id": "run_01H...",
  "startedAt": "2026-10-24T10:00:00Z",
  "agent": { "name": "carrypay", "version": "git-sha" },
  "input": { "messages": [ ... ] },
  "steps": [
    { "type": "llm", "model": "gpt-4.1-mini", "provider": "openai",
      "inputTokens": 812, "outputTokens": 140, "costUsd": 0.0012, "latencyMs": 900 },
    { "type": "tool", "name": "compare_routes",
      "args": { "amount": 1200, "currency": "EUR" },
      "result": { ... }, "error": null, "latencyMs": 340 }
  ],
  "output": { "text": "...", "structured": { ... } },
  "totals": { "costUsd": 0.08, "latencyMs": 5400, "steps": 7 },
  "metadata": { "tags": ["payments"] }
}
```

Define it once with **zod** in `packages/core/src/trace.ts` and export the TypeScript types and a JSON Schema.

### 3.2 Test case format

A case = an input + assertions, optionally created from a recorded trace (`evalreplay capture <trace-id>`).

```yaml
# cases/payments/pay-tuition.yaml
id: pay-tuition-eur
from_trace: run_01H...          # optional: recorded tool results used as mocks
input:
  messages:
    - role: user
      content: "Pay my son's tuition invoice to TU Munich"
mode: replay                    # replay = mock tools with recorded results; live = call real tools
runs: 5                         # agents are non-deterministic: report a pass rate
assert:
  - tool_called: compare_routes
  - tool_not_called: execute_payment          # must wait for approval
  - tool_args_match: { tool: compare_routes, schema: ./schemas/compare_routes.json }
  - max_cost_usd: 0.25
  - max_steps: 12
  - output_contains: "approval"
  - judge: { rubric: "Explains fees clearly", min_score: 4 }   # optional LLM judge
```

Cases can also be written in TypeScript (`*.case.ts`) for custom assertion functions.

### 3.3 Assertions (packages/core/src/assertions/)

Start with: `tool_called`, `tool_not_called`, `tool_order`, `tool_args_match` (JSON Schema / zod), `output_contains`, `output_matches` (regex), `output_schema`, `max_cost_usd`, `max_latency_ms`, `max_steps`, `no_tool_errors`, `custom` (function). Add `judge` (LLM-as-judge, pluggable model) later and mark it as non-deterministic in reports.

### 3.4 Runner

- Loads cases, runs each `runs` times (with a concurrency limit), records a new trace per run.
- Replay mode: the agent runs for real, but tool calls return the recorded results (deterministic tools, real model).
- Live mode: real model and real tools (for nightly runs, not every PR).
- Output: `report.json` (machine) and `report.md` (human): pass rate per case, cost and latency totals, failures with the exact assertion and step that failed.
- Baseline: `evalreplay baseline save` writes `.evalreplay/baseline.json`; `evalreplay run --compare baseline` reports regressions (pass rate dropped, cost up more than X%).

### 3.5 How users connect their agent

Users export one function the runner can call:

```ts
// evalreplay.config.ts
import { defineConfig } from "@evalreplay/core";
import { runAgent } from "./src/agent";

export default defineConfig({
  cases: "cases/**/*.yaml",
  agent: async (input, ctx) => runAgent(input, { tools: ctx.wrapTools(myTools) }),
});
```

`ctx.wrapTools` handles recording and, in replay mode, mocking.

## 4. Phases

Assume about 30 hours a week. Each phase ends with a tagged release and an entry in PROGRESS.md.

### Phase 0: quick wins in existing repos (2–3 days, do first)

1. **CarryPay CI:** add `.github/workflows/ci.yml` that installs, typechecks, runs tests on every push and pull request, and runs a small eval subset. Add the CI badge to the README.
   - Done when: badge is green on main; a PR shows the checks.
2. **Pick an open-source issue:** find a "good first issue" in Mastra or LiveKit `agents-js`. Comment to claim it. (Work on it in parallel with phase 1; aim for a merged PR by 14 November.)
3. **Pin repos on GitHub:** CarryPay, ScopeSignal, and later evalreplay, each with a clear README (what, why, demo, how to run, how it's tested).

### Phase 1: core + CLI (week 1)

1. Monorepo setup: pnpm workspaces, `tsconfig.base.json`, ESLint, Prettier, Vitest, `ci.yml`.
2. `packages/core`: trace schema (zod), case loader (YAML + TS), assertions from 3.3 except `judge`, runner with replay mode, `report.json` and `report.md`.
3. `packages/recorder-openai` and `packages/recorder-anthropic`: wrap each client so every call and tool call is recorded to a trace. CarryPay's agent loop calls both SDKs, so the example needs both.
4. `packages/cli`: `evalreplay run`, `evalreplay capture <trace-id>`, `evalreplay baseline save`, `evalreplay run --compare baseline`.
5. `examples/carrypay`: convert at least 10 of CarryPay's 45 eval cases.
   - Done when: `pnpm evalreplay run` in `examples/carrypay` prints a pass rate, and a deliberately broken tool makes a case fail with a clear message.

### Phase 2: GitHub Action (week 2)

1. `packages/github-action`: runs the CLI, compares with the baseline from the main branch, and posts or updates one PR comment (pass rate, cost change, regressions, link to full report).
2. Exit code fails the check when pass rate drops below a threshold set in config.
3. Use it in CarryPay's CI (replay mode on PRs, live mode nightly with a cost cap).
4. Publish `0.1.0` to npm and the Action to the GitHub Marketplace.
   - Done when: a PR to CarryPay that breaks a tool gets a red check and a clear comment.

### Phase 3: integrations (week 3)

1. `packages/recorder-ai-sdk`: Vercel AI SDK middleware recorder.
2. Mastra example in `examples/mastra` (and, if it fits, a small docs or example PR to Mastra itself = open-source contribution).
3. `packages/mcp`: `evalreplay mcp --server "<command>"` lists the server's tools, runs cases that call them, and validates input and output schemas.
4. `python/evalreplay`: same trace format; LangGraph callback recorder; pytest plugin (`pytest --evalreplay`). Publish to PyPI.
   - Done when: the same YAML case format works from TypeScript and Python.

### Phase 4: dashboard on AWS + launch (week 4)

1. `apps/dashboard`: Next.js app that shows runs over time, pass rate per case, cost trends, and trace detail (step by step).
2. Upload from CI: `evalreplay run --upload` with an API key.
3. `infra/`: AWS CDK (or Terraform):
   - API: Lambda (or a small container on ECS Fargate)
   - Storage: S3 for raw traces, Postgres (RDS) or DynamoDB for run summaries
   - Keep it inside the free tier where possible; set a billing alarm on day one.
4. Docs site (README + `docs/`), a 2-minute screen-recorded demo (no face needed).
5. Launch: Show HN, r/LocalLLaMA or r/MachineLearning (follow each subreddit's rules), X/LinkedIn post, and the Mastra/LangChain community channels.
   - Done when: public repo, npm + PyPI packages, Marketplace Action, live dashboard URL, and at least one person outside you has run it.

## 5. After launch: how this goes on the CV

- New top project line: what it does, packages published, GitHub Action, stars/downloads, AWS deployment.
- Merged PRs to Mastra / LiveKit / others listed under "Open source".
- Skills: add GitHub Actions, AWS (Lambda, S3, RDS/DynamoDB, CDK), monorepos, pytest plugins.

## 6. Working with Claude Code

- Start each session with: "Read PLAN.md and PROGRESS.md. Continue with the next unfinished task."
- End each session by updating PROGRESS.md: done, decisions made, next step.
- One phase task per session; run tests before every commit.
- When a design question comes up that this plan doesn't answer, write the decision into PLAN.md so it stays consistent.

## 7. Checklist

- [x] Phase 0.1 CarryPay CI badge green
- [x] Phase 0.2 Open-source issue claimed (livekit/agents-js#1983, PR #2884 open)
- [ ] Phase 0.3 Pinned repos with clean READMEs
- [ ] Phase 1 Core + CLI, CarryPay example passing
- [ ] Phase 2 GitHub Action, v0.1.0 on npm and Marketplace
- [ ] Phase 3 AI SDK recorder, Mastra example, MCP mode, Python package
- [ ] Phase 4 Dashboard on AWS, docs, demo, launch
- [ ] First merged open-source PR (target: 14 Nov 2026)

## 8. Decisions

Design questions this plan didn't answer, decided as they came up.

- **28 Oct 2026, name:** renamed traceproof → evalreplay (see the top of this file).
- **28 Oct 2026, open source target:** Mastra disabled pull requests from outside contributors (their CONTRIBUTING.md asks for issues instead), so phase 0.2 targets LiveKit `agents-js`, which merges outside PRs within days.
- **28 Oct 2026, Anthropic recorder:** added `recorder-anthropic` to phase 1, because CarryPay's agent loop calls both the OpenAI and Anthropic SDKs.
- **28 Oct 2026, toolchain:** Node 22+, pnpm 12, TypeScript 6.0 (typescript-eslint does not support TypeScript 7 yet), zod 4 (its built-in `z.toJSONSchema` generates the JSON Schema), Vitest 5, ESLint 10 flat config, Prettier.
- **28 Oct 2026, trace format versioning:** every trace line carries `schemaVersion: 1`. Additive optional fields keep the version; renaming or removing a field, or changing its meaning, bumps it, and readers keep accepting older versions.
- **28 Oct 2026, case format:** YAML and `*.case.ts` share one snake_case shape (the plan's `from_trace`, `tool_called`), so a case moves between them unchanged; the loader normalizes both into one camelCase `Case` for the runner. Case files are strict (unknown keys are errors) while traces stay loose. `mode` defaults to `replay` when `from_trace` is set, else `live`; `replay` without `from_trace` is an error. Schema files referenced by assertions are read at load time, so a missing file fails before anything runs. A YAML file may hold several cases as `---` documents. `.case.ts` files load through jiti (no build step).
- **28 Oct 2026, assertion values:** `tool_order` checks order as a subsequence (other calls may come in between); `tool_called` takes an optional exact `times`; `output_contains` takes one text or a list; `output_matches` takes a pattern or `{ pattern, flags }`. `judge` is left out until phase 1's runner exists.
- **28 Oct 2026, checking assertions:** each assertion gives a result with a message and, when one step broke it, that step's index. Tool assertions count tool steps (calls that ran), not calls the model proposed. `tool_args_match` fails when the tool was never called, since a case that checks a tool's arguments expects the call. `output_schema` falls back to the text output parsed as JSON when there is no structured output. An unknown cost fails `max_cost_usd`, as in `computeTotals`. A run whose trace has an `error` fails its case even if every assertion passed. JSON Schema validation uses Ajv (2020-12 by default; draft-07 and 2019-09 by `$schema`; strict mode off, because provider tool schemas carry extra keys) with ajv-formats, and schemas are compiled at load time. zod schemas are passed through `z.toJSONSchema` rather than accepted directly. The code is in `src/assert.ts` and `src/schema.ts`, not the `src/assertions/` folder 3.3 names.
- **28 Oct 2026, runner:** the config is `evalreplay.config.ts` (loaded through jiti, strict like case files, paths relative to it). Besides `wrapTools` from 3.5, the run context has `wrapTool(name, fn)` and `callTool(name, args, call)`, because agents like CarryPay's dispatch tools by name through one function; a wrapped sync tool stays sync. Replay picks the first unused recorded call to the tool with equal arguments, else the next unused one in recorded order (models reword arguments between runs); a call with nothing left throws `ReplayMissError`, and unwrapped tools still run for real. With no model calls recorded the cost is unknown, not $0, so `max_cost_usd` fails until a recorder is added. A run fails on any failed assertion, a thrown error or a timeout (default 2 minutes, which also aborts `ctx.signal`); a case passes only when every run passes, and a replay case whose `from_trace` is missing fails without running. Runs go 4 at a time by default, and the report keeps case and run order. `writeReport` writes `report.json`, `report.md` and `traces.jsonl` (every run's trace, for `capture` and debugging) to `.evalreplay/report`.
- **28 Oct 2026, recorders:** a recorder patches the client it is given (`recordOpenAI(new OpenAI())`) and returns it, rather than wrapping it in a proxy, so SDK types and helpers stay intact. It finds the run through `AsyncLocalStorage` (`currentRun()` in core), so a client wrapped once at startup records into whichever run makes each call, and records nothing outside a run. Only `create` is wrapped (`messages`/`beta.messages` for Anthropic, `chat.completions`/`responses` for OpenAI) because the SDKs' `stream()`, `parse()`, `runTools()` and tool runner all call it. The recorder never awaits the SDK's promise itself, since that would read the HTTP body before `parse()` could; it watches the promise's own parse step instead, and observes streams as the agent reads them. `inputTokens` counts cached tokens too (Anthropic reports them separately, OpenAI includes them), with the new optional `cacheWriteInputTokens` and `error` on model steps. The Anthropic recorder ships Claude list prices dated 6 Oct 2026; the OpenAI recorder ships none, since those prices are not something we can check, so OpenAI-compatible prices come from the config (`prices`) or the recorder options, and an unpriced call leaves the cost unknown. A failed request costs 0. The SDKs are peer dependencies; tests run against the SDK versions CarryPay uses (openai 7.33.0, @anthropic-ai/sdk 0.133.0) through a fake `fetch`, so they need no API key.
- **28 Oct 2026, CLI:** the CLI package is the unscoped `evalreplay`, so `npx evalreplay run` works; it has no argument-parsing dependency (`node:util` `parseArgs`). A baseline is a saved `report.json`, and `compareReports` lives in core so the GitHub Action can reuse it. A case got worse when its pass rate dropped, when it could run before and can't now, or when its average cost per run rose more than 20% (`--max-cost-increase`); new and removed cases are listed but don't count. Without `--compare`, `run` exits 1 when any case fails; with it, only when a case got worse, since agents vary and a known-flaky case shouldn't block every PR. Load errors always exit 1, usage and config errors 2. `capture` writes assertions that describe the run (tools called, their first-call order, no tool errors, 1.5× the steps and cost rounded up), marked in the file as a starting point to edit, and copies a trace from the last run's `traces.jsonl` to `.evalreplay/traces/captured.jsonl`, because the next run overwrites `traces.jsonl`.
