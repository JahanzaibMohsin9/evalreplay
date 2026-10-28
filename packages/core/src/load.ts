import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { glob } from 'tinyglobby';
import { type Document, LineCounter, parseAllDocuments } from 'yaml';
import { type Case, type CaseIssue, type JsonSchema, normalizeCase } from './cases.js';
import { importDefault } from './module.js';

/** A case file that could not be loaded, or one problem in it. */
export class CaseLoadError extends Error {
  override readonly name = 'CaseLoadError';
  constructor(
    /** The problem, without the location. */
    readonly problem: string,
    /** Path of the case file, relative to the working directory. */
    readonly file?: string,
    /** 1-based line, for YAML files. */
    readonly line?: number,
  ) {
    super(
      file === undefined ? problem : `${file}${line === undefined ? '' : `:${line}`}: ${problem}`,
    );
  }
}

export interface LoadedCases {
  cases: Case[];
  /** Every problem found; the cases that loaded are still returned. */
  errors: CaseLoadError[];
}

export interface LoadCasesOptions {
  /** Where patterns and the paths in error messages are relative to. Default: `process.cwd()`. */
  cwd?: string;
}

const YAML_FILE = /\.ya?ml$/i;
const MODULE_FILE = /\.case\.(ts|mts|js|mjs)$/i;

const describePath = (path: (string | number)[]) => (path.length ? `${path.join('.')}: ` : '');

async function readSchemaFrom(caseFile: string, path: string): Promise<JsonSchema> {
  const full = isAbsolute(path) ? path : resolve(dirname(caseFile), path);
  let text: string;
  try {
    text = await readFile(full, 'utf8');
  } catch (err) {
    throw new Error(`cannot read schema file ${path}`, { cause: err });
  }
  try {
    const schema: unknown = JSON.parse(text);
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      throw new Error('not an object');
    }
    return schema as JsonSchema;
  } catch (err) {
    throw new Error(`schema file ${path} is not a JSON object (${(err as Error).message})`, {
      cause: err,
    });
  }
}

/** The line of the deepest node on `path` that exists in the document. */
function lineOf(doc: Document, lines: LineCounter, path: (string | number)[]): number | undefined {
  for (let n = path.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(path.slice(0, n), true);
    const offset = (node as { range?: [number, number, number] } | undefined)?.range?.[0];
    if (offset !== undefined) return lines.linePos(offset).line;
  }
  return undefined;
}

async function loadYamlFile(file: string, shown: string): Promise<LoadedCases> {
  const text = await readFile(file, 'utf8');
  const lines = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lines, prettyErrors: false });
  const loaded: LoadedCases = { cases: [], errors: [] };

  for (const doc of Array.isArray(docs) ? docs : [docs]) {
    if (doc.errors.length) {
      for (const e of doc.errors) {
        loaded.errors.push(new CaseLoadError(e.message, shown, lines.linePos(e.pos[0]).line));
      }
      continue;
    }
    const raw: unknown = doc.toJS();
    if (raw === null || raw === undefined) continue; // empty document, e.g. a trailing `---`
    const result = await normalizeCase(raw, {
      file,
      allowCustom: false,
      readSchema: (p) => readSchemaFrom(file, p),
    });
    if (result.case) loaded.cases.push(result.case);
    for (const issue of result.issues) {
      loaded.errors.push(
        new CaseLoadError(
          `${describePath(issue.path)}${issue.message}`,
          shown,
          lineOf(doc, lines, issue.path),
        ),
      );
    }
  }
  return loaded;
}

async function loadModuleFile(file: string, shown: string): Promise<LoadedCases> {
  let exported: unknown;
  try {
    exported = await importDefault(file);
  } catch (err) {
    return {
      cases: [],
      errors: [new CaseLoadError(`cannot load: ${(err as Error).message}`, shown)],
    };
  }
  if (exported === undefined) {
    return {
      cases: [],
      errors: [
        new CaseLoadError('no default export; use `export default defineCase({ ... })`', shown),
      ],
    };
  }

  const loaded: LoadedCases = { cases: [], errors: [] };
  const many = Array.isArray(exported);
  const definitions: unknown[] = Array.isArray(exported) ? exported : [exported];
  for (const [i, definition] of definitions.entries()) {
    const result = await normalizeCase(definition, {
      file,
      allowCustom: true,
      readSchema: (p) => readSchemaFrom(file, p),
    });
    if (result.case) loaded.cases.push(result.case);
    const prefix = (issue: CaseIssue) => (many ? [i, ...issue.path] : issue.path);
    for (const issue of result.issues) {
      loaded.errors.push(
        new CaseLoadError(`${describePath(prefix(issue))}${issue.message}`, shown),
      );
    }
  }
  return loaded;
}

/** Loads one case file: `*.yaml` / `*.yml` (one case per YAML document) or `*.case.ts` / `.js`. */
export async function loadCaseFile(
  file: string,
  options: LoadCasesOptions = {},
): Promise<LoadedCases> {
  const cwd = options.cwd ?? process.cwd();
  const full = resolve(cwd, file);
  const shown = relative(cwd, full).split('\\').join('/');
  if (YAML_FILE.test(full)) return loadYamlFile(full, shown);
  if (MODULE_FILE.test(full)) return loadModuleFile(full, shown);
  return {
    cases: [],
    errors: [new CaseLoadError('not a case file (expected .yaml, .yml or .case.ts)', shown)],
  };
}

/**
 * Loads every case file matching the glob patterns, in path order. Duplicate case ids and
 * patterns that match nothing are reported as errors.
 */
export async function loadCases(
  patterns: string | readonly string[],
  options: LoadCasesOptions = {},
): Promise<LoadedCases> {
  const cwd = options.cwd ?? process.cwd();
  const list = typeof patterns === 'string' ? [patterns] : [...patterns];
  const files = (await glob(list, { cwd, absolute: true, ignore: ['**/node_modules/**'] })).sort();
  if (!files.length) {
    return { cases: [], errors: [new CaseLoadError(`no case files match ${list.join(', ')}`)] };
  }

  const all: LoadedCases = { cases: [], errors: [] };
  const seen = new Map<string, string>();
  for (const file of files) {
    const loaded = await loadCaseFile(file, { cwd });
    all.errors.push(...loaded.errors);
    for (const c of loaded.cases) {
      const shown = relative(cwd, c.file).split('\\').join('/');
      const first = seen.get(c.id);
      if (first !== undefined) {
        all.errors.push(new CaseLoadError(`duplicate case id "${c.id}" (also in ${first})`, shown));
        continue;
      }
      seen.set(c.id, shown);
      all.cases.push(c);
    }
  }
  return all;
}
