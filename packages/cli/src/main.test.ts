import { type Trace, loadCaseFile, parseTraces, readReport } from '@evalreplay/core';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { caseFromTrace, caseIdFor } from './capture.js';
import { type Io, main } from './main.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'evalreplay-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function files(contents: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(contents)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

/** Runs the CLI in the temp dir, returning the exit code and what it printed. */
async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { cwd: dir, out: (t) => out.push(t), err: (t) => err.push(t), color: false };
  const code = await main(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// A config file in plain JS, so it loads without a build: the agent pays only when told "now",
// and AGENT_MODE=broken makes compare_routes fail.
const CONFIG = `
const compare = (args) => {
  if (process.env.AGENT_MODE === 'broken') throw new Error('route service down');
  return { cheapest: 'sepa', feeEur: args.amount > 1000 ? 4.5 : 2 };
};
export default {
  cases: 'cases/**/*.yaml',
  name: 'payments-agent',
  concurrency: 2,
  agent: async (input, ctx) => {
    const tools = ctx.wrapTools({ compare_routes: compare, execute_payment: () => ({ ok: true }) });
    let route;
    try {
      route = tools.compare_routes({ amount: 1200, currency: 'EUR' });
    } catch {
      return 'I could not compare routes.';
    }
    const text = String(input.messages.at(-1).content);
    if (text.includes('now')) tools.execute_payment({ route: route.cheapest });
    return 'The cheapest route is ' + route.cheapest + '. It needs your approval.';
  },
};
`;

const PAY = `id: pay-tuition
input: Pay my son's tuition
tags: [payments]
assert:
  - tool_called: compare_routes
  - tool_not_called: execute_payment
  - output_contains: approval
`;
const PAY_NOW = PAY.replace('pay-tuition', 'pay-now')
  .replace("Pay my son's tuition", 'Pay it now')
  .replace('tags: [payments]\n', '');

describe('evalreplay run', () => {
  beforeEach(() => {
    delete process.env.AGENT_MODE;
  });

  it('runs the cases, prints each run and a summary, and writes the report', async () => {
    await files({ 'evalreplay.config.mjs': CONFIG, 'cases/pay.yaml': PAY });
    const r = await cli('run');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^✓ pay-tuition {2}\d+ ms · cost unknown$/m);
    expect(r.out).toContain('1 of 1 case passed · 1 of 1 run passed (100%) · cost unknown');
    expect(r.out).toContain('Report: .evalreplay/report/report.md');
    const report = await readReport(join(dir, '.evalreplay/report/report.json'));
    expect(report.cases[0]?.id).toBe('pay-tuition');
    const traces = parseTraces(
      await readFile(join(dir, '.evalreplay/report/traces.jsonl'), 'utf8'),
    );
    expect(traces.traces[0]?.agent.name).toBe('payments-agent');
  });

  it('exits 1 and explains every failure', async () => {
    await files({
      'evalreplay.config.mjs': CONFIG,
      'cases/pay.yaml': PAY,
      'cases/now.yaml': PAY_NOW,
    });
    const r = await cli('run');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^✗ pay-now .*tool_not_called: execute_payment$/m);
    expect(r.out).toContain('✗ pay-now  0/1 run passed  cases/now.yaml');
    expect(r.out).toContain(
      '    tool_not_called: execute_payment: execute_payment was called once (step 2)',
    );
    expect(r.out).toContain('1 of 2 cases passed');
  });

  it('runs only the cases asked for, by id or tag', async () => {
    await files({
      'evalreplay.config.mjs': CONFIG,
      'cases/pay.yaml': PAY,
      'cases/now.yaml': PAY_NOW,
    });
    expect((await cli('run', '--tag', 'payments')).code).toBe(0);
    expect((await cli('run', '--case', 'pay-tuition')).code).toBe(0);
    const missing = await cli('run', '--case', 'pay-tuition', '--case', 'nope');
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('no case with id nope');
    const none = await cli('run', '--tag', 'nothing');
    expect(none).toMatchObject({ code: 1, err: 'no cases to run' });
  });

  it('exits 1 when a case file does not load, and still runs the rest', async () => {
    await files({
      'evalreplay.config.mjs': CONFIG,
      'cases/pay.yaml': PAY,
      'cases/bad.yaml': 'id: bad\ninput: hi\nassert: [{ max_cost: 1 }]\n',
    });
    const r = await cli('run');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Files that could not be loaded:');
    expect(r.out).toContain('1 of 1 case passed');
  });

  it('compares with the saved baseline and fails only on a regression', async () => {
    await files({
      'evalreplay.config.mjs': CONFIG,
      'cases/pay.yaml': PAY,
      'cases/now.yaml': PAY_NOW,
    });
    expect((await cli('run')).code).toBe(1); // pay-now fails, before and after
    const saved = await cli('baseline', 'save');
    expect(saved.code).toBe(0);
    expect(saved.out).toContain('as the baseline in .evalreplay');

    const same = await cli('run', '--compare', 'baseline');
    expect(same.code).toBe(0);
    expect(same.out).toContain('no case got worse');

    process.env.AGENT_MODE = 'broken';
    const worse = await cli('run', '--compare', 'baseline');
    expect(worse.code).toBe(1);
    expect(worse.out).toContain('worse: pay-tuition: pass rate 100% → 0%');
    const md = await readFile(join(dir, '.evalreplay/report/report.md'), 'utf8');
    expect(md).toContain('## Compared with the baseline');
  });

  it('reports a missing baseline, config or bad flag as a usage error', async () => {
    expect(await cli('run')).toMatchObject({
      code: 2,
      err: expect.stringMatching(/^evalreplay: no config file in /),
    });
    await files({ 'evalreplay.config.mjs': CONFIG, 'cases/pay.yaml': PAY });
    expect(await cli('run', '--compare', 'baseline')).toMatchObject({
      code: 2,
      err: expect.stringContaining('save one with `evalreplay baseline save`'),
    });
    expect((await cli('run', '--concurrency', '0')).code).toBe(2);
    expect((await cli('run', '--nope')).code).toBe(2);
    expect((await cli('frobnicate')).err).toContain('unknown command frobnicate');
    expect((await cli('baseline', 'save')).err).toContain('run `evalreplay run` first');
  });

  it('prints help and the version', async () => {
    expect(await cli('--help')).toMatchObject({
      code: 0,
      out: expect.stringContaining('evalreplay run [options]'),
    });
    expect((await cli()).code).toBe(2);
    expect((await cli('--version')).out).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('evalreplay capture', () => {
  it('turns a run from the last report into a replay case that passes', async () => {
    await files({ 'evalreplay.config.mjs': CONFIG, 'cases/pay.yaml': PAY });
    await cli('run');
    const [trace] = parseTraces(
      await readFile(join(dir, '.evalreplay/report/traces.jsonl'), 'utf8'),
    ).traces;
    if (!trace) throw new Error('no trace');

    const r = await cli('capture', trace.id);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Saved the trace to .evalreplay');
    expect(r.out).toContain('Wrote cases');

    const yaml = await readFile(join(dir, 'cases/pay-my-sons-tuition.yaml'), 'utf8');
    expect(yaml).toContain(`from_trace: ${trace.id}`);
    const loaded = await loadCaseFile('cases/pay-my-sons-tuition.yaml', { cwd: dir });
    expect(loaded.errors).toEqual([]);
    expect(loaded.cases[0]).toMatchObject({ mode: 'replay', fromTrace: trace.id });

    // the captured case replays: the broken tool isn't called, so it still passes
    process.env.AGENT_MODE = 'broken';
    const replay = await cli('run', '--case', 'pay-my-sons-tuition');
    delete process.env.AGENT_MODE;
    expect(replay.code).toBe(0);

    expect((await cli('capture', trace.id)).err).toContain('pass --force to overwrite it');
    expect((await cli('capture', trace.id, '--force', '--id', 'other')).code).toBe(0);
    expect((await cli('capture', 'run_missing')).code).toBe(1);
  });

  it('writes assertions that describe the run', () => {
    const trace: Trace = {
      schemaVersion: 1,
      id: 'run_abc',
      startedAt: '2026-10-28T10:00:00Z',
      agent: { name: 'carrypay' },
      input: { messages: [{ role: 'user', content: "Pay my son's tuition to TU München!" }] },
      steps: [
        {
          type: 'llm',
          provider: 'openai',
          model: 'm',
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.0123,
          latencyMs: 1,
        },
        { type: 'tool', name: 'compare_routes', args: {}, latencyMs: 1, error: null },
        { type: 'tool', name: 'get_fx', args: {}, latencyMs: 1 },
        { type: 'tool', name: 'compare_routes', args: {}, latencyMs: 1 },
      ],
      output: { text: 'ok' },
      totals: { latencyMs: 4, steps: 4, costUsd: 0.0123 },
    };
    expect(caseIdFor(trace)).toBe('pay-my-sons-tuition-to-tu');
    expect(caseFromTrace(trace)).toBe(`# Captured from run_abc (carrypay, 2026-10-28T10:00:00Z).
# The assertions describe what that run did. Edit them to say what the agent must do,
# e.g. add tool_not_called for tools that need approval, or output_contains for the answer.
id: pay-my-sons-tuition-to-tu
from_trace: run_abc
input: Pay my son's tuition to TU München!
assert:
  - tool_called: compare_routes
  - tool_called: get_fx
  - tool_order:
      - compare_routes
      - get_fx
  - no_tool_errors: true
  - max_steps: 6
  - max_cost_usd: 0.019
`);
  });

  it('keeps a multi-message input as a message list', () => {
    const trace = {
      id: 'run_x',
      startedAt: 's',
      agent: { name: 'a' },
      input: {
        messages: [
          { role: 'system', content: 'Be brief' },
          { role: 'user', content: '¿Hola?' },
        ],
      },
      steps: [],
      output: {},
      totals: { latencyMs: 1, steps: 0 },
    } as unknown as Trace;
    expect(caseIdFor(trace)).toBe('hola');
    expect(caseFromTrace(trace)).toContain('input:\n  messages:\n    - role: system');
  });
});
