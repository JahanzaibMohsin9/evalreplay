import { type CaseReport, type Report, totalCost } from './report.js';

/** A case's numbers in one report. */
export interface CaseNumbers {
  passRate: number;
  runs: number;
  /** Average cost of a run; omitted when unknown. */
  costPerRunUsd?: number;
  /** The case could not run (e.g. its from_trace was missing). */
  error?: string;
}

export interface CaseChange {
  id: string;
  before?: CaseNumbers;
  after?: CaseNumbers;
  /** Why the case counts as worse; empty when it isn't. */
  regressions: string[];
}

export interface Comparison {
  baseline: { startedAt: string; passRate: number; costUsd?: number };
  current: { startedAt: string; passRate: number; costUsd?: number };
  /** Cases that got worse, in report order. */
  regressed: CaseChange[];
  /** Cases whose pass rate went up. */
  improved: CaseChange[];
  added: string[];
  removed: string[];
}

export interface CompareOptions {
  /** A rise in a case's cost per run above this fraction is a regression. Default: 0.2 (20%). */
  maxCostIncrease?: number;
}

function numbers(c: CaseReport): CaseNumbers {
  const cost = c.runs.length ? totalCost(c.runs) : undefined;
  return {
    passRate: c.passRate,
    runs: c.runs.length,
    ...(cost === undefined ? {} : { costPerRunUsd: cost / c.runs.length }),
    ...(c.error === undefined ? {} : { error: c.error }),
  };
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const usd = (n: number) => `$${n.toFixed(6).replace(/\.?0+$/, '') || '0'}`;

/**
 * Compares a report with a baseline report, case by case. A case regressed when its pass rate
 * dropped, when it could run before and can't now, or when its cost per run rose more than
 * `maxCostIncrease`.
 */
export function compareReports(
  baseline: Report,
  current: Report,
  options: CompareOptions = {},
): Comparison {
  const maxIncrease = options.maxCostIncrease ?? 0.2;
  const before = new Map(baseline.cases.map((c) => [c.id, numbers(c)]));
  const regressed: CaseChange[] = [];
  const improved: CaseChange[] = [];

  for (const c of current.cases) {
    const was = before.get(c.id);
    if (!was) continue;
    const now = numbers(c);
    const reasons: string[] = [];
    if (now.error !== undefined && was.error === undefined)
      reasons.push(`could not run: ${now.error}`);
    else if (now.passRate < was.passRate) {
      reasons.push(`pass rate ${percent(was.passRate)} → ${percent(now.passRate)}`);
    }
    if (
      was.costPerRunUsd !== undefined &&
      now.costPerRunUsd !== undefined &&
      now.costPerRunUsd > was.costPerRunUsd * (1 + maxIncrease)
    ) {
      const rise =
        was.costPerRunUsd > 0 ? ` (+${percent(now.costPerRunUsd / was.costPerRunUsd - 1)})` : '';
      reasons.push(`cost per run ${usd(was.costPerRunUsd)} → ${usd(now.costPerRunUsd)}${rise}`);
    }
    const change = { id: c.id, before: was, after: now, regressions: reasons };
    if (reasons.length) regressed.push(change);
    else if (now.passRate > was.passRate) improved.push(change);
  }

  const ids = new Set(current.cases.map((c) => c.id));
  const side = (r: Report) => ({
    startedAt: r.startedAt,
    passRate: r.summary.passRate,
    ...(r.summary.costUsd === undefined ? {} : { costUsd: r.summary.costUsd }),
  });
  return {
    baseline: side(baseline),
    current: side(current),
    regressed,
    improved,
    added: current.cases.filter((c) => !before.has(c.id)).map((c) => c.id),
    removed: baseline.cases.filter((c) => !ids.has(c.id)).map((c) => c.id),
  };
}

/** The comparison as Markdown, for report.md and PR comments. */
export function renderComparison(c: Comparison): string[] {
  const cost =
    c.baseline.costUsd !== undefined && c.current.costUsd !== undefined
      ? ` · cost ${usd(c.baseline.costUsd)} → ${usd(c.current.costUsd)}`
      : '';
  const lines = [
    '## Compared with the baseline',
    '',
    `Pass rate ${percent(c.baseline.passRate)} → ${percent(c.current.passRate)}${cost} (baseline from ${c.baseline.startedAt})`,
    '',
  ];
  if (c.regressed.length) {
    lines.push(
      `**${c.regressed.length} ${c.regressed.length === 1 ? 'case' : 'cases'} got worse:**`,
      '',
    );
    for (const r of c.regressed) lines.push(`- ${r.id}: ${r.regressions.join('; ')}`);
  } else {
    lines.push('No case got worse.');
  }
  if (c.improved.length) {
    lines.push(
      '',
      `Better: ${c.improved.map((r) => `${r.id} (${percent(r.before?.passRate ?? 0)} → ${percent(r.after?.passRate ?? 0)})`).join(', ')}`,
    );
  }
  if (c.added.length) lines.push('', `New cases: ${c.added.join(', ')}`);
  if (c.removed.length) lines.push('', `No longer run: ${c.removed.join(', ')}`);
  return lines;
}
