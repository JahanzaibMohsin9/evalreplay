import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleTrace } from './fixtures.js';
import {
  TraceParseError,
  appendTrace,
  parseTrace,
  parseTraces,
  readTraceFile,
  serializeTrace,
  serializeTraces,
} from './jsonl.js';

describe('JSONL traces', () => {
  it('round-trips traces through JSONL', () => {
    const traces = [sampleTrace(), sampleTrace({ id: 'run_2' })];
    const jsonl = serializeTraces(traces);

    expect(jsonl.split('\n')).toHaveLength(3); // two lines and the final newline
    expect(parseTraces(jsonl)).toEqual({ traces, errors: [] });
  });

  it('reads CRLF files and skips blank lines', () => {
    const jsonl = `\r\n${serializeTrace(sampleTrace())}\r\n\r\n`;
    expect(parseTraces(jsonl).traces).toHaveLength(1);
  });

  it('reports bad lines with their line number and keeps the good ones', () => {
    const bad = { ...sampleTrace({ id: 'run_bad' }), agent: {} };
    const jsonl = [serializeTrace(sampleTrace()), '{not json', JSON.stringify(bad)].join('\n');

    const { traces, errors } = parseTraces(jsonl);

    expect(traces.map((t) => t.id)).toEqual([sampleTrace().id]);
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/^line 2: not valid JSON/),
      expect.stringMatching(/^line 3: agent\.name: /),
    ]);
    expect(errors.map((e) => e.line)).toEqual([2, 3]);
  });

  it('throws TraceParseError for a single invalid trace', () => {
    expect(() => parseTrace('{}')).toThrow(TraceParseError);
    expect(() => parseTrace('{}')).toThrow(/schemaVersion/);
  });

  it('refuses to serialize an invalid trace', () => {
    const trace = sampleTrace();
    trace.totals.steps = 0;
    expect(() => serializeTrace(trace)).toThrow(/totals\.steps/);
  });

  describe('files', () => {
    let dir: string | undefined;
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('appends traces to a file and reads them back', async () => {
      dir = await mkdtemp(join(tmpdir(), 'evalreplay-'));
      const file = join(dir, 'traces.jsonl');

      await appendTrace(file, sampleTrace());
      await appendTrace(file, sampleTrace({ id: 'run_2' }));

      const { traces, errors } = await readTraceFile(file);
      expect(errors).toEqual([]);
      expect(traces.map((t) => t.id)).toEqual([sampleTrace().id, 'run_2']);
    });
  });
});
