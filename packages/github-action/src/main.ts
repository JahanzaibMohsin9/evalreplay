import type { Report } from '@evalreplay/core';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { renderComment } from './comment.js';
import { GitHub } from './github.js';

type Env = Record<string, string | undefined>;

/** An action input: GitHub passes `with:` values as INPUT_<NAME> variables. */
const input = (env: Env, name: string, fallback = '') =>
  (env[`INPUT_${name.toUpperCase()}`] ?? '').trim() || fallback;

interface PullRequestEvent {
  pull_request?: { number: number; base: { sha: string; ref: string } };
}

/** Writes a step output, in the format GitHub reads from the GITHUB_OUTPUT file. */
async function output(env: Env, name: string, value: string | number) {
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** A workflow command, such as an error annotation on the run. */
const command = (name: 'error' | 'warning' | 'notice', message: string) =>
  process.stdout.write(
    `::${name}::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`,
  );

/** Runs the project's evalreplay CLI and returns its exit code. */
function runCli(cmd: string, args: string[], cwd: string, env: Env): Promise<number> {
  // through a shell, so `npx` resolves on every runner; the paths are quoted
  const line = [cmd, ...args.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a}"`))].join(' ');
  process.stdout.write(`> ${line}\n`);
  return new Promise((resolveExit, reject) => {
    const child = spawn(line, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      shell: true,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => resolveExit(code ?? 1));
  });
}

/**
 * The action: runs the cases with the project's own evalreplay (its recorders must share the
 * runner's copy of @evalreplay/core), compares with the baseline at the pull request's base
 * commit, comments on the pull request and fails the step as the CLI does.
 */
export async function main(env: Env = process.env): Promise<number> {
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const cwd = resolve(workspace, input(env, 'working-directory', '.'));
  const cli = input(env, 'command', 'npx --no-install evalreplay');
  const extra = input(env, 'args').split(/\s+/).filter(Boolean);
  const baselinePath = input(env, 'baseline', '.evalreplay/baseline.json');
  const maxCostIncrease = input(env, 'max-cost-increase');
  const wantComment = input(env, 'comment', 'true') !== 'false';
  const token = input(env, 'github-token', env.GITHUB_TOKEN ?? '');
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (
    !(await stat(cwd).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  ) {
    command(
      'error',
      `working-directory ${relative(workspace, cwd) || '.'} is not a folder in the repository`,
    );
    return 1;
  }
  const temp = join(env.RUNNER_TEMP ?? tmpdir(), 'evalreplay');
  const outDir = join(temp, 'report');
  await mkdir(temp, { recursive: true });

  const event: PullRequestEvent = env.GITHUB_EVENT_PATH
    ? (JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')) as PullRequestEvent)
    : {};
  const pr = event.pull_request;
  const github = new GitHub(token, env.GITHUB_API_URL ?? 'https://api.github.com');

  // the baseline as the base branch has it, so a pull request can't change what it's compared with
  let baselineFile: string | undefined;
  let baseline: { label: string } | { missing: string };
  const local = resolve(cwd, baselinePath);
  if (pr && repo && token) {
    const inRepo = relative(workspace, local).split('\\').join('/');
    const base = `\`${pr.base.ref}\` (${pr.base.sha.slice(0, 7)})`;
    const text = await github.fileAt(repo, inRepo, pr.base.sha);
    if (text === undefined) {
      baseline = {
        missing: `${inRepo} isn't on ${base}; save one with \`evalreplay baseline save\` and commit it`,
      };
    } else {
      baselineFile = join(temp, 'baseline.json');
      await writeFile(baselineFile, text);
      baseline = { label: base };
    }
  } else {
    const exists = await readFile(local).then(
      () => true,
      () => false,
    );
    if (exists) baselineFile = local;
    baseline = exists ? { label: `\`${baselinePath}\`` } : { missing: `no ${baselinePath}` };
  }

  const args = [
    'run',
    '--out',
    outDir,
    ...(baselineFile ? ['--compare', baselineFile] : []),
    ...(baselineFile && maxCostIncrease ? ['--max-cost-increase', maxCostIncrease] : []),
    ...extra,
  ];
  const code = await runCli(cli, args, cwd, env);

  let report: Report;
  try {
    report = JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8')) as Report;
  } catch {
    command('error', `evalreplay exited with ${code} and wrote no report; see the log above`);
    return 1;
  }

  const runUrl =
    env.GITHUB_SERVER_URL && repo && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  const body = renderComment(report, {
    passed: code === 0,
    baseline,
    ...(runUrl ? { runUrl } : {}),
  });

  if (env.GITHUB_STEP_SUMMARY) {
    const markdown = await readFile(join(outDir, 'report.md'), 'utf8').catch(() => '');
    await appendFile(env.GITHUB_STEP_SUMMARY, `${body}\n${markdown}\n`);
  }
  if (pr && wantComment && repo && token) {
    try {
      const done = await github.upsertComment(repo, pr.number, body);
      process.stdout.write(
        `${done === 'created' ? 'Commented on' : 'Updated the comment on'} #${pr.number}\n`,
      );
    } catch (err) {
      // e.g. a pull request from a fork, whose token can't write
      command(
        'warning',
        `could not comment on the pull request (${(err as Error).message}); the results are in the job summary`,
      );
    }
  }

  const t = report.summary;
  await output(env, 'pass-rate', t.passRate);
  await output(env, 'cases', t.cases);
  await output(env, 'cases-passed', t.casesPassed);
  await output(env, 'regressions', report.comparison?.regressed.length ?? 0);
  if (t.costUsd !== undefined) await output(env, 'cost-usd', t.costUsd);
  await output(env, 'report-dir', outDir);

  if (code === 2)
    command('error', 'evalreplay stopped on a usage or config error; see the log above');
  else if (code !== 0) {
    const worse = report.comparison?.regressed.length;
    command(
      'error',
      worse
        ? `${plural(worse, 'case')} got worse than the baseline`
        : `${t.cases - t.casesPassed} of ${t.cases} cases failed`,
    );
  }
  return code === 0 ? 0 : 1;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
