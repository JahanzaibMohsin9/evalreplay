import { describe, expect, it } from 'vitest';
import { compareReports, renderComparison } from './compare.js';
import {
  type CaseReport,
  REPORT_VERSION,
  type Report,
  renderMarkdown,
  summarize,
} from './report.js';

/** A case with `passed` of `runs` passing runs, each costing `cost`. */
function kase(id: string, passed: number, runs: number, cost?: number, error?: string): CaseReport {
  return {
    id,
    file: `cases/${id}.yaml`,
    mode: 'replay',
    tags: [],
    pass: !error && passed === runs,
    passed,
    passRate: runs ? passed / runs : 0,
    ...(error ? { error } : {}),
    runs: Array.from({ length: runs }, (_, i) => ({
      run: i + 1,
      traceId: `run_${id}_${i}`,
      pass: i < passed,
      latencyMs: 100,
      ...(cost === undefined ? {} : { costUsd: cost }),
      steps: 2,
      assertions: [],
    })),
  };
}

const report = (startedAt: string, cases: CaseReport[]): Report => ({
  version: REPORT_VERSION,
  startedAt,
  durationMs: 1000,
  summary: summarize(cases),
  cases,
  errors: [],
});

const BASELINE = report('2026-10-27T09:00:00.000Z', [
  kase('pay', 5, 5, 0.01),
  kase('refund', 2, 4, 0.01),
  kase('fx', 3, 3, 0.002),
  kase('pricey', 1, 1, 0.01),
  kase('gone', 1, 1, 0.01),
]);

const CURRENT = report('2026-10-28T09:00:00.000Z', [
  kase('pay', 4, 5, 0.01),
  kase('refund', 4, 4, 0.0105),
  kase('fx', 0, 0, undefined, 'from_trace run_x is not in the trace files'),
  kase('pricey', 1, 1, 0.013),
  kase('new-case', 1, 1, 0.01),
]);

describe('compareReports', () => {
  it('finds the cases that got worse, better, added and removed', () => {
    const c = compareReports(BASELINE, CURRENT);
    expect(c.regressed.map((r) => [r.id, r.regressions])).toEqual([
      ['pay', ['pass rate 100% → 80%']],
      ['fx', ['could not run: from_trace run_x is not in the trace files']],
      ['pricey', ['cost per run $0.01 → $0.013 (+30%)']],
    ]);
    expect(c.improved.map((r) => r.id)).toEqual(['refund']); // +5% cost is within the limit
    expect(c.added).toEqual(['new-case']);
    expect(c.removed).toEqual(['gone']);
    expect(c.baseline).toMatchObject({ startedAt: '2026-10-27T09:00:00.000Z', passRate: 12 / 14 });
  });

  it('takes the cost limit as an option', () => {
    const c = compareReports(BASELINE, CURRENT, { maxCostIncrease: 0.5 });
    expect(c.regressed.map((r) => r.id)).toEqual(['pay', 'fx']);
  });

  it('ignores cost when either side is unknown', () => {
    const before = report('a', [kase('x', 1, 1)]);
    const after = report('b', [kase('x', 1, 1, 5)]);
    expect(compareReports(before, after).regressed).toEqual([]);
  });

  it('renders Markdown, inside report.md too', () => {
    const comparison = compareReports(BASELINE, CURRENT);
    const lines = renderComparison(comparison);
    expect(lines.slice(0, 3)).toEqual([
      '## Compared with the baseline',
      '',
      'Pass rate 86% → 91% · cost $0.116 → $0.115 (baseline from 2026-10-27T09:00:00.000Z)',
    ]);
    expect(lines).toContain('**3 cases got worse:**');
    expect(lines).toContain('- pricey: cost per run $0.01 → $0.013 (+30%)');
    expect(renderMarkdown({ ...CURRENT, comparison })).toContain('## Compared with the baseline');
    expect(renderComparison(compareReports(BASELINE, BASELINE))).toContain('No case got worse.');
  });
});
