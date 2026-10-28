// Release helpers for .github/workflows/release.yml.
//   node scripts/release.mjs check 0.1.0   every published package has this version
//   node scripts/release.mjs notes 0.1.0   the CHANGELOG.md section for it
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [command, version] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: node scripts/release.mjs check|notes <version, e.g. 0.1.0>');
  process.exit(2);
}

if (command === 'check') {
  const wrong = readdirSync('packages')
    .map((dir) => JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8')))
    .filter((pkg) => !pkg.private && pkg.version !== version)
    .map((pkg) => `${pkg.name} is ${pkg.version}`);
  if (wrong.length) {
    console.error(`The tag is v${version}, but ${wrong.join(', ')}`);
    process.exit(1);
  }
  console.log(`Every package is ${version}`);
} else if (command === 'notes') {
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const start = changelog.indexOf(`## ${version}`);
  if (start < 0) {
    console.error(`CHANGELOG.md has no "## ${version}" section`);
    process.exit(1);
  }
  const rest = changelog.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  console.log((end < 0 ? rest : rest.slice(0, end)).join('\n').trim());
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
