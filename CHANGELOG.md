# Changelog

## 0.1.0

The first release: record what an AI agent did, turn it into test cases, and run them in CI.

- **`evalreplay`**, the command line: `run` (with `--case`, `--tag` and `--compare baseline`), `capture <trace-id>` to turn a recorded run into a case, and `baseline save`. Exit codes for CI, and `minPassRate` in the config as the threshold.
- **`@evalreplay/core`**: the trace format (JSONL, `schemaVersion: 1`, aligned with the OpenTelemetry GenAI fields), test cases in YAML or `*.case.ts`, 12 assertions plus `custom`, the runner with replay mode (tools return the results recorded in `from_trace`), `report.json`, `report.md` and `traces.jsonl`, and comparing a report with a baseline.
- **`@evalreplay/recorder-openai`**: records Chat Completions and Responses calls, streamed or not, including OpenAI-compatible providers such as DeepSeek.
- **`@evalreplay/recorder-anthropic`**: records Messages calls, streamed or not, priced at Claude's list prices.
- **The GitHub Action** (`uses: JahanzaibMohsin9/evalreplay@v0`): runs the cases on a pull request, compares them with the baseline on the base branch, and keeps one comment up to date.
- **An example**, [`examples/carrypay`](https://github.com/JahanzaibMohsin9/evalreplay/tree/main/examples/carrypay): 16 cases run against CarryPay's payment agent, offline.
