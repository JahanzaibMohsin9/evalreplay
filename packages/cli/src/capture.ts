import type { Trace } from '@evalreplay/core';
import { stringify } from 'yaml';

/** A case id from the first user message: "Pay my son's tuition" → `pay-my-sons-tuition`. */
export function caseIdFor(trace: Trace): string {
  const first = trace.input.messages.find((m) => m.role === 'user')?.content;
  const words = (typeof first === 'string' ? first : '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.length ? words.join('-') : `captured-${trace.id.slice(-8).toLowerCase()}`;
}

/** Rounds a cost limit up to two significant figures: 0.01234 → 0.013. */
const roundUp = (n: number) => {
  if (n <= 0) return 0;
  const scale = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Number((Math.ceil(n / scale) * scale).toPrecision(2));
};

/**
 * A case file for a recorded run: its input, replayed against its own tool results, with
 * assertions that describe what the run did. They are a starting point to edit, not a judgment
 * of what the agent should do.
 */
export function caseFromTrace(trace: Trace, id = caseIdFor(trace)): string {
  const tools = trace.steps.flatMap((s) => (s.type === 'tool' ? [s] : []));
  const names = [...new Set(tools.map((t) => t.name))];
  const assert: Record<string, unknown>[] = names.map((name) => ({ tool_called: name }));
  if (names.length > 1) assert.push({ tool_order: names });
  if (tools.length && tools.every((t) => !t.error)) assert.push({ no_tool_errors: true });
  // headroom, since the agent can take a different but fine path next time
  assert.push({ max_steps: Math.max(1, Math.ceil(trace.steps.length * 1.5)) });
  const cost = trace.totals.costUsd;
  if (cost !== undefined && cost > 0) assert.push({ max_cost_usd: roundUp(cost * 1.5) });

  const messages = trace.input.messages;
  const only = messages[0];
  const input =
    messages.length === 1 && only?.role === 'user' && typeof only.content === 'string'
      ? only.content
      : { messages };

  const header = [
    `# Captured from ${trace.id} (${trace.agent.name}, ${trace.startedAt}).`,
    '# The assertions describe what that run did. Edit them to say what the agent must do,',
    '# e.g. add tool_not_called for tools that need approval, or output_contains for the answer.',
  ];
  const body = stringify(
    { id, from_trace: trace.id, input, assert },
    { lineWidth: 100, flowCollectionPadding: true },
  );
  return `${header.join('\n')}\n${body}`;
}
