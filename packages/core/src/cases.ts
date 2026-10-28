import { z } from 'zod';
import { type Message, MessageSchema, type Trace } from './trace.js';

// A case is an input plus assertions, written in YAML (`*.yaml`) or TypeScript (`*.case.ts`).
// Both use the same snake_case shape, so a case can move between the two unchanged. Case files
// are strict, unlike traces: a misspelled key in a hand-written file is an error, not ignored.

/** A JSON Schema, as an object. */
export type JsonSchema = Record<string, unknown>;

/** A custom check (TypeScript cases only): `true` passes, `false` or a message fails. */
export type CustomCheck = (trace: Trace) => boolean | string | Promise<boolean | string>;

const toolName = z.string().min(1);
const schemaRef = z
  .union([z.string().min(1), z.record(z.string(), z.unknown())])
  .describe('Path to a JSON Schema file, relative to the case file, or the schema inline');

function compiles(pattern: string, flags?: string): boolean {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

/** The value each assertion takes in a case file, keyed by assertion name. */
export const ASSERTION_SPECS = {
  tool_called: z.union([
    toolName,
    z.strictObject({ tool: toolName, times: z.int().positive().optional() }),
  ]),
  tool_not_called: toolName,
  tool_order: z.array(toolName).min(2),
  tool_args_match: z.strictObject({ tool: toolName, schema: schemaRef }),
  output_contains: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  output_matches: z
    .union([
      z.string().min(1),
      z.strictObject({ pattern: z.string().min(1), flags: z.string().optional() }),
    ])
    .refine(
      (v) => (typeof v === 'string' ? compiles(v) : compiles(v.pattern, v.flags)),
      'not a valid regular expression',
    ),
  output_schema: schemaRef,
  max_cost_usd: z.number().nonnegative(),
  max_latency_ms: z.number().nonnegative(),
  max_steps: z.int().nonnegative(),
  no_tool_errors: z.literal(true),
} as const;

export type AssertionName = keyof typeof ASSERTION_SPECS | 'custom';
export const ASSERTION_NAMES = [...Object.keys(ASSERTION_SPECS), 'custom'] as AssertionName[];

const CustomSpec = z.strictObject({
  name: z.string().min(1),
  check: z.custom<CustomCheck>((v) => typeof v === 'function', 'expected a function'),
});

/** One assertion as written in a case: a single key, e.g. `{ max_steps: 12 }`. */
export type AssertionInput =
  | {
      [K in keyof typeof ASSERTION_SPECS]: { [P in K]: z.input<(typeof ASSERTION_SPECS)[K]> };
    }[keyof typeof ASSERTION_SPECS]
  | { custom: { name: string; check: CustomCheck } };

/** A case as written in a `.yaml` file or passed to `defineCase`. */
export const CaseInputSchema = z
  .strictObject({
    id: z
      .string()
      .regex(
        /^[A-Za-z0-9][\w.-]*$/,
        'use letters, digits, ".", "_" and "-"; start with a letter or digit',
      ),
    description: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    from_trace: z
      .string()
      .min(1)
      .optional()
      .describe('Trace whose tool results replay mode returns'),
    input: z
      .union([z.string().min(1), z.strictObject({ messages: z.array(MessageSchema).min(1) })])
      .describe('A user message, or the full message list'),
    mode: z.enum(['replay', 'live']).optional(),
    runs: z
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Agents vary: run several times for a pass rate'),
    assert: z.array(z.unknown()).min(1),
  })
  .superRefine((c, ctx) => {
    if (c.mode === 'replay' && c.from_trace === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message:
          'replay mode returns recorded tool results, so it needs from_trace (or use mode: live)',
      });
    }
  });

export type CaseDefinition = Omit<z.input<typeof CaseInputSchema>, 'assert'> & {
  assert: AssertionInput[];
};

/** Declares a case in a `*.case.ts` file: `export default defineCase({ ... })`. */
export function defineCase(definition: CaseDefinition): CaseDefinition {
  return definition;
}

/** An assertion after loading: named by `kind`, schema files read, shorthands expanded. */
export type Assertion =
  | { kind: 'tool_called'; tool: string; times?: number }
  | { kind: 'tool_not_called'; tool: string }
  | { kind: 'tool_order'; tools: string[] }
  | { kind: 'tool_args_match'; tool: string; schema: JsonSchema }
  | { kind: 'output_contains'; texts: string[] }
  | { kind: 'output_matches'; pattern: string; flags?: string }
  | { kind: 'output_schema'; schema: JsonSchema }
  | { kind: 'max_cost_usd'; max: number }
  | { kind: 'max_latency_ms'; max: number }
  | { kind: 'max_steps'; max: number }
  | { kind: 'no_tool_errors' }
  | { kind: 'custom'; name: string; check: CustomCheck };

/** A loaded case, ready for the runner. */
export interface Case {
  id: string;
  description?: string;
  tags: string[];
  fromTrace?: string;
  input: { messages: Message[] };
  /** `replay` when `from_trace` is set, otherwise `live`, unless the file says otherwise. */
  mode: 'replay' | 'live';
  runs: number;
  assert: Assertion[];
  /** Absolute path of the file the case came from. */
  file: string;
}

/** A problem in a case, located by its path inside the case (e.g. `['assert', 2, 'max_steps']`). */
export interface CaseIssue {
  path: (string | number)[];
  message: string;
}

export interface NormalizeContext {
  file: string;
  /** Custom assertions hold functions, which only TypeScript cases can provide. */
  allowCustom: boolean;
  /** Reads a JSON Schema referenced by path; relative paths are relative to the case file. */
  readSchema: (path: string) => Promise<JsonSchema>;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j] ?? 0;
      row[j] = Math.min(up + 1, (row[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length] ?? 0;
}

function suggestName(name: string): string {
  // a known name that starts with what was typed (max_cost → max_cost_usd) beats a near miss
  const prefixed = ASSERTION_NAMES.find((n) => n.startsWith(name));
  const [best] = ASSERTION_NAMES.map((n) => ({ n, d: editDistance(name, n) })).sort(
    (x, y) => x.d - y.d,
  );
  const suggestion = prefixed ?? (best && best.d <= 3 ? best.n : undefined);
  return suggestion ? ` (did you mean ${suggestion}?)` : '';
}

const zodIssues = (error: z.ZodError, prefix: (string | number)[]): CaseIssue[] =>
  error.issues.map((i) => ({
    path: [...prefix, ...i.path.map((p) => (typeof p === 'symbol' ? String(p) : p))],
    message: i.message,
  }));

async function normalizeAssertion(
  item: unknown,
  path: (string | number)[],
  ctx: NormalizeContext,
): Promise<{ assertion?: Assertion; issues: CaseIssue[] }> {
  const fail = (message: string, at = path) => ({ issues: [{ path: at, message }] });
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return fail('expected one assertion, e.g. `max_steps: 12`');
  }
  const keys = Object.keys(item);
  const [name] = keys;
  if (name === undefined || keys.length !== 1) {
    return fail(
      `expected one assertion per list item, got ${keys.length ? keys.join(', ') : 'none'}`,
    );
  }
  const value = (item as Record<string, unknown>)[name];
  const at = [...path, name];

  if (name === 'custom') {
    if (!ctx.allowCustom) {
      return fail('custom assertions run a function, so they need a .case.ts file', at);
    }
    const parsed = CustomSpec.safeParse(value);
    if (!parsed.success) return { issues: zodIssues(parsed.error, at) };
    return { assertion: { kind: 'custom', ...parsed.data }, issues: [] };
  }
  if (!(name in ASSERTION_SPECS)) return fail(`unknown assertion "${name}"${suggestName(name)}`);

  const spec = ASSERTION_SPECS[name as keyof typeof ASSERTION_SPECS];
  const parsed = spec.safeParse(value);
  if (!parsed.success) return { issues: zodIssues(parsed.error, at) };

  const schemaOf = async (ref: string | JsonSchema, refPath: (string | number)[]) => {
    if (typeof ref !== 'string') return { schema: ref };
    try {
      return { schema: await ctx.readSchema(ref) };
    } catch (err) {
      return { issue: { path: refPath, message: (err as Error).message } };
    }
  };

  const v = parsed.data as never;
  switch (name as keyof typeof ASSERTION_SPECS) {
    case 'tool_called': {
      const tc = v as z.output<(typeof ASSERTION_SPECS)['tool_called']>;
      return {
        assertion:
          typeof tc === 'string'
            ? { kind: 'tool_called', tool: tc }
            : { kind: 'tool_called', ...tc },
        issues: [],
      };
    }
    case 'tool_not_called':
      return { assertion: { kind: 'tool_not_called', tool: v }, issues: [] };
    case 'tool_order':
      return { assertion: { kind: 'tool_order', tools: v }, issues: [] };
    case 'tool_args_match': {
      const tam = v as z.output<(typeof ASSERTION_SPECS)['tool_args_match']>;
      const r = await schemaOf(tam.schema, [...at, 'schema']);
      if (r.issue) return { issues: [r.issue] };
      return {
        assertion: { kind: 'tool_args_match', tool: tam.tool, schema: r.schema },
        issues: [],
      };
    }
    case 'output_contains': {
      const oc = v as string | string[];
      return {
        assertion: { kind: 'output_contains', texts: typeof oc === 'string' ? [oc] : oc },
        issues: [],
      };
    }
    case 'output_matches': {
      const om = v as z.output<(typeof ASSERTION_SPECS)['output_matches']>;
      return {
        assertion:
          typeof om === 'string'
            ? { kind: 'output_matches', pattern: om }
            : { kind: 'output_matches', ...om },
        issues: [],
      };
    }
    case 'output_schema': {
      const r = await schemaOf(v as string | JsonSchema, at);
      if (r.issue) return { issues: [r.issue] };
      return { assertion: { kind: 'output_schema', schema: r.schema }, issues: [] };
    }
    case 'max_cost_usd':
    case 'max_latency_ms':
    case 'max_steps':
      return {
        assertion: { kind: name as 'max_cost_usd' | 'max_latency_ms' | 'max_steps', max: v },
        issues: [],
      };
    case 'no_tool_errors':
      return { assertion: { kind: 'no_tool_errors' }, issues: [] };
  }
}

/** Validates a case as written and turns it into a `Case`, or reports every issue found. */
export async function normalizeCase(
  raw: unknown,
  ctx: NormalizeContext,
): Promise<{ case?: Case; issues: CaseIssue[] }> {
  const parsed = CaseInputSchema.safeParse(raw);
  if (!parsed.success) return { issues: zodIssues(parsed.error, []) };
  const c = parsed.data;

  const results = await Promise.all(
    c.assert.map((item, i) => normalizeAssertion(item, ['assert', i], ctx)),
  );
  const issues = results.flatMap((r) => r.issues);
  const assertions = results.flatMap((r) => (r.assertion ? [r.assertion] : []));
  if (issues.length) return { issues };

  return {
    case: {
      id: c.id,
      ...(c.description === undefined ? {} : { description: c.description }),
      tags: c.tags ?? [],
      ...(c.from_trace === undefined ? {} : { fromTrace: c.from_trace }),
      input:
        typeof c.input === 'string' ? { messages: [{ role: 'user', content: c.input }] } : c.input,
      mode: c.mode ?? (c.from_trace === undefined ? 'live' : 'replay'),
      runs: c.runs ?? 1,
      assert: assertions,
      file: ctx.file,
    },
    issues: [],
  };
}
