/**
 * A deliberately small JSON Schema (draft 2020-12) subset, with a runtime
 * validator for it.
 *
 * WHY NOT A SCHEMA LIBRARY: the agent command contract has to be published as
 * plain JSON Schema for adapters that are not TypeScript (ADR-0001 §5, plan §8),
 * so JSON Schema is the source form either way. Deriving the validator from that
 * same object removes the second artifact that could drift from it. See
 * `docs/adr/0006-agent-command-schema-mechanism.md`.
 *
 * THE IMPORTANT PROPERTY IS `assertSupportedSchema`. An unknown keyword is a
 * hard error, never a silently ignored one. A validator that quietly skips
 * `multipleOf` or `not` would report a malformed order intent as valid, which on
 * a write path is the difference between a rejected request and a wrong trade.
 * Growing the subset is a deliberate edit here plus a test, not an accident in a
 * schema definition.
 */

export type JsonSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

export type JsonSchemaScalar = string | number | boolean | null;

export interface JsonSchema {
  /** Only `#/$defs/<name>`. Resolved against the validation scope, not a network. */
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly title?: string;
  readonly description?: string;
  readonly type?: JsonSchemaType;
  readonly enum?: readonly JsonSchemaScalar[];
  readonly const?: JsonSchemaScalar;
  /** ECMA-262 regular expression source. Anchor it; JSON Schema patterns are unanchored. */
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  /** `false` closes the object. A schema value is not supported. */
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly oneOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly examples?: readonly unknown[];
  /**
   * Annotation, never a constraint: the listed values are the members of an OPEN
   * set that this version knows about. A newer server may introduce another one,
   * so a client must tolerate an unlisted value. Contrast `enum`, which is closed
   * and IS enforced. The distinction is required by plan §8.
   */
  readonly 'x-waterx-open-set'?: readonly string[];
}

/** Every keyword this validator understands. Anything else throws. */
const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set<keyof JsonSchema>([
  '$ref',
  '$defs',
  'title',
  'description',
  'type',
  'enum',
  'const',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'oneOf',
  'allOf',
  'examples',
  'x-waterx-open-set',
]);

/**
 * Keywords that may sit alongside `$ref`.
 *
 * `title`/`description` are annotations, so ignoring them costs nothing; `$defs`
 * carries the scope the `$ref` resolves against. Anything else would be a
 * CONSTRAINT this validator drops on the floor, so it is an error instead.
 */
const REF_SIBLINGS: ReadonlySet<string> = new Set(['$ref', '$defs', 'title', 'description']);

const SCHEMA_TYPES: ReadonlySet<string> = new Set<JsonSchemaType>([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
]);

export interface SchemaViolation {
  /** JSON Pointer into the validated value. `''` is the value itself. */
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

type Defs = Readonly<Record<string, JsonSchema>>;

/**
 * Reject a schema this validator cannot faithfully enforce.
 *
 * Throws rather than returning, because a caller reaching this with a bad schema
 * has a build-time bug, not a bad request.
 */
export function assertSupportedSchema(schema: JsonSchema, defs: Defs = {}): void {
  const scope = { ...defs, ...(schema.$defs ?? {}) };
  const seen = new Set<JsonSchema>();
  for (const definition of Object.values(scope)) walk(definition, scope, '#/$defs', seen);
  walk(schema, scope, '#', seen);
}

function walk(schema: JsonSchema, defs: Defs, pointer: string, seen: Set<JsonSchema>): void {
  if (seen.has(schema)) return;
  seen.add(schema);

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`Unsupported JSON Schema keyword "${keyword}" at ${pointer}`);
    }
  }

  if (schema.$ref !== undefined) {
    for (const keyword of Object.keys(schema)) {
      if (!REF_SIBLINGS.has(keyword)) {
        throw new Error(`"${keyword}" alongside $ref is ignored by this validator at ${pointer}`);
      }
    }
    resolveRef(schema.$ref, defs, pointer);
    return;
  }

  if (schema.type !== undefined && !SCHEMA_TYPES.has(schema.type)) {
    throw new Error(`Unknown type "${String(schema.type)}" at ${pointer}`);
  }
  if (schema.additionalProperties === true) {
    // Not an error, but say so: `true` is the default and stating it usually
    // means the author believed they were opening an object that was closed.
    throw new Error(`"additionalProperties: true" is redundant at ${pointer}; omit it`);
  }

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    walk(property, defs, `${pointer}/properties/${name}`, seen);
  }
  for (const name of schema.required ?? []) {
    if (schema.properties?.[name] === undefined) {
      throw new Error(`Required property "${name}" is not described at ${pointer}`);
    }
  }
  if (schema.items !== undefined) walk(schema.items, defs, `${pointer}/items`, seen);
  schema.oneOf?.forEach((branch, index) => walk(branch, defs, `${pointer}/oneOf/${index}`, seen));
  schema.allOf?.forEach((branch, index) => walk(branch, defs, `${pointer}/allOf/${index}`, seen));
}

function resolveRef(ref: string, defs: Defs, pointer: string): JsonSchema {
  const name = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : undefined;
  if (name === undefined) {
    throw new Error(`Only "#/$defs/<name>" refs are supported; got "${ref}" at ${pointer}`);
  }
  const target = defs[name];
  if (target === undefined) throw new Error(`Unresolved $ref "${ref}" at ${pointer}`);
  return target;
}

/**
 * Validate `value`, returning every violation rather than the first.
 *
 * An agent that gets one error at a time re-submits an intent per round trip;
 * for a write path that is both slow and a chance to mutate the intent between
 * attempts.
 */
export function validateAgainstSchema(
  schema: JsonSchema,
  value: unknown,
  defs: Defs = {},
): SchemaViolation[] {
  const scope = { ...defs, ...(schema.$defs ?? {}) };
  assertSupportedSchema(schema, defs);
  const violations: SchemaViolation[] = [];
  visit(schema, value, '', scope, violations);
  return violations;
}

export function formatViolations(violations: readonly SchemaViolation[]): string {
  return violations.map((v) => `${v.path === '' ? '(root)' : v.path}: ${v.message}`).join('; ');
}

function visit(
  schema: JsonSchema,
  value: unknown,
  path: string,
  defs: Defs,
  out: SchemaViolation[],
): void {
  if (schema.$ref !== undefined) {
    visit(resolveRef(schema.$ref, defs, path), value, path, defs, out);
    return;
  }

  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    out.push({ path, keyword: 'type', message: `expected ${schema.type}, received ${describe(value)}` });
    // Every remaining keyword assumes the type held. Reporting "minLength" on a
    // number is noise that hides the one error that matters.
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    out.push({ path, keyword: 'const', message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => allowed === value)) {
    out.push({
      path,
      keyword: 'enum',
      message: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
    });
  }

  if (typeof value === 'string') visitString(schema, value, path, out);
  if (typeof value === 'number') visitNumber(schema, value, path, out);
  if (Array.isArray(value)) visitArray(schema, value, path, defs, out);
  else if (isPlainObject(value)) visitObject(schema, value, path, defs, out);

  for (const branch of schema.allOf ?? []) visit(branch, value, path, defs, out);
  if (schema.oneOf !== undefined) visitOneOf(schema.oneOf, value, path, defs, out);
}

function visitString(
  schema: JsonSchema,
  value: string,
  path: string,
  out: SchemaViolation[],
): void {
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
    out.push({
      path,
      keyword: 'pattern',
      message: `${JSON.stringify(value)} does not match ${schema.pattern}${
        schema.description === undefined ? '' : ` (${schema.description})`
      }`,
    });
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    out.push({ path, keyword: 'minLength', message: `must be at least ${schema.minLength} characters` });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    out.push({ path, keyword: 'maxLength', message: `must be at most ${schema.maxLength} characters` });
  }
}

function visitNumber(
  schema: JsonSchema,
  value: number,
  path: string,
  out: SchemaViolation[],
): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    out.push({ path, keyword: 'minimum', message: `must be >= ${schema.minimum}` });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    out.push({ path, keyword: 'maximum', message: `must be <= ${schema.maximum}` });
  }
}

function visitArray(
  schema: JsonSchema,
  value: readonly unknown[],
  path: string,
  defs: Defs,
  out: SchemaViolation[],
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    out.push({ path, keyword: 'minItems', message: `must contain at least ${schema.minItems} items` });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    out.push({ path, keyword: 'maxItems', message: `must contain at most ${schema.maxItems} items` });
  }
  const items = schema.items;
  if (items === undefined) return;
  value.forEach((entry, index) => visit(items, entry, `${path}/${index}`, defs, out));
}

function visitObject(
  schema: JsonSchema,
  value: Readonly<Record<string, unknown>>,
  path: string,
  defs: Defs,
  out: SchemaViolation[],
): void {
  for (const name of schema.required ?? []) {
    // An explicit `undefined` counts as absent. Callers reach this from JS as
    // well as from parsed JSON, and `{ positionId: undefined }` means the same
    // thing as omitting the key — treating it as present would report a
    // confusing type error instead of the missing-field error.
    if (!isPresent(value, name)) {
      out.push({ path: join(path, name), keyword: 'required', message: 'is required' });
    }
  }
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (isPresent(value, name)) visit(property, value[name], join(path, name), defs, out);
  }
  if (schema.additionalProperties === false) {
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const name of Object.keys(value)) {
      if (!known.has(name) && isPresent(value, name)) {
        out.push({ path: join(path, name), keyword: 'additionalProperties', message: 'is not a known field' });
      }
    }
  }
}

function visitOneOf(
  branches: readonly JsonSchema[],
  value: unknown,
  path: string,
  defs: Defs,
  out: SchemaViolation[],
): void {
  const attempts = branches.map((branch) => {
    const errors: SchemaViolation[] = [];
    visit(branch, value, path, defs, errors);
    return { branch, errors };
  });
  const matched = attempts.filter((attempt) => attempt.errors.length === 0);
  if (matched.length === 1) return;

  // Name the variants. "0 matched" alone is useless to an agent deciding whether
  // it sent the wrong size unit or the wrong side.
  const detail = attempts
    .map(({ branch, errors }) => {
      const label = branch.title ?? '(untitled variant)';
      const first = errors[0];
      return first === undefined
        ? label
        : `${label} — ${first.path === path ? '' : `${first.path} `}${first.message}`;
    })
    .join('; ');
  out.push({
    path,
    keyword: 'oneOf',
    message:
      matched.length === 0
        ? `no variant matched: ${detail}`
        : `must match exactly one variant, matched ${matched.length}: ${detail}`,
  });
}

function matchesType(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPresent(value: Readonly<Record<string, unknown>>, name: string): boolean {
  return Object.hasOwn(value, name) && value[name] !== undefined;
}

function join(path: string, key: string): string {
  return `${path}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isNaN(value)) return 'NaN';
  return typeof value;
}
