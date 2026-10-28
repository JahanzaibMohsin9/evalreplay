# Progress

Running log for evalreplay (see PLAN.md). Newest entry first. Each entry: what was done, decisions, next step.

## 28 Oct 2026

### Done

- **Phase 0.1 CarryPay CI.** `.github/workflows/ci.yml` in CarryPay runs install, `next typegen` + `tsc`, ESLint, the 88 unit tests and a new offline eval (`npm run eval:replay`: replays the four curated live runs in `recordings/` and scores them with `evaluateRun`, no API key). Merged in JahanzaibMohsin9/carrypay#1; the badge is green on main. Repo About box filled in; `main` is protected by a ruleset requiring the `check` job.
- **Phase 0.2 open-source issue.** Claimed livekit/agents-js#1983 (skipped `minWords` backchannels add up and interrupt the agent, and prefix the next turn). Fix in livekit/agents-js#2884 from the fork `JahanzaibMohsin9/agents-js`, branch `fix/drop-skipped-minwords-transcript`, local clone `D:\Projects\agents-js`. CLA signed; four Devin review findings fixed and marked resolved. Waiting for a maintainer to approve CI and review.
- **Phase 1 start.** Renamed the project to evalreplay. Monorepo set up (pnpm workspaces, TypeScript, ESLint, Prettier, Vitest, CI). `packages/core` has the trace schema: zod definitions, TypeScript types, JSONL reading and writing, and the generated JSON Schema, with tests. Trace format documented in `docs/trace-format.md`.

### Decisions

Recorded in PLAN.md section 8: the evalreplay name, LiveKit instead of Mastra, the Anthropic recorder, the toolchain versions and trace format versioning.

### Open

- CarryPay's GitHub sidebar still lists @claude as a contributor from old cached commits; only GitHub Support can refresh it.
- Register the names before someone else does: npm org `evalreplay`, PyPI project `evalreplay`, GitHub org `evalreplay` (needs your accounts).
- Phase 0.3: ScopeSignal README and CI; pin the repos on the GitHub profile.

- **Phase 1.2 case format.** `packages/core/src/cases.ts` (case schema, assertion specs, `defineCase`, normalization) and `load.ts` (`loadCases` / `loadCaseFile` for YAML and `*.case.ts`, errors with file and line, duplicate ids, patterns with no match). Documented in `docs/cases.md`. CI badge in the README. Branch `case-format`.

- **Phase 1.3 assertions.** `packages/core/src/assert.ts`: `evaluateCase`, `evaluateAssertions` and `evaluateAssertion` check every assertion from PLAN.md 3.3 except `judge` against a trace, with a message per assertion and the index of the step that broke it. `src/schema.ts` compiles JSON Schemas with Ajv; the loader now rejects a schema that doesn't compile. Merged in #2.
- **Phase 1.4 runner.** `packages/core`: `defineConfig` / `loadConfig` (`src/config.ts`), the run context with tool recording and replay from `from_trace` (`src/context.ts`), `runCases` with concurrency, timeouts and a pass rate per case (`src/run.ts`), and `report.json`, `report.md` and `traces.jsonl` (`src/report.ts`). Documented in `docs/running.md`. Merged in #3.
- **Phase 1 step 3, recorders.** `packages/recorder-openai` (Chat Completions, Responses, OpenAI-compatible providers such as DeepSeek) and `packages/recorder-anthropic` (Messages and beta Messages, with Claude list prices). Both record streamed and failed calls. Core gained `currentRun()`, `prices` in the config and shared recording helpers (`src/recording.ts`). Documented in `docs/recorders.md`. Merged in #4.
- **Phase 1 step 4, CLI.** `packages/cli` (npm `evalreplay`): `run` with `--case`/`--tag`/`--compare`, `capture <trace-id>` and `baseline save`, with progress lines, a failure summary and exit codes. Core gained `compareReports` (also rendered into `report.md`), `readReport` and `loadTraces`. Documented in `docs/cli.md`. Merged in #5.
- **Phase 1 step 5, CarryPay example.** `examples/carrypay`: 16 cases (12 wake-up decisions across CarryPay's 4 scenarios, plus 4 end-to-end runs scored by CarryPay's own checks) that run CarryPay's agent offline from its recorded decisions in about 10 seconds. `pnpm run eval:broken` breaks `verify_beneficiary` and 5 cases fail with the step and the error. Live mode was checked against a local fake OpenAI server (model step recorded, no spend). Core gained case `vars` and tsconfig path aliases; the recorders take the SDK class to record every client. CI runs the example. Phase 1 is complete. Merged in #6.
- **Phase 2 steps 1 and 2, GitHub Action.** `packages/github-action` with the root `action.yml`: runs the project's CLI, reads the baseline at the pull request's base commit, comments once (updated on later runs), writes the job summary and outputs, and fails as the CLI does. `minPassRate` in the config is the threshold. evalreplay's CI runs it on the CarryPay example. Documented in `docs/github-action.md`. Merged in #7; its first real comment appeared on #7.
- **Phase 2 step 4, ready to release 0.1.0.** The four packages are at 0.1.0 with npm metadata, READMEs and the LICENSE; the recorders take core as a peer dependency and the current run is shared through `globalThis`. `.github/workflows/release.yml` publishes on a `v*.*.*` tag. The packed tarballs, installed in a fresh project, ran a TypeScript config with a recorder end to end (one copy of core). Steps for the first release in `docs/releasing.md`. Branch `release-0.1.0`.
- **Found by the example:** CarryPay's curated pk-admission recording has a family message over its 800-character limit, which its gateway rejected (the model retried). CarryPay's `evaluateRun` counts rejected calls in `metrics.toolErrors`, but no check fails on them and its eval output didn't show them. Fixed in JahanzaibMohsin9/carrypay#2: the four long text fields whose descriptions didn't say their limit now do, a test keeps it that way, and `scripts/eval.mjs` shows rejected calls. The recording itself is unchanged (it is a record of a real run), so the example's baseline keeps the known failure until it is re-recorded live.

### Next

The first release (`docs/releasing.md`): create the npm organization `evalreplay`, add an `NPM_TOKEN` secret, push the `v0.1.0` tag, and tick Marketplace on the release. Then phase 2 step 3: the action in CarryPay's CI (replay mode on pull requests, live mode nightly with a cost cap, which needs a model API key as a CarryPay secret). Possible open-source follow-up: report the jiti Windows cache-key issue (aliased and relative imports of one file load twice).
