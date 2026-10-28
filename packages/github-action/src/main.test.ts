import type { Report } from '@evalreplay/core';
import { type Server, createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKER, renderComment } from './comment.js';
import { main } from './main.js';

// A fake evalreplay CLI (writes the report it is told to, exits as told) and a fake GitHub API.

const REPORT: Report = {
  version: 1,
  startedAt: '2026-10-28T12:00:00.000Z',
  durationMs: 10_300,
  summary: { cases: 2, casesPassed: 1, runs: 2, runsPassed: 1, passRate: 0.5 },
  errors: [],
  cases: [
    {
      id: 'th-bank-change-scam',
      file: 'cases/th-medical/decisions.yaml',
      mode: 'replay',
      tags: [],
      pass: true,
      passed: 1,
      passRate: 1,
      runs: [{ run: 1, traceId: 'run_a', pass: true, latencyMs: 800, steps: 7, assertions: [] }],
    },
    {
      id: 'th-deposit-invoice',
      file: 'cases/th-medical/decisions.yaml',
      mode: 'replay',
      tags: [],
      pass: false,
      passed: 0,
      passRate: 0,
      runs: [
        {
          run: 1,
          traceId: 'run_b',
          pass: false,
          latencyMs: 500,
          steps: 9,
          assertions: [
            {
              label: 'no_tool_errors',
              pass: false,
              message: 'step 4 (verify_beneficiary) threw verify_beneficiary is unavailable',
              stepIndex: 3,
            },
          ],
        },
      ],
    },
  ],
};

const COMPARISON: NonNullable<Report['comparison']> = {
  baseline: { startedAt: '2026-10-27T12:00:00.000Z', passRate: 1 },
  current: { startedAt: REPORT.startedAt, passRate: 0.5 },
  regressed: [
    {
      id: 'th-deposit-invoice',
      before: { passRate: 1, runs: 1 },
      after: { passRate: 0, runs: 1 },
      regressions: ['pass rate 100% → 0%'],
    },
  ],
  improved: [],
  added: [],
  removed: [],
};

let dir: string;
let server: Server;
let api: string;
let requests: { method: string; url: string; body: string }[];
let comments: { id: number; body: string }[];
let baselineOnBase: string | undefined;
let canWrite: boolean;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'evalreplay-action-'));
  requests = [];
  comments = [];
  baselineOnBase = JSON.stringify({ ...REPORT, summary: { ...REPORT.summary, passRate: 1 } });
  canWrite = true;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      const send = (status: number, data?: unknown) => {
        res.statusCode = status;
        res.end(data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data));
      };
      const url = req.url ?? '';
      if (url.startsWith('/repos/me/agent/contents/')) {
        return baselineOnBase === undefined
          ? send(404, { message: 'Not Found' })
          : send(200, baselineOnBase);
      }
      if (url.startsWith('/repos/me/agent/issues/7/comments') && req.method === 'GET')
        return send(200, comments);
      if (!canWrite) return send(403, { message: 'Resource not accessible by integration' });
      if (req.method === 'POST') {
        comments.push({ id: 100 + comments.length, body: JSON.parse(body).body });
        return send(201, {});
      }
      if (req.method === 'PATCH') {
        const id = Number(url.split('/').at(-1));
        const c = comments.find((x) => x.id === id);
        if (c) c.body = JSON.parse(body).body;
        return send(200, {});
      }
      send(404);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // the fake CLI: writes report.json (with a comparison when --compare is given) into --out
  await writeFile(
    join(dir, 'fake-cli.mjs'),
    `import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const at = (f) => args[args.indexOf(f) + 1];
const report = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'report.json'))}, 'utf8'));
writeFileSync(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(args));
if (args.includes('--compare')) report.comparison = ${JSON.stringify(COMPARISON)};
if (process.env.FAKE_NO_REPORT) process.exit(2);
mkdirSync(at('--out'), { recursive: true });
writeFileSync(at('--out') + '/report.json', JSON.stringify(report));
writeFileSync(at('--out') + '/report.md', '# evalreplay report\\n');
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`,
  );
  await writeFile(join(dir, 'report.json'), JSON.stringify(REPORT));
  await writeFile(
    join(dir, 'event.json'),
    JSON.stringify({ pull_request: { number: 7, base: { sha: 'abc1234def', ref: 'main' } } }),
  );
});

afterEach(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const env = (overrides: Record<string, string | undefined> = {}) => ({
  GITHUB_WORKSPACE: dir,
  GITHUB_REPOSITORY: 'me/agent',
  GITHUB_EVENT_PATH: join(dir, 'event.json'),
  GITHUB_API_URL: api,
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '42',
  GITHUB_OUTPUT: join(dir, 'output.txt'),
  GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
  RUNNER_TEMP: join(dir, 'temp'),
  INPUT_COMMAND: `node ${JSON.stringify(join(dir, 'fake-cli.mjs'))}`,
  'INPUT_GITHUB-TOKEN': 'test-token',
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  ...overrides,
});

const args = async () => JSON.parse(await readFile(join(dir, 'args.json'), 'utf8')) as string[];

describe('the action on a pull request', () => {
  it("compares with the base commit's baseline, comments, and writes the outputs and summary", async () => {
    expect(await main(env({ FAKE_EXIT: '1' }))).toBe(1);

    const contents = requests.find((r) => r.url.includes('/contents/'));
    expect(contents?.url).toBe('/repos/me/agent/contents/.evalreplay/baseline.json?ref=abc1234def');
    const a = await args();
    expect(a.slice(0, 2)).toEqual(['run', '--out']);
    expect(a[a.indexOf('--compare') + 1]).toBe(join(dir, 'temp', 'evalreplay', 'baseline.json'));

    expect(comments).toHaveLength(1);
    const body = comments[0]?.body ?? '';
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain('## ❌ evalreplay');
    expect(body).toContain('Compared with `main` (abc1234): pass rate 100% → 50%.');
    expect(body).toContain('| th-deposit-invoice | 100% | 0% | pass rate 100% → 0% |');
    expect(body).toContain('[Full report](https://github.com/me/agent/actions/runs/42)');

    const out = await readFile(join(dir, 'output.txt'), 'utf8');
    expect(out).toContain('pass-rate=0.5\n');
    expect(out).toContain('regressions=1\n');
    expect(await readFile(join(dir, 'summary.md'), 'utf8')).toContain('# evalreplay report');
  });

  it('updates its own comment on the next run instead of adding one', async () => {
    comments.push({ id: 1, body: 'LGTM' }, { id: 2, body: `${MARKER}\nold` });
    expect(await main(env())).toBe(0);
    expect(comments.map((c) => c.id)).toEqual([1, 2]);
    expect(comments[1]?.body).toContain('## ✅ evalreplay');
  });

  it('says so when the base branch has no baseline, and runs without --compare', async () => {
    baselineOnBase = undefined;
    expect(await main(env())).toBe(0);
    expect(await args()).not.toContain('--compare');
    expect(comments[0]?.body).toContain(
      "No baseline to compare with: .evalreplay/baseline.json isn't on `main` (abc1234)",
    );
  });

  it('reads the baseline next to working-directory and passes args through', async () => {
    await mkdir(join(dir, 'examples', 'carrypay'), { recursive: true });
    await main(
      env({
        'INPUT_WORKING-DIRECTORY': 'examples/carrypay',
        INPUT_ARGS: '--tag smoke',
        'INPUT_MAX-COST-INCREASE': '50',
      }),
    );
    expect(requests.find((r) => r.url.includes('/contents/'))?.url).toContain(
      '/contents/examples/carrypay/.evalreplay/baseline.json?',
    );
    expect((await args()).slice(-4)).toEqual(['--max-cost-increase', '50', '--tag', 'smoke']);
  }, 15_000);

  it("doesn't fail the step when it can't comment, e.g. on a fork", async () => {
    canWrite = false;
    expect(await main(env())).toBe(0);
    expect(comments).toHaveLength(0);
  });

  it('fails clearly when working-directory is missing', async () => {
    expect(await main(env({ 'INPUT_WORKING-DIRECTORY': 'nope' }))).toBe(1);
    expect(requests).toEqual([]);
  });

  it('fails when the CLI writes no report', async () => {
    expect(await main(env({ FAKE_NO_REPORT: '1' }))).toBe(1);
    expect(comments).toHaveLength(0);
  });
});

describe('the action on a push', () => {
  it('uses the baseline in the working tree and comments nowhere', async () => {
    await mkdir(join(dir, '.evalreplay'));
    await writeFile(join(dir, '.evalreplay', 'baseline.json'), JSON.stringify(REPORT));
    await writeFile(join(dir, 'event.json'), JSON.stringify({ ref: 'refs/heads/main' }));
    expect(await main(env())).toBe(0);
    expect((await args()).includes('--compare')).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe('renderComment', () => {
  it('lists every failure in a collapsed section', () => {
    const body = renderComment(REPORT, { passed: false, baseline: { missing: 'none yet' } });
    expect(body).toContain('**1 of 2 cases passed** · 1 of 2 runs (50%) · cost unknown · 10.3 s');
    expect(body).toContain('<details><summary>1 failing case</summary>');
    expect(body).toContain(
      '  - `no_tool_errors`: step 4 (verify_beneficiary) threw verify_beneficiary is unavailable',
    );
  });

  it('keeps messages from breaking the table', () => {
    const report = {
      ...REPORT,
      comparison: {
        ...COMPARISON,
        regressed: COMPARISON.regressed.map((r) => ({ ...r, regressions: ['a | b\nc'] })),
      },
    };
    expect(renderComment(report, { passed: false, baseline: { label: 'main' } })).toContain(
      '| a \\| b c |',
    );
  });
});
