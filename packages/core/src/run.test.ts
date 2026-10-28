import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentFn, type Config, ConfigError, loadConfig } from './config.js';
import { sampleTrace } from './fixtures.js';
import { parseTraces, serializeTraces } from './jsonl.js';
import { writeReport } from './report.js';
import { runCases } from './run.js';
import type { Step, Trace } from './trace.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'evalreplay-run-'));
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

const run = (agent: AgentFn, config: Partial<Config> = {}) =>
  runCases({ cases: 'cases/*.yaml', agent, ...config }, { cwd: dir });

const tools = {
  compare_routes: (args: { amount: number; currency: string }) => ({
    cheapest: 'bank_transfer',
    feeEur: args.amount > 1000 ? 4.5 : 2,
  }),
  execute_payment: async (_args: { route: string }) => ({ ok: true }),
};

/** Compares routes, then pays only when the user says "now". */
const payAgent: AgentFn = async (input, ctx) => {
  const t = ctx.wrapTools(tools);
  const route = t.compare_routes({ amount: 1200, currency: 'EUR' });
  const text = String(input.messages.at(-1)?.content);
  if (text.includes('now')) await t.execute_payment({ route: route.cheapest });
  return `The cheapest route is ${route.cheapest} (fee €${route.feeEur}). It needs your approval.`;
};

const PAY_CASE = `
id: pay-tuition
input: Pay my son's tuition
assert:
  - tool_called: compare_routes
  - tool_not_called: execute_payment
  - output_contains: approval
`;

describe('live mode', () => {
  it('runs the agent, records its tool calls and checks the trace', async () => {
    await files({ 'cases/pay.yaml': PAY_CASE });
    const { report, traces } = await run(payAgent, { name: 'carrypay', version: 'abc123' });

    expect(report.summary).toEqual({
      cases: 1,
      casesPassed: 1,
      runs: 1,
      runsPassed: 1,
      passRate: 1,
    });
    expect(report.errors).toEqual([]);
    const [c] = report.cases;
    expect(c).toMatchObject({
      id: 'pay-tuition',
      file: 'cases/pay.yaml',
      mode: 'live',
      pass: true,
    });
    expect(c?.runs[0]?.assertions.map((a) => a.pass)).toEqual([true, true, true]);

    const [trace] = traces;
    expect(trace).toMatchObject({
      schemaVersion: 1,
      agent: { name: 'carrypay', version: 'abc123' },
      input: { messages: [{ role: 'user', content: "Pay my son's tuition" }] },
      steps: [
        {
          type: 'tool',
          name: 'compare_routes',
          args: { amount: 1200, currency: 'EUR' },
          result: { cheapest: 'bank_transfer', feeEur: 4.5 },
          error: null,
        },
      ],
      output: { text: expect.stringContaining('bank_transfer') },
      metadata: { caseId: 'pay-tuition', run: 1, mode: 'live', tags: [] },
    });
    expect(trace?.id).toMatch(/^run_[0-9a-f]{32}$/);
    expect(trace?.totals.steps).toBe(1);
    // round-trips through the trace format
    expect(parseTraces(serializeTraces(traces)).errors).toEqual([]);
  });

  it('fails the assertions the run breaks', async () => {
    await files({ 'cases/pay.yaml': PAY_CASE.replace("Pay my son's tuition", 'Pay it now') });
    const { report } = await run(payAgent);
    expect(report.summary.runsPassed).toBe(0);
    expect(report.cases[0]?.runs[0]?.assertions[1]).toEqual({
      label: 'tool_not_called: execute_payment',
      pass: false,
      message: 'execute_payment was called once (step 2)',
      stepIndex: 1,
    });
  });

  it('runs a case `runs` times and reports the pass rate', async () => {
    await files({
      'cases/flaky.yaml': 'id: flaky\ninput: hi\nruns: 4\nassert:\n  - output_contains: yes\n',
    });
    const { report } = await run((_input, ctx) => (ctx.run % 2 ? 'yes' : 'no'));
    expect(report.cases[0]).toMatchObject({ pass: false, passed: 2, passRate: 0.5 });
    expect(report.cases[0]?.runs.map((r) => [r.run, r.pass])).toEqual([
      [1, true],
      [2, false],
      [3, true],
      [4, false],
    ]);
    expect(report.summary).toMatchObject({
      cases: 1,
      casesPassed: 0,
      runs: 4,
      runsPassed: 2,
      passRate: 0.5,
    });
  });

  it('keeps a sync tool sync and records tools called by name', async () => {
    await files({
      'cases/a.yaml': 'id: a\ninput: hi\nassert:\n  - tool_called: lookup\n  - tool_called: add\n',
    });
    let syncResult: unknown;
    const { report, traces } = await run((_input, ctx) => {
      syncResult = ctx.wrapTool('add', (a: number, b: number) => a + b)(2, 3);
      ctx.callTool('lookup', { key: 'fee' }, () => 4.5);
      return 'done';
    });
    expect(syncResult).toBe(5);
    expect(report.summary.runsPassed).toBe(1);
    expect(traces[0]?.steps).toMatchObject([
      { name: 'add', args: { arguments: [2, 3] }, result: 5 },
      { name: 'lookup', args: { key: 'fee' }, result: 4.5 },
    ]);
  });

  it('records a tool that throws, and the error reaches the agent', async () => {
    await files({ 'cases/a.yaml': 'id: a\ninput: hi\nassert:\n  - no_tool_errors: true\n' });
    let caught: unknown;
    const { report, traces } = await run(async (_input, ctx) => {
      const fx = ctx.wrapTool('get_fx', async (_args: { to: string }) => {
        throw new RangeError('unknown currency XYZ');
      });
      await fx({ to: 'XYZ' }).catch((err: unknown) => (caught = err));
      return 'sorry';
    });
    expect(caught).toBeInstanceOf(RangeError);
    expect(traces[0]?.steps[0]).toMatchObject({
      error: { type: 'RangeError', message: 'unknown currency XYZ' },
    });
    expect(report.cases[0]?.runs[0]?.assertions[0]?.message).toBe(
      'step 1 (get_fx) threw RangeError: unknown currency XYZ',
    );
  });

  it('takes text, structured output or both from the agent', async () => {
    await files({
      'cases/a.yaml':
        'id: a\ninput: hi\nruns: 4\nassert:\n  - output_schema: { type: object, required: [route] }\n',
    });
    const outputs = [
      { route: 'bank' },
      { structured: { route: 'card' }, text: 'card' },
      undefined,
      'plain',
    ];
    const { traces } = await run((_input, ctx) => outputs[ctx.run - 1] as never, {
      concurrency: 1,
    });
    expect(traces.map((t) => t.output)).toEqual([
      { structured: { route: 'bank' } },
      { text: 'card', structured: { route: 'card' } },
      {},
      { text: 'plain' },
    ]);
  });
});

describe('run failures', () => {
  it('fails a run whose agent throws, and keeps the steps before it', async () => {
    await files({ 'cases/a.yaml': 'id: a\ninput: hi\nassert:\n  - tool_called: search\n' });
    const { report, traces } = await run((_input, ctx) => {
      ctx.callTool('search', {}, () => []);
      throw new TypeError('cannot read the answer');
    });
    const r = report.cases[0]?.runs[0];
    expect(r?.pass).toBe(false);
    expect(r?.error).toEqual({ type: 'TypeError', message: 'cannot read the answer' });
    expect(r?.assertions[0]?.pass).toBe(true);
    expect(traces[0]?.steps).toHaveLength(1);
  });

  it('times a run out and aborts its signal', async () => {
    await files({ 'cases/a.yaml': 'id: a\ninput: hi\nassert:\n  - max_steps: 5\n' });
    let aborted = false;
    const { report } = await run(
      (_input, ctx) =>
        new Promise(() => {
          ctx.signal.addEventListener('abort', () => (aborted = true));
        }),
      { timeoutMs: 20 },
    );
    expect(aborted).toBe(true);
    expect(report.cases[0]?.runs[0]?.error).toEqual({
      type: 'TimeoutError',
      message: 'the agent did not finish within 20 ms',
    });
  });

  it('reports the cost as unknown when no model calls were recorded', async () => {
    await files({ 'cases/a.yaml': 'id: a\ninput: hi\nassert:\n  - max_cost_usd: 1\n' });
    const { report } = await run(() => 'hi');
    const r = report.cases[0]?.runs[0];
    expect(r?.costUsd).toBeUndefined();
    expect(r?.assertions[0]?.message).toBe(
      'the cost is unknown: no model calls were recorded (add a recorder)',
    );
    expect(report.summary.costUsd).toBeUndefined();
  });

  it('adds up the cost of recorded model calls', async () => {
    await files({ 'cases/a.yaml': 'id: a\ninput: hi\nruns: 2\nassert:\n  - max_cost_usd: 0.01\n' });
    const llm: Step = {
      type: 'llm',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.002,
      latencyMs: 300,
    };
    const { report } = await run((_input, ctx) => {
      ctx.recordStep(llm);
      return 'hi';
    });
    expect(report.cases[0]?.runs.map((r) => r.costUsd)).toEqual([0.002, 0.002]);
    expect(report.summary).toMatchObject({ runsPassed: 2, costUsd: 0.004 });
  });

  it('prices model calls without a cost from the config, leaving unknown models unknown', async () => {
    await files({ 'cases/a.yaml': 'id: a\ninput: hi\nassert:\n  - max_steps: 5\n' });
    const call = (model: string): Step => ({
      type: 'llm',
      provider: 'deepseek',
      model,
      inputTokens: 2000,
      cachedInputTokens: 1000,
      outputTokens: 100,
      latencyMs: 300,
    });
    const { traces } = await run(
      (_input, ctx) => {
        ctx.recordStep(call('deepseek-v4-pro'));
        ctx.recordStep({ ...call('deepseek-v4-pro'), costUsd: 0.5 }); // the recorder's price wins
        ctx.recordStep(call('mystery-model'));
        return 'hi';
      },
      { prices: { 'deepseek-v4-pro': { input: 0.5, output: 2, cachedInput: 0.05 } } },
    );
    expect(traces[0]?.steps.map((s) => (s.type === 'llm' ? s.costUsd : null))).toEqual([
      expect.closeTo((1000 * 0.5 + 1000 * 0.05 + 100 * 2) / 1e6, 12),
      0.5,
      undefined,
    ]);
    expect(traces[0]?.totals.costUsd).toBeUndefined();
  });

  it('keeps going past case files that do not load', async () => {
    await files({
      'cases/good.yaml': 'id: good\ninput: hi\nassert:\n  - output_contains: hi\n',
      'cases/bad.yaml': 'id: bad\ninput: hi\nassert:\n  - max_cost: 1\n',
    });
    const { report } = await run(() => 'hi');
    expect(report.cases.map((c) => c.id)).toEqual(['good']);
    expect(report.errors).toEqual([
      'cases/bad.yaml:4: assert.0: unknown assertion "max_cost" (did you mean max_cost_usd?)',
    ]);
  });

  it('runs at most `concurrency` runs at once, keeping report order', async () => {
    await files({ 'cases/a.yaml': 'id: a\ninput: hi\nruns: 6\nassert:\n  - max_steps: 0\n' });
    let running = 0;
    let most = 0;
    const { report } = await run(
      async (_input, ctx) => {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 7 - ctx.run));
        running--;
        return 'ok';
      },
      { concurrency: 2 },
    );
    expect(most).toBe(2);
    expect(report.cases[0]?.runs.map((r) => r.run)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("passes the case's vars to the agent and keeps them in the trace", async () => {
    await files({
      'cases/a.yaml':
        'id: a\ninput: hi\nvars: { scenario: uk-tuition, wakeup: 2 }\nassert:\n  - max_steps: 0\n',
      'cases/b.yaml': 'id: b\ninput: hi\nassert:\n  - max_steps: 0\n',
    });
    const seen: unknown[] = [];
    const { traces } = await run(
      (_input, ctx) => {
        seen.push(ctx.vars);
        return 'ok';
      },
      { concurrency: 1 },
    );
    expect(seen).toEqual([{ scenario: 'uk-tuition', wakeup: 2 }, {}]);
    expect(traces[0]?.metadata).toMatchObject({ vars: { scenario: 'uk-tuition', wakeup: 2 } });
    expect(traces[1]?.metadata).not.toHaveProperty('vars');
  });

  it('runs only the cases the filter keeps', async () => {
    await files({
      'cases/a.yaml': 'id: a\ninput: hi\ntags: [smoke]\nassert:\n  - max_steps: 0\n',
      'cases/b.yaml': 'id: b\ninput: hi\nassert:\n  - max_steps: 0\n',
    });
    const { report } = await runCases(
      { cases: 'cases/*.yaml', agent: () => 'ok' },
      { cwd: dir, filter: (c) => c.tags.includes('smoke') },
    );
    expect(report.cases.map((c) => c.id)).toEqual(['a']);
  });
});

describe('replay mode', () => {
  const recorded = (steps: Step[]): Trace =>
    sampleTrace({
      id: 'run_recorded',
      steps,
      totals: { latencyMs: 1000, steps: steps.length },
    });
  const toolStep = (name: string, args: Record<string, unknown>, result: unknown): Step => ({
    type: 'tool',
    name,
    args,
    result,
    latencyMs: 50,
  });

  const replayCase = (assertions = '  - no_tool_errors: true\n') =>
    `id: r\nfrom_trace: run_recorded\ninput: hi\nassert:\n${assertions}`;

  it('returns the recorded results without running the tools', async () => {
    await files({
      'cases/r.yaml': replayCase(),
      '.evalreplay/traces/day1.jsonl': serializeTraces([
        recorded([
          toolStep(
            'compare_routes',
            { amount: 1200, currency: 'EUR' },
            { cheapest: 'sepa', feeEur: 0.5 },
          ),
        ]),
      ]),
    });
    let ran = false;
    const { report, traces } = await run((_input, ctx) => {
      const compare = ctx.wrapTool('compare_routes', (_args: object) => {
        ran = true;
        return { cheapest: 'live' };
      });
      return `route: ${compare({ amount: 1200, currency: 'EUR' }).cheapest}`;
    });
    expect(ran).toBe(false);
    expect(report.cases[0]).toMatchObject({ mode: 'replay', pass: true });
    expect(traces[0]?.output.text).toBe('route: sepa');
    expect(traces[0]?.steps[0]).toMatchObject({
      replayed: true,
      result: { cheapest: 'sepa', feeEur: 0.5 },
    });
  });

  it('prefers the call with equal arguments, then goes in recorded order', async () => {
    await files({
      'cases/r.yaml': replayCase(),
      '.evalreplay/traces/t.jsonl': serializeTraces([
        recorded([
          toolStep('get_fx', { to: 'EUR' }, 0.0032),
          toolStep('get_fx', { to: 'GBP' }, 0.0028),
          toolStep('get_fx', { to: 'USD' }, 0.0036),
        ]),
      ]),
    });
    const seen: unknown[] = [];
    await run((_input, ctx) => {
      const fx = ctx.wrapTool('get_fx', (_args: { to: string }) => 0);
      seen.push(fx({ to: 'GBP' }), fx({ to: 'CHF' }), fx({ to: 'CHF' }));
      return 'ok';
    });
    expect(seen).toEqual([0.0028, 0.0032, 0.0036]);
  });

  it('fails a call the trace has no result for, and rethrows recorded errors', async () => {
    await files({
      'cases/r.yaml': replayCase(),
      '.evalreplay/traces/t.jsonl': serializeTraces([
        recorded([
          {
            ...toolStep('get_fx', { to: 'XYZ' }, undefined),
            error: { type: 'RangeError', message: 'unknown currency' },
          },
        ]),
      ]),
    });
    const errors: unknown[] = [];
    const { report } = await run((_input, ctx) => {
      for (const call of [
        () => ctx.callTool('get_fx', { to: 'XYZ' }, () => 0),
        () => ctx.callTool('pay', {}, () => 0),
      ]) {
        try {
          call();
        } catch (err) {
          errors.push(`${(err as Error).name}: ${(err as Error).message}`);
        }
      }
      return 'ok';
    });
    expect(errors).toEqual([
      'RangeError: unknown currency',
      'ReplayMissError: no recorded result for pay: trace run_recorded never calls it',
    ]);
    expect(report.cases[0]?.runs[0]?.assertions[0]?.message).toBe(
      'step 1 (get_fx) threw RangeError: unknown currency (also failed: step 2)',
    );
  });

  it('gives each run its own copy of the recorded results', async () => {
    await files({
      'cases/r.yaml': replayCase().replace('input: hi', 'input: hi\nruns: 2'),
      '.evalreplay/traces/t.jsonl': serializeTraces([
        recorded([toolStep('quote', {}, { fee: 1 })]),
      ]),
    });
    const fees: unknown[] = [];
    await run(
      (_input, ctx) => {
        const q = ctx.callTool('quote', {}, () => ({ fee: 0 })) as { fee: number };
        fees.push(q.fee);
        q.fee = 99;
        return 'ok';
      },
      { concurrency: 1 },
    );
    expect(fees).toEqual([1, 1]);
  });

  it('fails a case whose from_trace is missing without running it', async () => {
    await files({ 'cases/r.yaml': replayCase() });
    let ran = false;
    const { report } = await run(() => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(report.cases[0]).toMatchObject({
      pass: false,
      passRate: 0,
      runs: [],
      error: 'from_trace run_recorded is not in the trace files (`.evalreplay/traces/**/*.jsonl`)',
    });
  });

  it('reads traces from the configured files and reports bad lines', async () => {
    await files({
      'cases/r.yaml': replayCase(),
      'recordings/a.jsonl': `${serializeTraces([recorded([])])}{ nope\n`,
    });
    const { report } = await run(() => 'ok', { traces: 'recordings/*.jsonl' });
    expect(report.cases[0]?.pass).toBe(true);
    expect(report.errors).toEqual([expect.stringMatching(/^recordings\/a\.jsonl: line 2: /)]);
  });
});

describe('writeReport', () => {
  it('writes report.json, report.md and the traces', async () => {
    await files({ 'cases/pay.yaml': PAY_CASE });
    const { report, traces } = await run(payAgent);
    const paths = await writeReport(report, traces, join(dir, 'out'));
    expect(JSON.parse(await readFile(paths.json, 'utf8'))).toEqual(report);
    expect(await readFile(paths.markdown, 'utf8')).toMatch(/^# evalreplay report\n/);
    const read = parseTraces(await readFile(paths.traces, 'utf8'));
    expect(read.traces.map((t) => t.id)).toEqual(traces.map((t) => t.id));
  });
});

describe('loadConfig', () => {
  it('finds evalreplay.config.ts and loads it without a build step', async () => {
    await files({
      'evalreplay.config.ts':
        "const agent = async (): Promise<string> => 'hi';\nexport default { cases: 'cases/*.yaml', agent, concurrency: 2 };\n",
    });
    const loaded = await loadConfig(undefined, dir);
    expect(loaded.dir).toBe(dir);
    expect(loaded.config.concurrency).toBe(2);
    expect(await loaded.config.agent({ messages: [] }, {} as never)).toBe('hi');
  });

  it('reports a missing or invalid config', async () => {
    await expect(loadConfig(undefined, dir)).rejects.toThrow(
      /^no config file in .* \(expected evalreplay\.config\.ts/,
    );
    await files({ 'my.config.mjs': "export default { cases: [], agent: 'x', concurency: 2 };\n" });
    const err = await loadConfig('my.config.mjs', dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(
      /my\.config\.mjs: cases: .*; agent: expected a function; Unrecognized key: "concurency"$/,
    );
  });

  it('resolves the path aliases of the nearest tsconfig.json, in the config and case files', async () => {
    await files({
      'tsconfig.json':
        '{\n  // comments are fine\n  "compilerOptions": { "paths": { "@/*": ["./app/src/*"] } },\n}\n',
      'app/src/agent.ts': "export const answer = (): string => 'from the app';\n",
      'evalreplay.config.ts':
        "import { answer } from '@/agent';\nexport default { cases: 'cases/*.case.ts', agent: () => answer() };\n",
      'cases/a.case.ts':
        "import { answer } from '@/agent';\nexport default { id: 'a', input: 'hi', assert: [{ output_contains: answer() }] };\n",
    });
    const { config } = await loadConfig(undefined, dir);
    const { report } = await runCases(config, { cwd: dir });
    expect(report.errors).toEqual([]);
    expect(report.summary.runsPassed).toBe(1);
  });
});
