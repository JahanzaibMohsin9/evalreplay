# Test cases

A case is an input for your agent plus the assertions its run must pass. Write cases in YAML, or in TypeScript when you need a custom check.

```yaml
# cases/payments/pay-tuition.yaml
id: pay-tuition-eur
from_trace: run_01JB3K6Z0Q8N4V7X2C5M9T1R6D # recorded tool results, used as mocks
input:
  messages:
    - role: user
      content: "Pay my son's tuition invoice to TU Munich"
runs: 5 # agents vary: the report shows a pass rate
assert:
  - tool_called: compare_routes
  - tool_not_called: execute_payment # must wait for approval
  - tool_args_match: { tool: compare_routes, schema: ../schemas/compare_routes.json }
  - max_cost_usd: 0.25
  - max_steps: 12
  - output_contains: approval
```

## Fields

| Field         | Required | Meaning                                                                                                                          |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | yes      | Unique across all loaded cases. Letters, digits, `.`, `_`, `-`                                                                   |
| `input`       | yes      | A string (one user message) or `{ messages: [...] }` in the [trace format](trace-format.md)                                      |
| `assert`      | yes      | A list of assertions, one per item                                                                                               |
| `from_trace`  | no       | Id of a recorded trace; replay mode returns its tool results instead of calling the tools                                        |
| `mode`        | no       | `replay` (mock tools with recorded results) or `live` (call real tools). Default: `replay` when `from_trace` is set, else `live` |
| `runs`        | no       | How many times to run the case, 1 to 100. Default 1                                                                              |
| `description` | no       | Shown in reports                                                                                                                 |
| `tags`        | no       | Select cases and group reports                                                                                                   |

Case files are strict: a key the format doesn't know, such as a misspelled `asserts:`, is an error rather than being ignored.

## Assertions

Each list item holds exactly one assertion.

| Assertion         | Value                                       | Passes when                                                                     |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `tool_called`     | tool name, or `{ tool, times }`             | the tool was called (exactly `times` times, if given)                           |
| `tool_not_called` | tool name                                   | the tool was never called                                                       |
| `tool_order`      | list of at least two tool names             | the tools were called in this order (other calls may come in between)           |
| `tool_args_match` | `{ tool, schema }`                          | the tool was called, and every call has arguments valid against the JSON Schema |
| `output_contains` | text, or a list of texts                    | the final output contains every text                                            |
| `output_matches`  | regular expression, or `{ pattern, flags }` | the final output matches                                                        |
| `output_schema`   | JSON Schema                                 | the structured output (or the text output parsed as JSON) is valid against it   |
| `max_cost_usd`    | number                                      | the run cost at most this much; an unknown cost fails                           |
| `max_latency_ms`  | number                                      | the run took at most this long                                                  |
| `max_steps`       | integer                                     | the run had at most this many steps (model and tool calls)                      |
| `no_tool_errors`  | `true`                                      | no tool call threw                                                              |
| `custom`          | `{ name, check }` (TypeScript only)         | `check(trace)` returns `true`                                                   |

A `schema` is either a path to a JSON file, relative to the case file, or the schema written inline. Schema files are read and compiled when cases load, so a missing file or a broken schema is reported before anything runs. Schemas use JSON Schema 2020-12 unless `$schema` names draft-07 or 2019-09, and `format` (`email`, `date-time`, `uri`, ...) is checked. To use a zod schema in a `.case.ts` file, pass `z.toJSONSchema(schema)`.

The tool assertions look at the tool steps in the trace: the calls that actually ran, not the calls a model proposed.

An LLM-as-judge assertion (`judge`) will come later and will be marked as non-deterministic in reports.

## TypeScript cases

Name the file `*.case.ts` and export the case as the default export. It takes exactly the same fields as YAML, plus `custom` assertions:

```ts
// cases/fees.case.ts
import { defineCase } from '@evalreplay/core';

export default defineCase({
  id: 'explains-fees',
  input: 'How much does the transfer cost?',
  assert: [
    { max_steps: 6 },
    {
      custom: {
        name: 'mentions a fee',
        check: (trace) => /fee/i.test(trace.output.text ?? '') || 'the answer never mentions a fee',
      },
    },
  ],
});
```

A custom check returns `true` to pass, and `false` or a message to fail. It can be async. A file can also export an array of cases.

TypeScript cases load without a build step.

## One file, several cases

A YAML file can hold several cases, separated by `---`:

```yaml
id: greets-in-english
input: Hello
assert: [{ output_matches: { pattern: '^(hi|hello)', flags: i } }]
---
id: greets-in-urdu
input: السلام علیکم
assert: [{ output_contains: وعلیکم السلام }]
```

## Loading cases

```ts
import { loadCases } from '@evalreplay/core';

const { cases, errors } = await loadCases('cases/**/*.{yaml,yml,case.ts}');
for (const e of errors) console.error(e.message);
```

Loading never stops at the first problem: every case that loads is returned, and each problem is reported with its file, and its line for YAML:

```
cases/payments/pay-tuition.yaml:14: assert.3.max_cost_usd: Invalid input: expected number, received string
cases/payments/refund.yaml:9: assert.0: unknown assertion "max_cost" (did you mean max_cost_usd?)
cases/other.yaml: duplicate case id "pay-tuition-eur" (also in cases/payments/pay-tuition.yaml)
```

The loader also reports patterns that match no files, and YAML that doesn't parse.

## Checking a run

`evaluateCase` checks a case's assertions against the trace of one run and returns one result per assertion, in order:

```ts
import { evaluateCase } from '@evalreplay/core';

const result = await evaluateCase(testCase, trace);
for (const r of result.results) {
  console.log(r.pass ? 'pass' : 'FAIL', r.label, '-', r.message);
}
```

```
pass tool_called: compare_routes - compare_routes was called once (step 2)
FAIL tool_not_called: execute_payment - execute_payment was called once (step 4)
FAIL max_cost_usd: 0.25 - cost $0.31, over the $0.25 limit; most expensive: step 3 (gpt-4.1, $0.22)
```

Each result has the assertion, its `label`, `pass`, a `message` saying what was found, and, when one step broke the assertion, its `stepIndex` in `trace.steps` (messages count steps from 1). A case passes when every assertion passes and the run itself didn't fail: a trace with an `error` fails the case and the result carries it as `runError`.

Checking never throws. A custom check that throws, or returns something other than `true`, `false` or a message, is a failed assertion. Custom checks get a copy of the trace, so one can't change what the next assertion sees.
