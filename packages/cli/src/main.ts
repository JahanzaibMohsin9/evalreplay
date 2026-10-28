import {
  type Case,
  ConfigError,
  type Config,
  DEFAULTS,
  appendTrace,
  compareReports,
  loadConfig,
  loadTraces,
  readReport,
  runCases,
  writeReport,
} from '@evalreplay/core';
import { readFileSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { caseFromTrace, caseIdFor } from './capture.js';
import { COLOR, PLAIN, type Style, runLine, summary } from './format.js';

export { caseFromTrace, caseIdFor } from './capture.js';

/** Where the CLI reads and writes. Tests pass their own. */
export interface Io {
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  color: boolean;
}

export const BASELINE_FILE = '.evalreplay/baseline.json';
export const CAPTURED_TRACES = '.evalreplay/traces/captured.jsonl';

const HELP = `evalreplay: turn what your AI agent did into tests that run in CI

Usage:
  evalreplay run [options]               run the cases in evalreplay.config.ts
  evalreplay capture <trace-id> [opts]   write a case file from a recorded run
  evalreplay baseline save [options]     keep the last report as the baseline

run:
  --case <id>                only this case (repeat for more)
  --tag <tag>                only cases with this tag (repeat for more)
  --compare <file|baseline>  compare with a saved report; \`baseline\` is ${BASELINE_FILE}
  --max-cost-increase <pct>  with --compare, a bigger rise in a case's cost per run is a
                             regression (default 20)
  --concurrency <n>          runs at the same time
  --out <dir>                where the report goes (default: outDir in the config)

capture:
  --id <case-id>             the case id (default: from the first user message)
  --out <file>               the case file (default: cases/<id>.yaml)
  --force                    overwrite the case file

baseline save:
  --from <report.json>       the report to keep (default: the last run's)
  --to <file>                where to keep it (default: ${BASELINE_FILE})

All commands:
  --config <file>            the config file (default: evalreplay.config.ts, .mts, .js, .mjs)
  -h, --help, -v, --version

Exit codes: 0 when every case passed (with --compare: when no case got worse), 1 when not,
2 for a usage or config error.`;

class UsageError extends Error {}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/** A path as the user sees it: relative to where they ran the command, with forward slashes. */
const shown = (io: Io, path: string) => relative(io.cwd, path).split('\\').join('/');

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const positiveInt = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a whole number above 0`);
  return n;
};

/** The config, or the defaults when there is no config file and `optional` is set. */
async function config(
  file: string | undefined,
  io: Io,
  optional = false,
): Promise<{ config: Partial<Config>; dir: string }> {
  try {
    return await loadConfig(file, io.cwd);
  } catch (err) {
    if (
      optional &&
      file === undefined &&
      err instanceof ConfigError &&
      /^no config file/.test(err.message)
    ) {
      return { config: {}, dir: io.cwd };
    }
    throw err;
  }
}

async function run(args: string[], io: Io, s: Style): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      case: { type: 'string', multiple: true },
      tag: { type: 'string', multiple: true },
      compare: { type: 'string' },
      'max-cost-increase': { type: 'string' },
      concurrency: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const ids = values.case ?? [];
  const tags = values.tag ?? [];
  const maxCostIncrease =
    values['max-cost-increase'] === undefined ? undefined : Number(values['max-cost-increase']);
  if (maxCostIncrease !== undefined && !(maxCostIncrease >= 0)) {
    throw new UsageError('--max-cost-increase must be a percentage, e.g. 20');
  }
  const concurrency = positiveInt(values.concurrency, '--concurrency');

  const loaded = await loadConfig(values.config, io.cwd);
  const cfg: Config = { ...loaded.config, ...(concurrency ? { concurrency } : {}) };
  const baselineFile =
    values.compare === undefined
      ? undefined
      : resolve(loaded.dir, values.compare === 'baseline' ? BASELINE_FILE : values.compare);
  if (baselineFile && !(await exists(baselineFile))) {
    throw new UsageError(
      `no baseline at ${shown(io, baselineFile)}; save one with \`evalreplay baseline save\` after a run`,
    );
  }

  const seen = new Set<string>();
  const filter = (c: Case) => {
    const keep =
      (!ids.length || ids.includes(c.id)) && (!tags.length || c.tags.some((t) => tags.includes(t)));
    if (keep) seen.add(c.id);
    return keep;
  };
  const runsOf = new Map<string, number>();
  const { report, traces } = await runCases(cfg, {
    cwd: loaded.dir,
    filter: (c) => {
      runsOf.set(c.id, c.runs);
      return filter(c);
    },
    onRun: (r, c) => io.out(runLine(r, { id: c.id, runs: runsOf.get(c.id) ?? 1 }, s)),
  });
  for (const id of ids.filter((i) => !seen.has(i))) io.err(s.fail(`no case with id ${id}`));
  if (!report.cases.length && !report.errors.length) {
    io.err(s.fail('no cases to run'));
    return 1;
  }

  if (baselineFile) {
    report.comparison = compareReports(await readReport(baselineFile), report, {
      ...(maxCostIncrease === undefined ? {} : { maxCostIncrease: maxCostIncrease / 100 }),
    });
  }
  const out = resolve(loaded.dir, values.out ?? cfg.outDir ?? DEFAULTS.outDir);
  const written = await writeReport(report, traces, out);
  io.out(summary(report, s));
  io.out(s.dim(`\nReport: ${shown(io, written.markdown)} · traces: ${shown(io, written.traces)}`));

  const failed = report.comparison
    ? report.comparison.regressed.length > 0
    : report.summary.casesPassed < report.summary.cases;
  return failed || report.errors.length || ids.some((i) => !seen.has(i)) ? 1 : 0;
}

async function capture(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      id: { type: 'string' },
      out: { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  const [traceId, ...extra] = positionals;
  if (!traceId || extra.length)
    throw new UsageError('capture takes one trace id: evalreplay capture <trace-id>');

  const { config: cfg, dir } = await config(values.config, io, true);
  const store = [cfg.traces ?? DEFAULTS.traces].flat();
  const lastRun = join(cfg.outDir ?? DEFAULTS.outDir, 'traces.jsonl')
    .split('\\')
    .join('/');
  const found = await loadTraces([...store, lastRun], dir);
  const trace = found.traces.get(traceId);
  if (!trace) {
    io.err(`no trace ${traceId} in ${[...store, lastRun].join(', ')}`);
    return 1;
  }

  const id = values.id ?? caseIdFor(trace);
  const caseFile = resolve(dir, values.out ?? join('cases', `${id}.yaml`));
  if (!values.force && (await exists(caseFile))) {
    throw new UsageError(`${shown(io, caseFile)} exists; pass --force to overwrite it`);
  }

  // a trace from the last run's report is overwritten by the next run, so keep a copy where
  // from_trace finds it
  const stored = await loadTraces(store, dir);
  if (!stored.traces.has(traceId)) {
    const keep = resolve(dir, CAPTURED_TRACES);
    await mkdir(dirname(keep), { recursive: true });
    await appendTrace(keep, trace);
    const findable = (await loadTraces(store, dir)).traces.has(traceId);
    io.out(`Saved the trace to ${shown(io, keep)}`);
    if (!findable) {
      io.err(
        `warning: ${CAPTURED_TRACES} is not matched by traces in the config (${store.join(', ')}); add it so from_trace finds the trace`,
      );
    }
  }

  await mkdir(dirname(caseFile), { recursive: true });
  await writeFile(caseFile, caseFromTrace(trace, id));
  io.out(
    `Wrote ${shown(io, caseFile)}: review its assertions, then run it with \`evalreplay run --case ${id}\``,
  );
  return 0;
}

async function baseline(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { config: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
  });
  if (positionals.join(' ') !== 'save')
    throw new UsageError('usage: evalreplay baseline save [--from report.json] [--to file]');
  const { config: cfg, dir } = await config(values.config, io, true);
  const from = resolve(dir, values.from ?? join(cfg.outDir ?? DEFAULTS.outDir, 'report.json'));
  if (!(await exists(from)))
    throw new UsageError(`no report at ${shown(io, from)}; run \`evalreplay run\` first`);
  const report = await readReport(from);
  delete report.comparison; // a baseline is a plain report; comparing it again starts afresh
  const to = resolve(dir, values.to ?? BASELINE_FILE);
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, `${JSON.stringify(report, null, 2)}\n`);
  const t = report.summary;
  io.out(
    `Saved ${shown(io, from)} as the baseline in ${shown(io, to)} (${t.runsPassed} of ${t.runs} runs passed). Commit it so CI compares with it.`,
  );
  return 0;
}

/** Runs the CLI with the arguments after `evalreplay`, returning the exit code. */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  const s = io.color ? COLOR : PLAIN;
  const [command, ...args] = argv;
  try {
    switch (command) {
      case 'run':
        return await run(args, io, s);
      case 'capture':
        return await capture(args, io);
      case 'baseline':
        return await baseline(args, io);
      case '-v':
      case '--version':
        io.out(version());
        return 0;
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        io.out(HELP);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command ${command}; run evalreplay --help`);
    }
  } catch (err) {
    const usage =
      err instanceof UsageError ||
      err instanceof ConfigError ||
      (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    io.err(s.fail(`evalreplay: ${(err as Error).message}`));
    if (!usage && (err as Error).stack) io.err(s.dim((err as Error).stack ?? ''));
    return usage ? 2 : 1;
  }
}

export function processIo(): Io {
  return {
    cwd: process.cwd(),
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    color:
      process.env.FORCE_COLOR !== undefined
        ? process.env.FORCE_COLOR !== '0'
        : Boolean(process.stdout.isTTY) &&
          process.env.NO_COLOR === undefined &&
          process.env.TERM !== 'dumb',
  };
}
