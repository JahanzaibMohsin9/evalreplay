import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { JsonSchema } from './cases.js';

// Tool schemas come from model providers and often carry keys Ajv doesn't know, so strict mode
// is off. addUsedSchema: false lets two cases use schemas with the same $id.
const OPTIONS = { strict: false, allErrors: true, addUsedSchema: false } as const;

type AnyAjv = Ajv | Ajv2019 | Ajv2020;
const instances = new Map<string, AnyAjv>();

/** The Ajv for the draft named by `$schema`; 2020-12 when there is none. */
function ajvFor(schema: JsonSchema): AnyAjv {
  const uri = typeof schema.$schema === 'string' ? schema.$schema : '';
  const draft = /draft-0[67]\b/.test(uri)
    ? '07'
    : uri.includes('2019-09')
      ? '2019-09'
      : uri === '' || uri.includes('2020-12')
        ? '2020-12'
        : undefined;
  if (draft === undefined) {
    throw new Error(`unsupported $schema ${uri} (use draft-07, 2019-09 or 2020-12)`);
  }
  let ajv = instances.get(draft);
  if (!ajv) {
    ajv =
      draft === '07'
        ? new Ajv(OPTIONS)
        : draft === '2019-09'
          ? new Ajv2019(OPTIONS)
          : new Ajv2020(OPTIONS);
    // ajv-formats is CommonJS; under NodeNext its default import is the module, whose
    // `default` is the plugin
    addFormats.default(ajv);
    instances.set(draft, ajv);
  }
  return ajv;
}

const compiled = new WeakMap<JsonSchema, ValidateFunction>();

/** Compiles a JSON Schema once per schema object. Throws when the schema itself is invalid. */
export function compileSchema(schema: JsonSchema): ValidateFunction {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajvFor(schema).compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}

/** Ajv errors as one line, e.g. `args/currency must be equal to one of the allowed values`. */
export function describeSchemaErrors(
  errors: ErrorObject[] | null | undefined,
  name: string,
): string {
  if (!errors?.length) return `${name} is invalid`;
  return errors
    .map((e) => {
      const where = `${name}${e.instancePath}`;
      const extra =
        e.keyword === 'additionalProperties'
          ? ` (${String((e.params as { additionalProperty?: unknown }).additionalProperty)})`
          : e.keyword === 'enum'
            ? `: ${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)}`
            : '';
      return `${where} ${e.message ?? 'is invalid'}${extra}`;
    })
    .join('; ');
}
