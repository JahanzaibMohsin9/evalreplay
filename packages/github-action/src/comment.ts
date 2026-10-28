import type { CaseReport, Report } from '@evalreplay/core';

/** Marks evalreplay's comment, so a new run updates it instead of adding another. */
export const MARKER = '<!-- evalreplay -->';

export interface CommentContext {
  /** True when the run passed (the CLI exited 0). */
  passed: boolean;
  /** What the baseline was, e.g. "`main` (3e80525)", or why there is none. */
  baseline: { label: string } | { missing: string };
  /** The workflow run, for the full report. */
  runUrl?: string;
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const usd = (n: number | undefined) =>
  n === undefined ? 'cost unknown' : `$${n.toFixed(6).replace(/\.?0+$/, '') || '0'}`;
const duration = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
// a value inside a table cell or a list item: no line breaks, no pipes that end the cell
const cell = (text: string) => text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');

const MAX_FAILURES = 25;

function failureLines(c: CaseReport): string[] {
  if (c.error) return [`- **${c.id}** could not run: ${cell(c.error)}`];
  const lines = [
    `- **${c.id}**: ${c.passed}/${plural(c.runs.length, 'run')} passed (\`${c.file}\`)`,
  ];
  for (const r of c.runs.filter((run) => !run.pass)) {
    const prefix = c.runs.length > 1 ? `run ${r.run}: ` : '';
    if (r.error) {
      lines.push(
        `  - ${prefix}the run failed: ${cell(`${r.error.type ? `${r.error.type}: ` : ''}${r.error.message}`)}`,
      );
    }
    for (const a of r.assertions.filter((x) => !x.pass)) {
      lines.push(`  - ${prefix}\`${a.label}\`: ${cell(a.message)}`);
    }
  }
  return lines;
}

/** The pull request comment: totals, what got worse than the baseline, and every failure. */
export function renderComment(report: Report, ctx: CommentContext): string {
  const t = report.summary;
  const cmp = report.comparison;
  const lines = [
    MARKER,
    `## ${ctx.passed ? '✅' : '❌'} evalreplay`,
    '',
    `**${t.casesPassed} of ${plural(t.cases, 'case')} passed** · ${t.runsPassed} of ${plural(t.runs, 'run')} (${percent(t.passRate)}) · ${usd(t.costUsd)} · ${duration(report.durationMs)}`,
    '',
  ];

  if ('missing' in ctx.baseline) {
    lines.push(`No baseline to compare with: ${ctx.baseline.missing}.`);
  } else if (cmp) {
    const cost =
      cmp.baseline.costUsd !== undefined && cmp.current.costUsd !== undefined
        ? `, cost ${usd(cmp.baseline.costUsd)} → ${usd(cmp.current.costUsd)}`
        : '';
    const against = `Compared with ${ctx.baseline.label}: pass rate ${percent(cmp.baseline.passRate)} → ${percent(cmp.current.passRate)}${cost}.`;
    if (!cmp.regressed.length) {
      lines.push(`${against} No case got worse.`);
    } else {
      lines.push(
        against,
        '',
        `**${plural(cmp.regressed.length, 'case')} got worse:**`,
        '',
        '| Case | Before | After | Why |',
        '| --- | --- | --- | --- |',
        ...cmp.regressed.map(
          (r) =>
            `| ${r.id} | ${percent(r.before?.passRate ?? 0)} | ${r.after?.error ? 'could not run' : percent(r.after?.passRate ?? 0)} | ${cell(r.regressions.join('; '))} |`,
        ),
      );
    }
    const notes = [
      cmp.improved.length ? `Better: ${cmp.improved.map((r) => r.id).join(', ')}.` : '',
      cmp.added.length ? `New: ${cmp.added.join(', ')}.` : '',
      cmp.removed.length ? `Not run: ${cmp.removed.join(', ')}.` : '',
    ].filter(Boolean);
    if (notes.length) lines.push('', notes.join(' '));
  }

  const failing = report.cases.filter((c) => !c.pass);
  if (failing.length) {
    const shown = failing.slice(0, MAX_FAILURES);
    lines.push(
      '',
      `<details><summary>${plural(failing.length, 'failing case')}</summary>`,
      '',
      ...shown.flatMap(failureLines),
      ...(failing.length > shown.length ? [`- and ${failing.length - shown.length} more`] : []),
      '',
      '</details>',
    );
  }
  if (report.errors.length) {
    lines.push(
      '',
      `**${plural(report.errors.length, 'file')} could not be loaded:**`,
      '',
      ...report.errors.map((e) => `- ${cell(e)}`),
    );
  }
  lines.push(
    '',
    ctx.runUrl
      ? `[Full report](${ctx.runUrl}) · [evalreplay](https://github.com/JahanzaibMohsin9/evalreplay)`
      : '[evalreplay](https://github.com/JahanzaibMohsin9/evalreplay)',
  );
  return `${lines.join('\n')}\n`;
}
