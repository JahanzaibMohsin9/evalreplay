// Runs CarryPay's agent (https://github.com/JahanzaibMohsin9/carrypay) for evalreplay, without
// changing CarryPay. A case names a scenario and a wake-up: the moment something arrives and the
// agent wakes (the family's first message, the hospital's invoice, a look-alike bank-change
// email). The wake-ups before it replay CarryPay's recorded decisions to rebuild the world; the
// wake-up under test runs in CARRYPAY_AGENT mode.
//
//   replay  (default) CarryPay's recorded live run decides, offline and free
//   live    the model decides (needs DEEPSEEK_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY)
//
// CarryPay's tools run for real in its sandbox world. Each tool call is read back from its
// ledger, where every call is logged with the input, the result and the safety gateway's decision.

import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentFn, RunContext, ToolStep } from '@evalreplay/core';
import { recordAnthropic } from '@evalreplay/recorder-anthropic';
import { recordOpenAI } from '@evalreplay/recorder-openai';
import OpenAI from 'openai';

const MODE = process.env.CARRYPAY_AGENT ?? 'replay';
if (MODE !== 'replay' && MODE !== 'live') {
  throw new Error(`CARRYPAY_AGENT must be replay or live, not ${MODE}`);
}

// CarryPay reads these when its modules load
process.env.CARRYPAY_STEP_DELAY_MS ??= '0'; // no pauses between replayed steps, which are for the demo UI
process.env.CARRYPAY_DATA_DIR ??= join(tmpdir(), 'evalreplay-carrypay'); // live runs save recordings here
// CarryPay's runtime starts a session sweep on an interval, which would keep the process alive
(globalThis as { __carrypaySweep?: NodeJS.Timeout }).__carrypaySweep ??= setInterval(
  () => {},
  1 << 30,
).unref();

// CarryPay creates its SDK clients inside its runner, so record every client the SDKs create
recordOpenAI(OpenAI);
recordAnthropic(Anthropic);

const MAX_ITERATIONS = 60;

/**
 * The CarryPay modules, loaded once on first use, after the settings above. They are imported by
 * relative path, as CarryPay's own server code imports them: on Windows, jiti gives a module
 * imported through the `@/` alias a different cache key than the same file imported relatively,
 * so the runner would get its own copy of `tools.ts` and miss CARRYPAY_BROKEN_TOOL.
 */
async function carrypay() {
  const [store, scenarios, engine, runner, evaluate, runtime, tools] = await Promise.all([
    import('./.carrypay/src/server/store'),
    import('./.carrypay/src/server/scenarios'),
    import('./.carrypay/src/server/sim/engine'),
    import('./.carrypay/src/server/agent/runner'),
    import('./.carrypay/src/server/evaluate'),
    import('./.carrypay/src/server/runtime'),
    import('./.carrypay/src/server/agent/tools'),
  ]);
  return {
    Store: store.Store,
    seedScenario: scenarios.seedScenario,
    advanceToNext: engine.advanceToNext,
    AgentRunner: runner.AgentRunner,
    evaluateRun: evaluate.evaluateRun,
    decideApprovalIn: runtime.decideApprovalIn,
    TOOLS: tools.TOOLS,
  };
}
let loaded: ReturnType<typeof carrypay> | undefined;

/**
 * For the "a tool breaks" demo: CARRYPAY_BROKEN_TOOL=verify_beneficiary makes that tool throw,
 * as an outage of the service behind it would.
 */
function breakTool(TOOLS: { name: string; run: unknown }[]) {
  const name = process.env.CARRYPAY_BROKEN_TOOL;
  const tool = name ? TOOLS.find((t) => t.name === name) : undefined;
  if (name && !tool) throw new Error(`CARRYPAY_BROKEN_TOOL: CarryPay has no tool ${name}`);
  if (tool) {
    tool.run = () => {
      throw new Error(`${name} is unavailable (simulated outage)`);
    };
  }
}

interface LedgerEntry {
  type: string;
  at: string;
  data: Record<string, unknown>;
}

/** A tool call as CarryPay logged it, as a trace step. */
function toolStep(e: LedgerEntry): ToolStep {
  const d = e.data as {
    tool: string;
    decision?: string;
    input?: Record<string, unknown>;
    result?: unknown;
    ruleIds?: string[];
    issues?: { path?: unknown[]; message?: string }[];
  };
  const error =
    e.type === 'tool.invalid'
      ? {
          type: 'InvalidInput',
          message: (d.issues ?? [])
            .map((i) => `${(i.path ?? []).join('.')}: ${i.message}`)
            .join('; '),
        }
      : d.decision === 'error'
        ? {
            message: String(
              (d.result as { error?: unknown } | undefined)?.error ?? 'the tool failed',
            ),
          }
        : null;
  return {
    type: 'tool',
    startedAt: e.at,
    name: d.tool,
    args: d.input ?? {},
    // the gateway's decision: allowed, or blocked by a safety rule
    result: {
      decision: d.decision,
      ...(d.ruleIds?.length ? { ruleIds: d.ruleIds } : {}),
      result: d.result,
    },
    error,
    latencyMs: 0,
  };
}

/** Plays a scenario up to the wake-up under test, and returns what the agent did in it. */
async function play(scenario: string, wakeup: number | 'all', ctx: RunContext) {
  if (!existsSync(join(process.cwd(), 'recordings', `${scenario}.json`))) {
    throw new Error(
      `no CarryPay recording for ${scenario} in ./recordings: run \`pnpm run fetch\` and run evalreplay from examples/carrypay`,
    );
  }
  const cp = await (loaded ??= carrypay());
  breakTool(cp.TOOLS as { name: string; run: unknown }[]);

  const dir = await mkdtemp(join(tmpdir(), 'carrypay-run-'));
  const store = new cp.Store(dir);
  try {
    store.load(() => cp.seedScenario(scenario));
    store.reset(cp.seedScenario(scenario));
    const runner = new cp.AgentRunner(store);
    runner.resetSession();

    // the runner reads the mode as each wake-up starts, so switch it the moment the one before
    // has finished
    let finished = 0;
    const modeFor = () => (wakeup === 'all' || finished >= wakeup ? MODE : 'replay');
    store.world.agent.mode = modeFor();
    store.on('logged', (e: LedgerEntry) => {
      if (e.type === 'agent.sleep') finished++;
      store.world.agent.mode = modeFor();
      // past the wake-up under test, stop the agent so nothing else runs (or costs)
      if (wakeup !== 'all' && finished > wakeup) store.world.agent.killSwitch = true;
    });

    const settle = async () => {
      await new Promise((r) => setTimeout(r, 1));
      for (
        let i = 0;
        i < 20_000 && (runner.isBusy || store.world.agent.status === 'working');
        i++
      ) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    // the loop of CarryPay's own eval: approve what the agent proposes, otherwise move time on
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (wakeup !== 'all' && finished > wakeup) break;
      const pending = Object.values(store.world.approvals).filter((a) => !a.decision);
      if (pending.length)
        for (const a of pending) cp.decideApprovalIn(store, a.id, 'approved', 'hold');
      else if (store.world.schedule.length) cp.advanceToNext(store);
      else break;
      await settle();
    }
    runner.dispose();

    // the ledger entries of the wake-up under test (all of them for an end-to-end case)
    const ledger = store.ledger as LedgerEntry[];
    const wakes = ledger.flatMap((e, i) => (e.type === 'agent.wake' ? [i] : []));
    const from = wakeup === 'all' ? 0 : wakes[wakeup];
    if (from === undefined) {
      throw new Error(`${scenario} has no wake-up ${wakeup}: the agent woke ${wakes.length} times`);
    }
    const end = wakeup === 'all' ? ledger.length : (wakes[wakeup + 1] ?? ledger.length);
    const entries = ledger.slice(from, end);
    const failure = entries.find((e) => e.type === 'agent.error');
    if (failure) throw new Error(`CarryPay's agent failed: ${String(failure.data.error)}`);

    for (const e of entries)
      if (e.type.startsWith('tool.') && typeof e.data.tool === 'string')
        ctx.recordStep(toolStep(e));
    // what the family was told, as the run's text output
    const told = entries
      .filter((e) => e.type === 'tool.message_family')
      .map((e) => String((e.data.input as { text?: unknown } | undefined)?.text ?? ''));
    const evaluation = wakeup === 'all' ? cp.evaluateRun(store.world, store.ledger) : undefined;
    return {
      text: told.join('\n\n'),
      ...(evaluation
        ? { structured: { checks: evaluation.checks, metrics: evaluation.metrics } }
        : {}),
    };
  } finally {
    // the store saves the world 150 ms after a change; let that happen before the folder goes
    await new Promise((r) => setTimeout(r, 250));
    await rm(dir, { recursive: true, force: true });
  }
}

/** The evalreplay agent: `vars.scenario` and `vars.wakeup` (a number, or `all`) pick what runs. */
export const agent: AgentFn = async (_input, ctx) => {
  const { scenario, wakeup } = ctx.vars as { scenario?: unknown; wakeup?: unknown };
  if (typeof scenario !== 'string')
    throw new Error('the case needs vars.scenario, e.g. uk-tuition');
  if (
    wakeup !== 'all' &&
    !(typeof wakeup === 'number' && Number.isInteger(wakeup) && wakeup >= 0)
  ) {
    throw new Error('the case needs vars.wakeup: a wake-up number from 0, or all');
  }
  return play(scenario, wakeup, ctx);
};
