import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Comparison, renderComparison } from './compare.js';
import { serializeTraces } from './jsonl.js';
import type { ErrorInfo, Trace } from './trace.js';

/** Bumped when report.json changes in a way that breaks readers. */
export const REPORT_VERSION = 1;

export interface AssertionReport {
  label: string;
  pass: boolean;
  message: string;
  /** Index in the run's `trace.steps`; messages count steps from 1. */
  stepIndex?: number;
}

export interface RunReport {
  /** 1-based. */
  run: number;
  /** The run's trace, in `traces.jsonl`. */
  traceId: string;
  pass: boolean;
  latencyMs: number;
  /** Omitted when unknown: no model calls were recorded, or one had no price. */
  costUsd?: number;
  steps: number;
  /** The run itself failed: the agent threw or timed out. */
  error?: ErrorInfo;
  assertions: AssertionReport[];
}

export interface CaseReport {
  id: string;
  description?: string;
  /** Case file, relative to the config folder. */
  file: string;
  mode: 'replay' | 'live';
  tags: string[];
  /** Every run passed. */
  pass: boolean;
  passed: number;
  /** passed / runs; 0 for a case that could not run. */
  passRate: number;
  /** Set when the case could not run at all, e.g. its `from_trace` was not found. */
  error?: string;
  runs: RunReport[];
}

export interface Report {
  version: typeof REPORT_VERSION;
  startedAt: string;
  durationMs: number;
  summary: {
    cases: number;
    casesPassed: number;
    runs: number;
    runsPassed: number;
    /** runsPassed / runs; 0 when nothing ran. */
    passRate: number;
    /** Omitted when any run's cost is unknown. */
    costUsd?: number;
  };
  cases: CaseReport[];
  /** Case and trace files that could not be loaded. */
  errors: string[];
  /** Set when the run was compared with a baseline report. */
  comparison?: Comparison;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Total cost of the runs, or undefined when any of them has no known cost. */
export function totalCost(runs: readonly { costUsd?: number }[]): number | undefined {
  return runs.every((r) => r.costUsd !== undefined)
    ? sum(runs.map((r) => r.costUsd ?? 0))
    : undefined;
}

export function summarize(cases: CaseReport[]): Report['summary'] {
  const runs = cases.flatMap((c) => c.runs);
  const runsPassed = runs.filter((r) => r.pass).length;
  const cost = totalCost(runs);
  return {
    cases: cases.length,
    casesPassed: cases.filter((c) => c.pass).length,
    runs: runs.length,
    runsPassed,
    passRate: runs.length ? runsPassed / runs.length : 0,
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

const usd = (n: number | undefined) =>
  n === undefined ? 'unknown' : `$${n.toFixed(6).replace(/\.?0+$/, '') || '0'}`;
const duration = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const describeError = (e: ErrorInfo) => `${e.type ? `${e.type}: ` : ''}${e.message}`;

/** The report as Markdown, for people: a summary table, then every failure. */
export function renderMarkdown(report: Report): string {
  const s = report.summary;
  const lines = [
    '# evalreplay report',
    '',
    `**${s.casesPassed} of ${plural(s.cases, 'case')} passed** · ` +
      `${s.runsPassed} of ${plural(s.runs, 'run')} passed (${percent(s.passRate)}) · ` +
      `cost ${usd(s.costUsd)} · ${duration(report.durationMs)}`,
  ];

  if (report.cases.length) {
    lines.push(
      '',
      '| | Case | Mode | Passed | Cost | Average latency |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const c of report.cases) {
      const latency = c.runs.length
        ? duration(sum(c.runs.map((r) => r.latencyMs)) / c.runs.length)
        : '–';
      const passed = c.error ? 'could not run' : `${c.passed}/${c.runs.length}`;
      lines.push(
        `| ${c.pass ? '✅' : '❌'} | ${c.id} | ${c.mode} | ${passed} | ${c.runs.length ? usd(totalCost(c.runs)) : '–'} | ${latency} |`,
      );
    }
  }

  if (report.comparison) lines.push('', ...renderComparison(report.comparison));

  const failing = report.cases.filter((c) => !c.pass);
  if (failing.length) {
    lines.push('', '## Failures');
    for (const c of failing) {
      lines.push('', `### ${c.id}`, '', `\`${c.file}\``);
      if (c.description) lines.push('', c.description);
      if (c.error) lines.push('', `- Could not run: ${c.error}`);
      for (const r of c.runs.filter((run) => !run.pass)) {
        const items = [
          ...(r.error ? [`- The run failed: ${describeError(r.error)}`] : []),
          ...r.assertions.filter((a) => !a.pass).map((a) => `- \`${a.label}\`: ${a.message}`),
        ];
        lines.push('', `Run ${r.run} (trace \`${r.traceId}\`):`, '', ...items);
      }
    }
  }

  if (report.errors.length) {
    lines.push('', '## Files that could not be loaded', '', ...report.errors.map((e) => `- ${e}`));
  }
  return `${lines.join('\n')}\n`;
}

export interface WrittenReport {
  json: string;
  markdown: string;
  traces: string;
}

/** Writes `report.json`, `report.md` and the runs' traces as `traces.jsonl` into `dir`. */
/** Reads a report.json, e.g. a saved baseline. */
export async function readReport(path: string): Promise<Report> {
  let report: unknown;
  try {
    report = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read the report ${path}: ${(err as Error).message}`, { cause: err });
  }
  const version = (report as { version?: unknown } | null)?.version;
  if (version !== REPORT_VERSION) {
    throw new Error(
      `${path} is not an evalreplay report (version ${String(version)}, expected ${REPORT_VERSION})`,
    );
  }
  return report as Report;
}

export async function writeReport(
  report: Report,
  traces: readonly Trace[],
  dir: string,
): Promise<WrittenReport> {
  const out = resolve(dir);
  await mkdir(out, { recursive: true });
  const paths = {
    json: join(out, 'report.json'),
    markdown: join(out, 'report.md'),
    traces: join(out, 'traces.jsonl'),
  };
  await Promise.all([
    writeFile(paths.json, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(paths.markdown, renderMarkdown(report)),
    writeFile(paths.traces, serializeTraces(traces)),
  ]);
  return paths;
}
