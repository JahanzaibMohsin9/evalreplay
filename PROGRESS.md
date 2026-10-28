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

- **Phase 1.3 assertions.** `packages/core/src/assert.ts`: `evaluateCase`, `evaluateAssertions` and `evaluateAssertion` check every assertion from PLAN.md 3.3 except `judge` against a trace, with a message per assertion and the index of the step that broke it. `src/schema.ts` compiles JSON Schemas with Ajv; the loader now rejects a schema that doesn't compile. Merged #1; this is on branch `assertions`.

### Next

Phase 1.4 in `packages/core`: the runner. Call the user's agent for each case `runs` times (with a concurrency limit), mock tools with the `from_trace` results in replay mode, record a trace per run, check it with `evaluateCase`, and write `report.json` and `report.md`.
