# GitHub Action

Runs your cases on every pull request, compares them with the baseline on the base branch, and keeps one comment on the pull request up to date:

> ## ❌ evalreplay
>
> **15 of 16 cases passed** · 15 of 16 runs (94%) · cost unknown · 10.3 s
>
> Compared with `main` (3e80525): pass rate 94% → 63%.
>
> **5 cases got worse:**
>
> | Case               | Before | After | Why                 |
> | ------------------ | ------ | ----- | ------------------- |
> | th-deposit-invoice | 100%   | 0%    | pass rate 100% → 0% |
>
> ▸ 6 failing cases
>
> [Full report](#) · evalreplay

## Setup

1. Install evalreplay in the project (`pnpm add -D evalreplay`) and add `evalreplay.config.ts` and some cases.
2. On the main branch, run the cases, keep the report as the baseline and commit it:

   ```bash
   npx evalreplay run
   npx evalreplay baseline save   # writes .evalreplay/baseline.json
   ```

3. Add a workflow:

   ```yaml
   # .github/workflows/evalreplay.yml
   name: evalreplay
   on: pull_request

   permissions:
     contents: read
     pull-requests: write # to comment

   jobs:
     evalreplay:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 24 }
         - run: npm ci
         - uses: JahanzaibMohsin9/evalreplay@v0
           env:
             # the agent's model runs for real, in replay mode too (only the tools are mocked)
             OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
   ```

The action fails the check when the CLI does: when a case got worse than the baseline, a case file didn't load, or the pass rate is below `minPassRate` in the config. A case that also failed on the base branch doesn't fail the check, since agents vary from run to run.

## Inputs

| Input               | Default                       | Meaning                                                                                         |
| ------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `working-directory` | `.`                           | The folder with `evalreplay.config.ts`                                                          |
| `command`           | `npx --no-install evalreplay` | How to run the project's evalreplay CLI                                                         |
| `args`              |                               | More arguments for `evalreplay run`, e.g. `--tag smoke`                                         |
| `baseline`          | `.evalreplay/baseline.json`   | The saved baseline, relative to `working-directory`                                             |
| `max-cost-increase` |                               | A rise in a case's cost per run above this percentage counts as worse (the CLI's default is 20) |
| `comment`           | `true`                        | Comment on the pull request                                                                     |
| `github-token`      | `github.token`                | Reads the baseline and comments; needs `pull-requests: write` to comment                        |

Outputs: `pass-rate`, `cases`, `cases-passed`, `regressions`, `cost-usd` (when known) and `report-dir`, the folder with `report.json`, `report.md` and `traces.jsonl`, for example to upload with `actions/upload-artifact`.

## How it works

- **Your project's evalreplay:** the action runs the project's own `evalreplay` CLI, not a copy of its own, because your recorders find the run through that same install of `@evalreplay/core`.
- **The baseline from the base commit:** on a pull request, the baseline is read through the GitHub API at the pull request's base commit, so a pull request can't change what it is compared with. On a push, it uses the baseline in the working tree.
- **One comment:** it is marked, and later runs update it rather than adding new ones.
- **Forks:** the token of a pull request from a fork can't comment. The action then warns instead of failing, and the results are in the job summary.
- **The job summary** always gets the comment and the full `report.md`.

evalreplay's own CI runs this action on the [CarryPay example](../examples/carrypay) for every pull request.
