import { describe, expect, it } from 'vitest';
import {
  type CaseReport,
  REPORT_VERSION,
  type Report,
  renderMarkdown,
  summarize,
} from './report.js';

const cases: CaseReport[] = [
  {
    id: 'pay-tuition-eur',
    file: 'cases/payments/pay-tuition.yaml',
    mode: 'replay',
    tags: ['payments'],
    pass: true,
    passed: 2,
    passRate: 1,
    runs: [1, 2].map((run) => ({
      run,
      traceId: `run_${run}`,
      pass: true,
      latencyMs: 1200 + run * 100,
      costUsd: 0.0015,
      steps: 4,
      assertions: [
        {
          label: 'tool_called: compare_routes',
          pass: true,
          message: 'compare_routes was called once (step 2)',
        },
      ],
    })),
  },
  {
    id: 'refund-gbp',
    description: 'Refunds go back to the card they came from',
    file: 'cases/payments/refund.yaml',
    mode: 'live',
    tags: [],
    pass: false,
    passed: 1,
    passRate: 1 / 3,
    runs: [
      {
        run: 1,
        traceId: 'run_a',
        pass: true,
        latencyMs: 640,
        costUsd: 0.002,
        steps: 3,
        assertions: [],
      },
      {
        run: 2,
        traceId: 'run_b',
        pass: false,
        latencyMs: 880,
        costUsd: 0.004,
        steps: 7,
        assertions: [
          {
            label: 'tool_not_called: execute_payment',
            pass: false,
            message: 'execute_payment was called once (step 4)',
            stepIndex: 3,
          },
          {
            label: 'max_steps: 6',
            pass: false,
            message: '7 steps, over the limit of 6',
            stepIndex: 6,
          },
        ],
      },
      {
        run: 3,
        traceId: 'run_c',
        pass: false,
        latencyMs: 120000,
        steps: 1,
        error: { type: 'TimeoutError', message: 'the agent did not finish within 120000 ms' },
        assertions: [],
      },
    ],
  },
  {
    id: 'fx-quote',
    file: 'cases/fx.yaml',
    mode: 'replay',
    tags: [],
    pass: false,
    passed: 0,
    passRate: 0,
    error: 'from_trace run_gone is not in the trace files (`.evalreplay/traces/**/*.jsonl`)',
    runs: [],
  },
];

const report: Report = {
  version: REPORT_VERSION,
  startedAt: '2026-10-28T12:00:00.000Z',
  durationMs: 125400,
  summary: summarize(cases),
  cases,
  errors: ['cases/bad.yaml:4: assert.0: unknown assertion "max_cost" (did you mean max_cost_usd?)'],
};

describe('report', () => {
  it('summarizes runs and leaves out an unknown total cost', () => {
    expect(report.summary).toEqual({
      cases: 3,
      casesPassed: 1,
      runs: 5,
      runsPassed: 3,
      passRate: 0.6,
    });
    const known = summarize(cases.slice(0, 1));
    expect(known.costUsd).toBeCloseTo(0.003);
  });

  it('renders Markdown', async () => {
    await expect(renderMarkdown(report)).toMatchFileSnapshot('__snapshots__/report.md');
  });
});
