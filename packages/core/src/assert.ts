import type { Assertion, Case } from './cases.js';
import { compileSchema, describeSchemaErrors } from './schema.js';
import type { ErrorInfo, Step, ToolStep, Trace } from './trace.js';

/** The outcome of one assertion against one trace. */
export interface AssertionResult {
  assertion: Assertion;
  /** The assertion as written, e.g. `tool_called: compare_routes`. */
  label: string;
  pass: boolean;
  /** What was found: why the assertion failed, or what satisfied it. */
  message: string;
  /** Index in `trace.steps` of the step that broke the assertion, when one did. Messages count steps from 1. */
  stepIndex?: number;
}

/** The outcome of one case against one trace. */
export interface CaseResult {
  caseId: string;
  traceId: string;
  /** Every assertion passed and the run itself didn't fail. */
  pass: boolean;
  results: AssertionResult[];
  /** The run's own error (`trace.error`): the case fails even if every assertion passed. */
  runError?: ErrorInfo;
}

type Outcome = Pick<AssertionResult, 'pass' | 'message' | 'stepIndex'>;

const ok = (message: string): Outcome => ({ pass: true, message });
const fail = (message: string, stepIndex?: number): Outcome =>
  stepIndex === undefined ? { pass: false, message } : { pass: false, message, stepIndex };

interface CallAt {
  index: number;
  step: ToolStep;
}

const callsOf = (trace: Trace, tool?: string): CallAt[] =>
  trace.steps.flatMap((step, index) =>
    step.type === 'tool' && (tool === undefined || step.name === tool) ? [{ index, step }] : [],
  );

const stepAt = (index: number) => `step ${index + 1}`;
const stepsAt = (indexes: number[]) =>
  indexes.length === 1 ? stepAt(indexes[0] ?? 0) : `steps ${indexes.map((i) => i + 1).join(', ')}`;
const at = (calls: CallAt[]) => stepsAt(calls.map((c) => c.index));
const times = (n: number) => (n === 1 ? 'once' : `${n} times`);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const stepName = (step: Step) => (step.type === 'llm' ? step.model : step.name);
const usd = (n: number) => `$${n.toFixed(6).replace(/\.?0+$/, '')}`;
const quote = (text: string, max = 120) =>
  JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);

/** Index of the step with the largest `value`, or undefined for a trace with no steps. */
function maxStep(trace: Trace, value: (step: Step) => number): number | undefined {
  let best: number | undefined;
  trace.steps.forEach((step, i) => {
    if (best === undefined || value(step) > value(trace.steps[best] as Step)) best = i;
  });
  return best;
}

function noOutput(trace: Trace, what: string): Outcome {
  const why = trace.error ? ` (the run failed: ${trace.error.message})` : '';
  return fail(`the run has no ${what}${why}`);
}

function toolsCalled(trace: Trace): string {
  const names = [...new Set(callsOf(trace).map((c) => c.step.name))];
  return names.length ? `tools called: ${names.join(', ')}` : 'no tools were called';
}

/** The assertion as a short label, e.g. `max_cost_usd: 0.25`. */
export function describeAssertion(a: Assertion): string {
  switch (a.kind) {
    case 'tool_called':
      return `tool_called: ${a.tool}${a.times === undefined ? '' : ` (${times(a.times)})`}`;
    case 'tool_not_called':
    case 'tool_args_match':
      return `${a.kind}: ${a.tool}`;
    case 'tool_order':
      return `tool_order: ${a.tools.join(' → ')}`;
    case 'output_contains':
      return `output_contains: ${a.texts.map((t) => JSON.stringify(t)).join(', ')}`;
    case 'output_matches':
      return `output_matches: /${a.pattern}/${a.flags ?? ''}`;
    case 'output_schema':
    case 'no_tool_errors':
      return a.kind;
    case 'max_cost_usd':
    case 'max_latency_ms':
    case 'max_steps':
      return `${a.kind}: ${a.max}`;
    case 'custom':
      return `custom: ${a.name}`;
  }
}

async function check(a: Assertion, trace: Trace): Promise<Outcome> {
  switch (a.kind) {
    case 'tool_called': {
      const calls = callsOf(trace, a.tool);
      if (!calls.length) return fail(`${a.tool} was never called (${toolsCalled(trace)})`);
      const found = `${a.tool} was called ${times(calls.length)} (${at(calls)})`;
      if (a.times !== undefined && calls.length !== a.times) {
        return fail(`${found}, expected ${times(a.times)}`, calls[a.times]?.index);
      }
      return ok(found);
    }

    case 'tool_not_called': {
      const calls = callsOf(trace, a.tool);
      if (calls.length) {
        return fail(`${a.tool} was called ${times(calls.length)} (${at(calls)})`, calls[0]?.index);
      }
      return ok(`${a.tool} was never called`);
    }

    case 'tool_order': {
      // earliest match for each tool in turn: other calls may come in between
      const matched: number[] = [];
      for (const [k, tool] of a.tools.entries()) {
        const after = matched.at(-1) ?? -1;
        const next = trace.steps.findIndex(
          (s, i) => i > after && s.type === 'tool' && s.name === tool,
        );
        if (next !== -1) {
          matched.push(next);
          continue;
        }
        const calls = callsOf(trace, tool);
        if (!calls.length) return fail(`${tool} was never called (${toolsCalled(trace)})`);
        return fail(
          `${tool} was not called after ${a.tools[k - 1]} (${stepAt(after)}); it was called at ${at(calls)}`,
          calls[0]?.index,
        );
      }
      return ok(`called in order at ${stepsAt(matched)}`);
    }

    case 'tool_args_match': {
      const calls = callsOf(trace, a.tool);
      if (!calls.length) return fail(`${a.tool} was never called, so it has no arguments to check`);
      const validate = compileSchema(a.schema);
      const invalid: { index: number; errors: string }[] = [];
      for (const c of calls) {
        if (!validate(c.step.args)) {
          invalid.push({ index: c.index, errors: describeSchemaErrors(validate.errors, 'args') });
        }
      }
      const [first, ...rest] = invalid;
      if (first) {
        const more = rest.length ? ` (also invalid: ${stepsAt(rest.map((r) => r.index))})` : '';
        return fail(`${stepAt(first.index)}: ${first.errors}${more}`, first.index);
      }
      return ok(
        `arguments valid in ${calls.length === 1 ? 'the call' : `all ${calls.length} calls`} (${at(calls)})`,
      );
    }

    case 'output_contains': {
      const text = trace.output.text;
      if (text === undefined) return noOutput(trace, 'text output');
      const missing = a.texts.filter((t) => !text.includes(t));
      if (missing.length) {
        const list = missing.map((t) => JSON.stringify(t)).join(', ');
        return fail(`output does not contain ${list}; output: ${quote(text)}`);
      }
      return ok(`output contains ${a.texts.map((t) => JSON.stringify(t)).join(', ')}`);
    }

    case 'output_matches': {
      const text = trace.output.text;
      if (text === undefined) return noOutput(trace, 'text output');
      const match = new RegExp(a.pattern, a.flags).exec(text);
      if (!match) return fail(`output does not match; output: ${quote(text)}`);
      return ok(`output matches at ${quote(match[0])}`);
    }

    case 'output_schema': {
      let value = trace.output.structured;
      let source = 'structured output';
      if (value === undefined) {
        const text = trace.output.text;
        if (text === undefined) return noOutput(trace, 'structured or text output');
        try {
          value = JSON.parse(text);
        } catch {
          return fail(`the run has no structured output and its text is not JSON: ${quote(text)}`);
        }
        source = 'text output, parsed as JSON,';
      }
      const validate = compileSchema(a.schema);
      if (!validate(value)) return fail(describeSchemaErrors(validate.errors, 'output'));
      return ok(`${source} is valid`);
    }

    case 'max_cost_usd': {
      const cost = trace.totals.costUsd;
      if (cost === undefined) {
        const i = trace.steps.findIndex((s) => s.type === 'llm' && s.costUsd === undefined);
        const step = trace.steps[i];
        return step
          ? fail(`the cost is unknown: ${stepAt(i)} (${stepName(step)}) has no price`, i)
          : fail('the cost is unknown: the trace has no totals.costUsd');
      }
      if (cost > a.max) {
        const i = maxStep(trace, (s) => (s.type === 'llm' ? (s.costUsd ?? 0) : 0));
        const step = i === undefined ? undefined : trace.steps[i];
        const top =
          i !== undefined && step?.type === 'llm'
            ? `; most expensive: ${stepAt(i)} (${step.model}, ${usd(step.costUsd ?? 0)})`
            : '';
        return fail(`cost ${usd(cost)}, over the ${usd(a.max)} limit${top}`, top ? i : undefined);
      }
      return ok(`cost ${usd(cost)} (limit ${usd(a.max)})`);
    }

    case 'max_latency_ms': {
      const ms = trace.totals.latencyMs;
      if (ms > a.max) {
        const i = maxStep(trace, (s) => s.latencyMs);
        const step = i === undefined ? undefined : trace.steps[i];
        const top =
          i !== undefined && step
            ? `; slowest: ${stepAt(i)} (${stepName(step)}, ${step.latencyMs} ms)`
            : '';
        return fail(`took ${ms} ms, over the ${a.max} ms limit${top}`, i);
      }
      return ok(`took ${ms} ms (limit ${a.max} ms)`);
    }

    case 'max_steps': {
      const n = trace.steps.length;
      if (n > a.max) return fail(`${count(n, 'step')}, over the limit of ${a.max}`, a.max);
      return ok(`${count(n, 'step')} (limit ${a.max})`);
    }

    case 'no_tool_errors': {
      const calls = callsOf(trace);
      const errored = calls.filter((c) => c.step.error);
      const [first, ...rest] = errored;
      if (first?.step.error) {
        const { type, message } = first.step.error;
        const more = rest.length ? ` (also failed: ${at(rest)})` : '';
        return fail(
          `${stepAt(first.index)} (${first.step.name}) threw ${type ? `${type}: ` : ''}${message}${more}`,
          first.index,
        );
      }
      return ok(
        calls.length
          ? `no tool call threw (${count(calls.length, 'call')})`
          : 'no tools were called',
      );
    }

    case 'custom': {
      // a copy, so a check that changes the trace can't affect the assertions after it
      const copy = structuredClone(trace);
      let returned: unknown;
      try {
        returned = await a.check(copy);
      } catch (err) {
        return fail(`check threw: ${(err as Error).message}`);
      }
      if (returned === true) return ok('check returned true');
      if (returned === false) return fail('check returned false');
      if (typeof returned === 'string') return fail(returned || 'check failed');
      return fail(`check returned ${typeof returned}; return true, false or a message`);
    }
  }
}

/** Checks one assertion against a trace. Never throws: a check that can't run is a failure. */
export async function evaluateAssertion(a: Assertion, trace: Trace): Promise<AssertionResult> {
  const label = describeAssertion(a);
  try {
    return { assertion: a, label, ...(await check(a, trace)) };
  } catch (err) {
    return {
      assertion: a,
      label,
      pass: false,
      message: `could not check: ${(err as Error).message}`,
    };
  }
}

/** Checks the assertions in order, returning one result per assertion. */
export async function evaluateAssertions(
  assertions: readonly Assertion[],
  trace: Trace,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const a of assertions) results.push(await evaluateAssertion(a, trace));
  return results;
}

/** Checks every assertion of a case against one run of it. */
export async function evaluateCase(c: Case, trace: Trace): Promise<CaseResult> {
  const results = await evaluateAssertions(c.assert, trace);
  return {
    caseId: c.id,
    traceId: trace.id,
    pass: trace.error === undefined && results.every((r) => r.pass),
    results,
    ...(trace.error === undefined ? {} : { runError: trace.error }),
  };
}
