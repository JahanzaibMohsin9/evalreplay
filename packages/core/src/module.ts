import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Jiti, createJiti } from 'jiti';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** The nearest tsconfig.json at or above `dir`. */
async function nearestTsconfig(dir: string): Promise<string | undefined> {
  for (let d = dir; ; d = dirname(d)) {
    const file = join(d, 'tsconfig.json');
    if (await exists(file)) return file;
    if (dirname(d) === d) return undefined;
  }
}

const loaders = new Map<string, Jiti>();

/**
 * Loads a TypeScript or JavaScript module without a build step and returns its default export.
 * Path aliases in the nearest tsconfig.json (`compilerOptions.paths`, e.g. `@/*`) resolve, so a
 * config or case file can import the project's code the way the project does.
 */
export async function importDefault(file: string): Promise<unknown> {
  const tsconfig = await nearestTsconfig(dirname(file));
  const key = tsconfig ?? '';
  let jiti = loaders.get(key);
  if (!jiti) {
    // interopDefault would hand back the whole module as `default` when a file has none
    jiti = createJiti(import.meta.url, {
      moduleCache: true,
      interopDefault: false,
      ...(tsconfig ? { tsconfigPaths: tsconfig } : {}),
    });
    loaders.set(key, jiti);
  }
  return (await jiti.import<{ default?: unknown }>(file)).default;
}
