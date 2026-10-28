import type { CaseReport, Report, RunReport } from '@evalreplay/core';

export interface Style {
  pass(text: string): string;
  fail(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const ansi = (open: number, close: number) => (text: string) =>
  `\x1b[${open}m${text}\x1b[${close}m`;

export const COLOR: Style = {
  pass: ansi(32, 39),
  fail: ansi(31, 39),
  dim: ansi(2, 22),
  bold: ansi(1, 22),
};

export const PLAIN: Style = { pass: (t) => t, fail: (t) => t, dim: (t) => t, bold: (t) => t };

export const usd = (n: number | undefined) =>
  n === undefined ? 'cost unknown' : `$${n.toFixed(6).replace(/\.?0+$/, '') || '0'}`;
export const duration = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One line per finished run, while the runs go. */
export function runLine(run: RunReport, c: { id: string; runs: number }, s: Style): string {
  const mark = run.pass ? s.pass('✓') : s.fail('✗');
  const of = c.runs > 1 ? ` run ${run.run}/${c.runs}` : '';
  const facts = s.dim(`${duration(run.latencyMs)} · ${usd(run.costUsd)}`);
  const firstFailure = run.error
    ? `the run failed: ${run.error.type ? `${run.error.type}: ` : ''}${run.error.message}`
    : run.assertions.find((a) => !a.pass)?.label;
  return `${mark} ${c.id}${of}  ${facts}${firstFailure ? `  ${s.fail(firstFailure)}` : ''}`;
}

function failures(c: CaseReport, s: Style): string[] {
  const lines = [
    `${s.fail('✗')} ${s.bold(c.id)}  ${c.error ? s.fail(`could not run: ${c.error}`) : `${c.passed}/${plural(c.runs.length, 'run')} passed`}  ${s.dim(c.file)}`,
  ];
  for (const r of c.runs.filter((run) => !run.pass)) {
    const prefix = c.runs.length > 1 ? `run ${r.run}: ` : '';
    if (r.error)
      lines.push(
        `    ${prefix}the run failed: ${r.error.type ? `${r.error.type}: ` : ''}${r.error.message}`,
      );
    for (const a of r.assertions.filter((x) => !x.pass))
      lines.push(`    ${prefix}${a.label}: ${a.message}`);
    lines.push(`    ${s.dim(`trace ${r.traceId}`)}`);
  }
  return lines;
}

/** The end-of-run summary: the totals, every failure, and the comparison with a baseline. */
export function summary(report: Report, s: Style): string {
  const t = report.summary;
  const lines = [''];
  const failing = report.cases.filter((c) => !c.pass);
  for (const c of failing) lines.push(...failures(c, s), '');

  const totals =
    `${t.casesPassed} of ${plural(t.cases, 'case')} passed · ` +
    `${t.runsPassed} of ${plural(t.runs, 'run')} passed (${percent(t.passRate)}) · ` +
    `${usd(t.costUsd)} · ${duration(report.durationMs)}`;
  lines.push(failing.length || report.errors.length ? s.fail(totals) : s.pass(totals));

  const cmp = report.comparison;
  if (cmp) {
    lines.push(
      '',
      `Compared with the baseline from ${cmp.baseline.startedAt}: pass rate ${percent(cmp.baseline.passRate)} → ${percent(cmp.current.passRate)}`,
    );
    if (!cmp.regressed.length) lines.push(s.pass('  no case got worse'));
    for (const r of cmp.regressed)
      lines.push(s.fail(`  worse: ${r.id}: ${r.regressions.join('; ')}`));
    for (const r of cmp.improved) {
      lines.push(
        s.pass(
          `  better: ${r.id}: pass rate ${percent(r.before?.passRate ?? 0)} → ${percent(r.after?.passRate ?? 0)}`,
        ),
      );
    }
    if (cmp.added.length) lines.push(`  new: ${cmp.added.join(', ')}`);
    if (cmp.removed.length) lines.push(s.dim(`  not run: ${cmp.removed.join(', ')}`));
  }

  if (report.errors.length) {
    lines.push(
      '',
      s.fail('Files that could not be loaded:'),
      ...report.errors.map((e) => `  ${e}`),
    );
  }
  return lines.join('\n');
}
