# evalreplay report

**1 of 3 cases passed** · 3 of 5 runs passed (60%) · cost unknown · 125.4 s

| | Case | Mode | Passed | Cost | Average latency |
| --- | --- | --- | --- | --- | --- |
| ✅ | pay-tuition-eur | replay | 2/2 | $0.003 | 1.4 s |
| ❌ | refund-gbp | live | 1/3 | unknown | 40.5 s |
| ❌ | fx-quote | replay | could not run | – | – |

## Failures

### refund-gbp

`cases/payments/refund.yaml`

Refunds go back to the card they came from

Run 2 (trace `run_b`):

- `tool_not_called: execute_payment`: execute_payment was called once (step 4)
- `max_steps: 6`: 7 steps, over the limit of 6

Run 3 (trace `run_c`):

- The run failed: TimeoutError: the agent did not finish within 120000 ms

### fx-quote

`cases/fx.yaml`

- Could not run: from_trace run_gone is not in the trace files (`.evalreplay/traces/**/*.jsonl`)

## Files that could not be loaded

- cases/bad.yaml:4: assert.0: unknown assertion "max_cost" (did you mean max_cost_usd?)
