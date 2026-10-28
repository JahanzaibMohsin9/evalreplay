import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleTrace } from './fixtures.js';
import { loadCaseFile, loadCases } from './load.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'evalreplay-cases-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes files (path relative to the temp dir → content) and returns the temp dir. */
async function files(contents: Record<string, string>): Promise<string> {
  for (const [path, text] of Object.entries(contents)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

const errorsOf = async (file: string, text: string) => {
  await files({ [file]: text });
  return (await loadCaseFile(file, { cwd: dir })).errors.map((e) => e.message);
};

const COMPARE_ROUTES_SCHEMA = JSON.stringify({
  type: 'object',
  required: ['amount', 'currency'],
  properties: { amount: { type: 'number' }, currency: { type: 'string' } },
});

// the example from PLAN.md 3.2, minus the judge (not supported yet)
const PAY_TUITION = `
id: pay-tuition-eur
from_trace: run_01JB3K6Z0Q8N4V7X2C5M9T1R6D
input:
  messages:
    - role: user
      content: "Pay my son's tuition invoice to TU Munich"
mode: replay
runs: 5
assert:
  - tool_called: compare_routes
  - tool_not_called: execute_payment
  - tool_args_match: { tool: compare_routes, schema: ../schemas/compare_routes.json }
  - max_cost_usd: 0.25
  - max_steps: 12
  - output_contains: "approval"
`;

describe('YAML cases', () => {
  it('loads the PLAN.md example and reads the schema file next to it', async () => {
    await files({
      'cases/payments/pay-tuition.yaml': PAY_TUITION,
      'cases/schemas/compare_routes.json': COMPARE_ROUTES_SCHEMA,
    });

    const { cases, errors } = await loadCases('cases/**/*.yaml', { cwd: dir });

    expect(errors).toEqual([]);
    expect(cases).toEqual([
      {
        id: 'pay-tuition-eur',
        tags: [],
        fromTrace: 'run_01JB3K6Z0Q8N4V7X2C5M9T1R6D',
        input: {
          messages: [{ role: 'user', content: "Pay my son's tuition invoice to TU Munich" }],
        },
        mode: 'replay',
        runs: 5,
        vars: {},
        assert: [
          { kind: 'tool_called', tool: 'compare_routes' },
          { kind: 'tool_not_called', tool: 'execute_payment' },
          {
            kind: 'tool_args_match',
            tool: 'compare_routes',
            schema: JSON.parse(COMPARE_ROUTES_SCHEMA),
          },
          { kind: 'max_cost_usd', max: 0.25 },
          { kind: 'max_steps', max: 12 },
          { kind: 'output_contains', texts: ['approval'] },
        ],
        file: join(dir, 'cases/payments/pay-tuition.yaml'),
      },
    ]);
  });

  it('expands shorthands and picks defaults', async () => {
    await files({
      'a.yaml': `
id: a
input: Hello
assert:
  - output_matches: { pattern: "^hi", flags: i }
  - tool_order: [search, answer]
  - tool_called: { tool: search, times: 2 }
  - no_tool_errors: true
`,
      'b.yaml': `
id: b
from_trace: run_1
input: Hello
assert: [{ max_latency_ms: 3000 }]
`,
    });

    const { cases, errors } = await loadCases('*.yaml', { cwd: dir });

    expect(errors).toEqual([]);
    const [a, b] = cases;
    expect(a).toMatchObject({
      input: { messages: [{ role: 'user', content: 'Hello' }] },
      mode: 'live', // no recorded trace to replay
      runs: 1,
      assert: [
        { kind: 'output_matches', pattern: '^hi', flags: 'i' },
        { kind: 'tool_order', tools: ['search', 'answer'] },
        { kind: 'tool_called', tool: 'search', times: 2 },
        { kind: 'no_tool_errors' },
      ],
    });
    expect(b).toMatchObject({ mode: 'replay', fromTrace: 'run_1' });
  });

  it('reads several cases from one file, one per YAML document', async () => {
    await files({
      'many.yaml':
        'id: one\ninput: hi\nassert: [{ max_steps: 1 }]\n---\nid: two\ninput: hi\nassert: [{ max_steps: 2 }]\n---\n',
    });
    const { cases, errors } = await loadCases('many.yaml', { cwd: dir });
    expect(errors).toEqual([]);
    expect(cases.map((c) => c.id)).toEqual(['one', 'two']);
  });
});

describe('YAML case errors point to the file and line', () => {
  it('a value of the wrong type', async () => {
    const yaml = 'id: x\ninput: hi\nassert:\n  - max_steps: 12\n  - max_cost_usd: cheap\n';
    expect(await errorsOf('x.yaml', yaml)).toEqual([
      'x.yaml:5: assert.1.max_cost_usd: Invalid input: expected number, received string',
    ]);
  });

  it('an unknown assertion, with a suggestion', async () => {
    const yaml = 'id: x\ninput: hi\nassert:\n  - max_cost: 0.25\n';
    expect(await errorsOf('x.yaml', yaml)).toEqual([
      'x.yaml:4: assert.0: unknown assertion "max_cost" (did you mean max_cost_usd?)',
    ]);
    expect(await errorsOf('y.yaml', 'id: y\ninput: hi\nassert:\n  - tool_caled: a\n')).toEqual([
      'y.yaml:4: assert.0: unknown assertion "tool_caled" (did you mean tool_called?)',
    ]);
    expect(await errorsOf('z.yaml', 'id: z\ninput: hi\nassert:\n  - sentiment: 1\n')).toEqual([
      'z.yaml:4: assert.0: unknown assertion "sentiment"',
    ]);
  });

  it('two assertions in one list item', async () => {
    const yaml = 'id: x\ninput: hi\nassert:\n  - max_steps: 3\n    max_cost_usd: 1\n';
    expect(await errorsOf('x.yaml', yaml)).toEqual([
      'x.yaml:4: assert.0: expected one assertion per list item, got max_steps, max_cost_usd',
    ]);
  });

  it('a misspelled top-level key', async () => {
    const yaml = 'id: x\ninput: hi\nasserts:\n  - max_steps: 3\n';
    const errors = await errorsOf('x.yaml', yaml);
    expect(errors).toContain('x.yaml:1: Unrecognized key: "asserts"');
    expect(errors).toContain('x.yaml:1: assert: Invalid input: expected array, received undefined');
  });

  it('replay mode without a trace to replay', async () => {
    const yaml = 'id: x\ninput: hi\nmode: replay\nassert: [{ max_steps: 3 }]\n';
    expect(await errorsOf('x.yaml', yaml)).toEqual([
      'x.yaml:3: mode: replay mode returns recorded tool results, so it needs from_trace (or use mode: live)',
    ]);
  });

  it('a regular expression that does not compile', async () => {
    const yaml = 'id: x\ninput: hi\nassert:\n  - output_matches: "(unclosed"\n';
    expect(await errorsOf('x.yaml', yaml)).toEqual([
      'x.yaml:4: assert.0.output_matches: not a valid regular expression',
    ]);
  });

  it('a schema file that is missing or not JSON', async () => {
    await files({ 'bad.json': '{ nope' });
    const yaml =
      'id: x\ninput: hi\nassert:\n' +
      '  - tool_args_match: { tool: a, schema: missing.json }\n' +
      '  - output_schema: bad.json\n';
    expect(await errorsOf('x.yaml', yaml)).toEqual([
      'x.yaml:4: assert.0.tool_args_match.schema: cannot read schema file missing.json',
      expect.stringMatching(
        /^x\.yaml:5: assert\.1\.output_schema: schema file bad\.json is not a JSON object/,
      ),
    ]);
  });

  it('a JSON Schema that does not compile', async () => {
    await files({
      'odd.json': JSON.stringify({ $schema: 'http://json-schema.org/draft-04/schema#' }),
    });
    const yaml =
      'id: x\ninput: hi\nassert:\n' +
      '  - output_schema: { type: nope }\n' +
      '  - tool_args_match: { tool: a, schema: odd.json }\n';
    expect(await errorsOf('x.yaml', yaml)).toEqual([
      expect.stringMatching(/^x\.yaml:4: assert\.0\.output_schema: invalid JSON Schema: .*type/),
      'x.yaml:5: assert.1.tool_args_match.schema: invalid JSON Schema in odd.json: ' +
        'unsupported $schema http://json-schema.org/draft-04/schema# (use draft-07, 2019-09 or 2020-12)',
    ]);
  });

  it('a custom assertion, which needs TypeScript', async () => {
    const yaml = 'id: x\ninput: hi\nassert:\n  - custom: { name: n }\n';
    expect(await errorsOf('x.yaml', yaml)).toEqual([
      'x.yaml:4: assert.0.custom: custom assertions run a function, so they need a .case.ts file',
    ]);
  });

  it('YAML that does not parse', async () => {
    const errors = await errorsOf('x.yaml', 'id: x\ninput: [unclosed\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^x\.yaml:\d+: /);
  });
});

describe('TypeScript cases', () => {
  it('loads defineCase with a custom check that still runs', async () => {
    await files({
      'cases/fees.case.ts': `
type Trace = { output: { text?: string } };
export default {
  id: 'explains-fees',
  input: 'How much does the transfer cost?',
  assert: [
    { max_steps: 6 },
    {
      custom: {
        name: 'mentions a fee',
        check: (trace: Trace): boolean | string =>
          /fee/i.test(trace.output.text ?? '') || 'the answer never mentions a fee',
      },
    },
  ],
};
`,
    });

    const { cases, errors } = await loadCases('cases/*.case.ts', { cwd: dir });

    expect(errors).toEqual([]);
    const custom = cases[0]?.assert[1];
    expect(custom).toMatchObject({ kind: 'custom', name: 'mentions a fee' });
    if (custom?.kind !== 'custom') throw new Error('expected a custom assertion');
    expect(await custom.check(sampleTrace())).toBe('the answer never mentions a fee');
    expect(await custom.check(sampleTrace({ output: { text: 'The fee is 4.50' } }))).toBe(true);
  });

  it('loads an array of cases from one module', async () => {
    await files({
      'pair.case.ts': `export default [
  { id: 'one', input: 'hi', assert: [{ max_steps: 1 }] },
  { id: 'two', input: 'hi', assert: [{ max_steps: 'two' }] },
];`,
    });
    const { cases, errors } = await loadCaseFile('pair.case.ts', { cwd: dir });
    expect(cases.map((c) => c.id)).toEqual(['one']);
    expect(errors.map((e) => e.message)).toEqual([
      'pair.case.ts: 1.assert.0.max_steps: Invalid input: expected number, received string',
    ]);
  });

  it('reports a module without a default export', async () => {
    await files({ 'none.case.ts': 'export const x = 1;' });
    const { errors } = await loadCaseFile('none.case.ts', { cwd: dir });
    expect(errors.map((e) => e.message)).toEqual([
      'none.case.ts: no default export; use `export default defineCase({ ... })`',
    ]);
  });
});

describe('loadCases', () => {
  it('reports a duplicate case id and keeps the first', async () => {
    await files({
      'a.yaml': 'id: same\ninput: hi\nassert: [{ max_steps: 1 }]\n',
      'b.yaml': 'id: same\ninput: hi\nassert: [{ max_steps: 2 }]\n',
    });
    const { cases, errors } = await loadCases('*.yaml', { cwd: dir });
    expect(cases).toHaveLength(1);
    expect(cases[0]?.assert).toEqual([{ kind: 'max_steps', max: 1 }]);
    expect(errors.map((e) => e.message)).toEqual([
      'b.yaml: duplicate case id "same" (also in a.yaml)',
    ]);
  });

  it('reports patterns that match nothing', async () => {
    const { errors } = await loadCases('cases/**/*.yaml', { cwd: dir });
    expect(errors.map((e) => e.message)).toEqual(['no case files match cases/**/*.yaml']);
  });
});
