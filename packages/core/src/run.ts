import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { glob } from 'tinyglobby';
import { evaluateCase } from './assert.js';
import type { Case } from './cases.js';
import { type AgentOutput, type Config, DEFAULTS } from './config.js';
import { ToolReplay, createRunContext, errorInfo, withRun } from './context.js';
import { readTraceFile } from './jsonl.js';
import { loadCases } from './load.js';
import { costOf, priceFor } from './prices.js';
import {
  type CaseReport,
  REPORT_VERSION,
  type Report,
  type RunReport,
  summarize,
} from './report.js';
import {
  type ErrorInfo,
  type Step,
  TRACE_SCHEMA_VERSION,
  type Trace,
  computeTotals,
} from './trace.js';

export interface RunOptions {
  /** The folder the config's paths are relative to. Default: `process.cwd()`. */
  cwd?: string;
  /** Runs only the cases it returns true for. */
  filter?: (c: Case) => boolean;
  /** Called after each run, e.g. to show progress. */
  onRun?: (run: RunReport, c: Case) => void;
}

export interface RunOutcome {
  report: Report;
  /** One trace per run, in report order. */
  traces: Trace[];
}

/** A run that took longer than `timeoutMs`. */
export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

const shown = (cwd: string, file: string) => relative(cwd, file).split('\\').join('/');

export interface LoadedTraces {
  /** By id; when two files have the same id, the first file in path order wins. */
  traces: Map<string, Trace>;
  /** The absolute path of the file each trace came from, by id. */
  files: Map<string, string>;
  /** Lines that could not be read, with their file. */
  errors: string[];
}

/** Every trace in the JSONL files matching the patterns. Unreadable lines are reported. */
export async function loadTraces(patterns: string | string[], cwd: string): Promise<LoadedTraces> {
  const paths = (
    await glob(patterns, { cwd, absolute: true, ignore: ['**/node_modules/**'] })
  ).sort();
  const loaded: LoadedTraces = { traces: new Map(), files: new Map(), errors: [] };
  for (const file of paths) {
    const { traces: read, errors: bad } = await readTraceFile(file);
    loaded.errors.push(...bad.map((e) => `${shown(cwd, file)}: ${e.message}`));
    for (const t of read) {
      if (loaded.traces.has(t.id)) continue;
      loaded.traces.set(t.id, t);
      loaded.files.set(t.id, file);
    }
  }
  return loaded;
}

function toOutput(value: AgentOutput | unknown): Trace['output'] {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') return { text: value };
  if (typeof value === 'object' && ('text' in value || 'structured' in value)) {
    const { text, structured } = value as { text?: unknown; structured?: unknown };
    return {
      ...(typeof text === 'string' ? { text } : {}),
      ...(structured === undefined ? {} : { structured: JSON.parse(JSON.stringify(structured)) }),
    };
  }
  return { structured: JSON.parse(JSON.stringify(value)) };
}

/** Runs the agent once on a case and returns the trace of the run. */
async function runOnce(config: Config, c: Case, run: number, recorded?: Trace): Promise<Trace> {
  const steps: Step[] = [];
  const controller = new AbortController();
  const ctx = createRunContext({
    caseId: c.id,
    run,
    signal: controller.signal,
    steps,
    ...(recorded ? { replay: new ToolReplay(recorded) } : {}),
  });
  const timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  let output: Trace['output'] = {};
  let error: ErrorInfo | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new TimeoutError(`the agent did not finish within ${timeoutMs} ms`);
        controller.abort(err);
        reject(err);
      }, timeoutMs);
    });
    // a copy, so an agent that changes its input can't change the case
    const input = structuredClone(c.input);
    output = toOutput(
      await Promise.race([withRun(ctx, async () => config.agent(input, ctx)), timeout]),
    );
  } catch (err) {
    error = errorInfo(err);
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Math.round(performance.now() - t0);
  // tool calls still running after a timeout keep writing to `steps`; the trace keeps a copy
  const done = steps.map((s) => ({ ...s }));
  // model calls a recorder couldn't price get the config's price, when it has one
  for (const s of done) {
    const price =
      s.type === 'llm' &&
      s.costUsd === undefined &&
      config.prices &&
      priceFor(config.prices, s.model);
    if (s.type === 'llm' && price) s.costUsd = costOf(price, s);
  }
  const totals = computeTotals(done, latencyMs);
  // with no model calls recorded the cost is unknown, not zero
  if (!done.some((s) => s.type === 'llm')) delete totals.costUsd;

  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    id: `run_${randomUUID().replaceAll('-', '')}`,
    startedAt,
    agent: {
      name: config.name ?? DEFAULTS.name,
      ...(config.version ? { version: config.version } : {}),
    },
    input: structuredClone(c.input),
    steps: done,
    output,
    totals,
    ...(error ? { error } : {}),
    metadata: { tags: c.tags, caseId: c.id, run, mode: c.mode },
  };
}

/** Calls `work` on every item, at most `limit` at a time, keeping the results in item order. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Loads the cases in the config, runs the agent on each one `runs` times and checks every run
 * against the case's assertions. In replay mode, wrapped tools return the results recorded in the
 * case's `from_trace`.
 */
export async function runCases(config: Config, options: RunOptions = {}): Promise<RunOutcome> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  const loaded = await loadCases(config.cases, { cwd });
  const errors = loaded.errors.map((e) => e.message);
  const cases = options.filter ? loaded.cases.filter(options.filter) : loaded.cases;

  let recorded = new Map<string, Trace>();
  if (cases.some((c) => c.mode === 'replay')) {
    const read = await loadTraces(config.traces ?? DEFAULTS.traces, cwd);
    recorded = read.traces;
    errors.push(...read.errors);
  }

  const reports: CaseReport[] = cases.map((c) => ({
    id: c.id,
    ...(c.description === undefined ? {} : { description: c.description }),
    file: shown(cwd, c.file),
    mode: c.mode,
    tags: c.tags,
    pass: false,
    passed: 0,
    passRate: 0,
    runs: [],
  }));

  const jobs: { c: Case; report: CaseReport; run: number; trace?: Trace }[] = [];
  for (const [i, c] of cases.entries()) {
    const report = reports[i] as CaseReport;
    const trace = c.fromTrace === undefined ? undefined : recorded.get(c.fromTrace);
    if (c.mode === 'replay' && !trace) {
      const where = [config.traces ?? DEFAULTS.traces]
        .flat()
        .map((p) => `\`${p}\``)
        .join(', ');
      report.error = `from_trace ${c.fromTrace} is not in the trace files (${where})`;
      continue;
    }
    for (let run = 1; run <= c.runs; run++) {
      jobs.push({ c, report, run, ...(c.mode === 'replay' && trace ? { trace } : {}) });
    }
  }

  const finished = await pool(jobs, config.concurrency ?? DEFAULTS.concurrency, async (job) => {
    const trace = await runOnce(config, job.c, job.run, job.trace);
    const result = await evaluateCase(job.c, trace);
    const run: RunReport = {
      run: job.run,
      traceId: trace.id,
      pass: result.pass,
      latencyMs: trace.totals.latencyMs,
      ...(trace.totals.costUsd === undefined ? {} : { costUsd: trace.totals.costUsd }),
      steps: trace.steps.length,
      ...(trace.error ? { error: trace.error } : {}),
      assertions: result.results.map((r) => ({
        label: r.label,
        pass: r.pass,
        message: r.message,
        ...(r.stepIndex === undefined ? {} : { stepIndex: r.stepIndex }),
      })),
    };
    options.onRun?.(run, job.c);
    return { job, run, trace };
  });

  for (const { job, run } of finished) job.report.runs.push(run);
  for (const r of reports) {
    r.passed = r.runs.filter((run) => run.pass).length;
    r.passRate = r.runs.length ? r.passed / r.runs.length : 0;
    r.pass = r.error === undefined && r.runs.length > 0 && r.passed === r.runs.length;
  }

  return {
    report: {
      version: REPORT_VERSION,
      startedAt,
      durationMs: Math.round(performance.now() - t0),
      summary: summarize(reports),
      cases: reports,
      errors,
    },
    traces: finished.map((f) => f.trace),
  };
}
