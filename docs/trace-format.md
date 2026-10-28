# Trace format

A trace is one recorded agent run: what went in, every model call and tool call, and what came out. Traces are stored as **JSONL**, one run per line, so recorders can append to a file while an agent runs and CI can stream large files.

The format is defined once in [`packages/core/src/trace.ts`](../packages/core/src/trace.ts) with zod. The same definition gives:

- TypeScript types: `import type { Trace } from '@evalreplay/core'`
- a validator: `parseTrace`, `parseTraces`, `readTraceFile`
- a JSON Schema (draft 2020-12) for other languages: [`packages/core/schema/trace.schema.json`](../packages/core/schema/trace.schema.json), also exported as `@evalreplay/core/trace.schema.json`

## Example

One line of a trace file, pretty-printed:

```json
{
  "schemaVersion": 1,
  "id": "run_01JB3K6Z0Q8N4V7X2C5M9T1R6D",
  "startedAt": "2026-10-24T10:00:00Z",
  "agent": { "name": "carrypay", "version": "3be9d34" },
  "input": {
    "messages": [{ "role": "user", "content": "Pay my son's tuition invoice to TU Munich" }]
  },
  "steps": [
    {
      "type": "llm",
      "provider": "openai",
      "model": "gpt-4.1-mini",
      "inputTokens": 812,
      "outputTokens": 140,
      "costUsd": 0.0012,
      "latencyMs": 900,
      "output": {
        "toolCalls": [
          {
            "id": "call_1",
            "name": "compare_routes",
            "args": { "amount": 1200, "currency": "EUR" }
          }
        ]
      }
    },
    {
      "type": "tool",
      "name": "compare_routes",
      "callId": "call_1",
      "args": { "amount": 1200, "currency": "EUR" },
      "result": { "cheapest": "bank_transfer", "feeEur": 4.5 },
      "error": null,
      "latencyMs": 340
    }
  ],
  "output": { "text": "The cheapest route is a bank transfer. It needs your approval." },
  "totals": {
    "costUsd": 0.0012,
    "latencyMs": 5400,
    "steps": 2,
    "inputTokens": 812,
    "outputTokens": 140
  },
  "metadata": { "tags": ["payments"] }
}
```

## Fields

### Run

| Field               | Type               | Required | Meaning                                       |
| ------------------- | ------------------ | -------- | --------------------------------------------- |
| `schemaVersion`     | `1`                | yes      | Format version, see [Versioning](#versioning) |
| `id`                | string             | yes      | Unique run id                                 |
| `startedAt`         | ISO 8601 date-time | yes      | With `Z` or an offset                         |
| `agent.name`        | string             | yes      | Which agent ran                               |
| `agent.version`     | string             | no       | e.g. the git SHA of the agent code            |
| `input.messages`    | Message[]          | yes      | What the agent was given                      |
| `steps`             | Step[]             | yes      | Model and tool calls, in order                |
| `output.text`       | string             | no       | The agent's final answer                      |
| `output.structured` | any                | no       | A structured final result                     |
| `totals`            | Totals             | yes      | Sums over the run                             |
| `error`             | Error              | no       | Set when the run itself failed                |
| `metadata.tags`     | string[]           | no       | Select cases and group reports                |

A **Message** has `role` (`system`, `user`, `assistant` or `tool`), `content` (a string, or an array of provider-specific parts), and optionally `name` and `toolCallId`.

An **Error** has `message` and an optional `type` (error class or code).

### Model call (`type: "llm"`)

| Field               | Type                    | Required | OpenTelemetry GenAI                        |
| ------------------- | ----------------------- | -------- | ------------------------------------------ |
| `provider`          | string                  | yes      | `gen_ai.provider.name`                     |
| `model`             | string                  | yes      | `gen_ai.request.model`                     |
| `inputTokens`       | integer ≥ 0             | yes      | `gen_ai.usage.input_tokens`                |
| `outputTokens`      | integer ≥ 0             | yes      | `gen_ai.usage.output_tokens`               |
| `cachedInputTokens` | integer ≥ 0             | no       |                                            |
| `costUsd`           | number ≥ 0              | no       | Left out when the model's price is unknown |
| `latencyMs`         | number ≥ 0              | yes      | span duration                              |
| `finishReason`      | string                  | no       | `gen_ai.response.finish_reasons[0]`        |
| `startedAt`         | date-time               | no       | span start                                 |
| `output.text`       | string                  | no       |                                            |
| `output.toolCalls`  | `{ id?, name, args }[]` | no       | the tool calls the model asked for         |

### Tool call (`type: "tool"`)

| Field       | Type            | Required | OpenTelemetry GenAI                                                          |
| ----------- | --------------- | -------- | ---------------------------------------------------------------------------- |
| `name`      | string          | yes      | `gen_ai.tool.name`                                                           |
| `callId`    | string          | no       | `gen_ai.tool.call.id`, matches a model `toolCalls[].id`                      |
| `args`      | object          | yes      | the arguments the tool received                                              |
| `result`    | any             | no       | what the tool returned; replay mode returns this instead of calling the tool |
| `error`     | Error or `null` | no       | set when the tool threw                                                      |
| `latencyMs` | number ≥ 0      | yes      | span duration                                                                |
| `startedAt` | date-time       | no       | span start                                                                   |

The field names follow the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) where one exists, so OTel traces can be imported later.

### Totals

| Field                         | Type        | Required | Meaning                                                                         |
| ----------------------------- | ----------- | -------- | ------------------------------------------------------------------------------- |
| `latencyMs`                   | number ≥ 0  | yes      | Wall time of the whole run                                                      |
| `steps`                       | integer ≥ 0 | yes      | Must equal `steps.length` (checked)                                             |
| `costUsd`                     | number ≥ 0  | no       | Left out if any model call has no cost, so an unknown price never looks cheaper |
| `inputTokens`, `outputTokens` | integer ≥ 0 | no       | Sums over the model calls                                                       |

`computeTotals(steps, latencyMs)` builds this object from the steps.

## Reading and writing

```ts
import { appendTrace, readTraceFile } from '@evalreplay/core';

await appendTrace('traces.jsonl', trace); // validates, then appends one line

const { traces, errors } = await readTraceFile('traces.jsonl');
for (const e of errors) console.warn(e.message); // "line 3: agent.name: Invalid input: ..."
```

Reading never stops at a bad line: valid traces are returned and each bad line becomes a `TraceParseError` with its 1-based line number and the failing field paths. Blank lines and CRLF line endings are fine.

## Versioning

Every trace carries `schemaVersion`. The rules:

- **Adding an optional field** keeps the version. Readers keep fields they don't know (every object is loose), so a trace written by a newer recorder survives being read and written again by an older evalreplay.
- **Renaming or removing a field, or changing what it means**, bumps the version. Readers keep accepting older versions.

The test in `trace.test.ts` compares the generated JSON Schema with the committed file, so a format change can't slip in unnoticed. After an intended change, run `pnpm test:update` and commit the updated schema with the change.
