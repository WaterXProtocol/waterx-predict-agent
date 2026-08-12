import {
  assertSupportedSchema,
  formatViolations,
  validateAgainstSchema,
  type JsonSchema,
} from '../src/json-schema.ts';

describe('assertSupportedSchema', () => {
  it('rejects a keyword the validator cannot enforce', () => {
    // The point of the whole subset: an unenforceable constraint must be loud at
    // build time, not silently dropped at validation time on a write path.
    const schema = { type: 'number', multipleOf: 2 } as unknown as JsonSchema;
    expect(() => assertSupportedSchema(schema)).toThrow(/Unsupported JSON Schema keyword "multipleOf"/u);
  });

  it('rejects a constraint placed alongside $ref, which it would ignore', () => {
    const schema: JsonSchema = {
      $defs: { name: { type: 'string' } },
      $ref: '#/$defs/name',
      minLength: 3,
    };
    expect(() => assertSupportedSchema(schema)).toThrow(/alongside \$ref is ignored/u);
  });

  it('allows title and description alongside $ref', () => {
    const schema: JsonSchema = {
      $defs: { name: { type: 'string' } },
      $ref: '#/$defs/name',
      title: 'Name',
      description: 'A name.',
    };
    expect(() => assertSupportedSchema(schema)).not.toThrow();
  });

  it('rejects an unresolved $ref', () => {
    const schema: JsonSchema = { $ref: '#/$defs/missing' };
    expect(() => assertSupportedSchema(schema)).toThrow(/Unresolved \$ref/u);
  });

  it('rejects a remote or non-$defs $ref', () => {
    const schema: JsonSchema = { $ref: 'https://example.invalid/schema.json' };
    expect(() => assertSupportedSchema(schema)).toThrow(/Only "#\/\$defs\/<name>" refs/u);
  });

  it('rejects a required property that is not described', () => {
    const schema: JsonSchema = { type: 'object', required: ['size'], properties: {} };
    expect(() => assertSupportedSchema(schema)).toThrow(/Required property "size" is not described/u);
  });

  it('rejects a redundant additionalProperties: true', () => {
    const schema: JsonSchema = { type: 'object', additionalProperties: true };
    expect(() => assertSupportedSchema(schema)).toThrow(/redundant/u);
  });

  it('does not recurse forever through a self-referential definition', () => {
    const node: JsonSchema = {
      type: 'object',
      properties: { child: { $ref: '#/$defs/node' } },
    };
    const schema: JsonSchema = { $defs: { node }, $ref: '#/$defs/node' };
    expect(() => assertSupportedSchema(schema)).not.toThrow();
  });
});

describe('validateAgainstSchema', () => {
  it('reports every violation rather than only the first', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    };
    expect(validateAgainstSchema(schema, {})).toHaveLength(2);
  });

  it('stops after a failed type check instead of reporting keywords that assume it', () => {
    const schema: JsonSchema = { type: 'string', minLength: 5, pattern: '^x' };
    const violations = validateAgainstSchema(schema, 42);
    expect(violations).toEqual([
      { path: '', keyword: 'type', message: 'expected string, received number' },
    ]);
  });

  it('distinguishes integer from number', () => {
    expect(validateAgainstSchema({ type: 'integer' }, 1.5)).toHaveLength(1);
    expect(validateAgainstSchema({ type: 'integer' }, 2)).toHaveLength(0);
    expect(validateAgainstSchema({ type: 'number' }, Number.NaN)).toHaveLength(1);
  });

  it('does not treat an array as an object', () => {
    expect(validateAgainstSchema({ type: 'object' }, [])).toHaveLength(1);
  });

  it('closes an object when additionalProperties is false', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { known: { type: 'string' } },
    };
    const violations = validateAgainstSchema(schema, { known: 'x', typo: 1 });
    expect(violations).toEqual([
      { path: '/typo', keyword: 'additionalProperties', message: 'is not a known field' },
    ]);
  });

  it('treats an explicit undefined as absent, in both directions', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['a'],
      additionalProperties: false,
      properties: { a: { type: 'string' } },
    };
    expect(validateAgainstSchema(schema, { a: undefined })).toEqual([
      { path: '/a', keyword: 'required', message: 'is required' },
    ]);
    expect(validateAgainstSchema(schema, { a: 'x', extra: undefined })).toHaveLength(0);
  });

  it('escapes a JSON Pointer segment', () => {
    const schema: JsonSchema = { type: 'object', properties: { 'a/b': { type: 'string' } } };
    expect(validateAgainstSchema(schema, { 'a/b': 1 })[0]?.path).toBe('/a~1b');
  });

  it('names the variants when no oneOf branch matches', () => {
    const schema: JsonSchema = {
      oneOf: [
        { title: 'A shape', type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
        { title: 'B shape', type: 'object', required: ['b'], properties: { b: { type: 'string' } } },
      ],
    };
    const message = formatViolations(validateAgainstSchema(schema, {}));
    expect(message).toContain('A shape');
    expect(message).toContain('B shape');
  });

  it('rejects a value matching more than one oneOf branch', () => {
    const schema: JsonSchema = {
      oneOf: [
        { title: 'A', type: 'object', properties: {} },
        { title: 'B', type: 'object', properties: {} },
      ],
    };
    expect(formatViolations(validateAgainstSchema(schema, {}))).toContain('matched 2');
  });

  it('validates array items and bounds', () => {
    const schema: JsonSchema = {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: { type: 'string' },
    };
    expect(validateAgainstSchema(schema, [])).toHaveLength(1);
    expect(validateAgainstSchema(schema, ['a', 'b', 'c'])).toHaveLength(1);
    expect(validateAgainstSchema(schema, ['a', 1])[0]?.path).toBe('/1');
  });

  it('resolves a $ref through a nested value path', () => {
    const schema: JsonSchema = {
      $defs: { positive: { type: 'integer', minimum: 1 } },
      type: 'object',
      properties: { count: { $ref: '#/$defs/positive' } },
    };
    expect(validateAgainstSchema(schema, { count: 0 })[0]).toMatchObject({
      path: '/count',
      keyword: 'minimum',
    });
  });

  it('never enforces an open-set annotation', () => {
    // A newer server may add a category. Rejecting an unlisted value here would
    // make the client fail on data the server considers valid.
    const schema: JsonSchema = { type: 'string', 'x-waterx-open-set': ['FOOTBALL'] };
    expect(validateAgainstSchema(schema, 'ESPORTS')).toHaveLength(0);
  });

  it('enforces a closed enum', () => {
    const schema: JsonSchema = { type: 'string', enum: ['BUY', 'SELL'] };
    expect(validateAgainstSchema(schema, 'buy')).toHaveLength(1);
    expect(validateAgainstSchema(schema, 'BUY')).toHaveLength(0);
  });
});
