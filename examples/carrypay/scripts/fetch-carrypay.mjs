// Fetches CarryPay at a pinned commit into .carrypay/ and copies its recorded runs to
// recordings/, where CarryPay's replay mode looks for them (relative to the working directory).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/JahanzaibMohsin9/carrypay.git';
// CarryPay main on 28 Oct 2026; bump it to test a newer CarryPay
const COMMIT = '4fb5b917d3aebb00288fbcd182c296904d61f843';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, '.carrypay');
const git = (...args) =>
  execFileSync('git', args, { cwd: dest, stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim();

const current = existsSync(join(dest, '.git')) ? git('rev-parse', 'HEAD') : undefined;
if (current === COMMIT) {
  console.log(`CarryPay ${COMMIT.slice(0, 7)} is already in .carrypay`);
} else {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  git('init', '--quiet');
  git('remote', 'add', 'origin', REPO);
  git('fetch', '--quiet', '--depth', '1', 'origin', COMMIT);
  git('checkout', '--quiet', 'FETCH_HEAD');
  console.log(`Fetched CarryPay ${COMMIT.slice(0, 7)} into .carrypay`);
}
rmSync(join(root, 'recordings'), { recursive: true, force: true });
cpSync(join(dest, 'recordings'), join(root, 'recordings'), { recursive: true });
console.log('Copied its recorded runs to recordings/');
