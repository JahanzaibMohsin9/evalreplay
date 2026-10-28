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
- **Phase 1 step 5, CarryPay example.** `examples/carrypay`: 16 cases (12 wake-up decisions across CarryPay's 4 scenarios, plus 4 end-to-end runs scored by CarryPay's own checks) that run CarryPay's agent offline from its recorded decisions in about 10 seconds. `pnpm run eval:broken` breaks `verify_beneficiary` and 5 cases fail with the step and the error. Live mode was checked against a local fake OpenAI server (model step recorded, no spend). Core gained case `vars` and tsconfig path aliases; the recorders take the SDK class to record every client. CI runs the example. Phase 1 is complete. Branch `carrypay-example`.
- **Found by the example:** CarryPay's curated pk-admission recording has a family message over its 800-character limit, which its gateway rejected (the model retried). CarryPay's own `evaluateRun` doesn't check for rejected tool calls.

### Next

Phase 2: `packages/github-action`, which runs the CLI, compares with the baseline from the main branch, and posts or updates one PR comment (pass rate, cost change, regressions, link to the report); then use it in CarryPay's CI and publish 0.1.0 to npm. Possible open-source follow-up: report the jiti Windows cache-key issue (aliased and relative imports of one file load twice).
