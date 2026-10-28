import { appendFile, readFile } from 'node:fs/promises';
import type { z } from 'zod';
import { type Trace, TraceSchema } from './trace.js';

/** A trace line that is not valid JSON or does not match the trace format. */
export class TraceParseError extends Error {
  override readonly name = 'TraceParseError';
  constructor(
    message: string,
    /** 1-based line in the file, when the trace came from one. */
    readonly line?: number,
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
  }
}

export interface ParsedTraces {
  traces: Trace[];
  /** One entry per line that could not be read; the other lines are still returned. */
  errors: TraceParseError[];
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Parses one trace from a JSON string or an already-parsed value. Throws TraceParseError. */
export function parseTrace(input: string | unknown, line?: number): Trace {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (err) {
      throw new TraceParseError(`not valid JSON (${(err as Error).message})`, line);
    }
  }
  const result = TraceSchema.safeParse(value);
  if (!result.success) throw new TraceParseError(describeIssues(result.error), line);
  return result.data;
}

/** Parses JSONL: one trace per line, blank lines ignored. Bad lines are reported, not thrown. */
export function parseTraces(jsonl: string): ParsedTraces {
  const traces: Trace[] = [];
  const errors: TraceParseError[] = [];
  jsonl.split(/\r?\n/).forEach((text, i) => {
    if (!text.trim()) return;
    try {
      traces.push(parseTrace(text, i + 1));
    } catch (err) {
      if (!(err instanceof TraceParseError)) throw err;
      errors.push(err);
    }
  });
  return { traces, errors };
}

/** One trace as a single JSONL line (no trailing newline). Validates first. */
export function serializeTrace(trace: Trace): string {
  return JSON.stringify(parseTrace(trace));
}

/** Traces as JSONL, one per line, ending with a newline. */
export function serializeTraces(traces: readonly Trace[]): string {
  return traces.map((t) => `${serializeTrace(t)}\n`).join('');
}

export async function readTraceFile(path: string): Promise<ParsedTraces> {
  return parseTraces(await readFile(path, 'utf8'));
}

/** Appends one trace to a JSONL file, creating it if needed. */
export async function appendTrace(path: string, trace: Trace): Promise<void> {
  await appendFile(path, `${serializeTrace(trace)}\n`, 'utf8');
}
