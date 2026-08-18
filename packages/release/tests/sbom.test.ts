/**
 * The SBOM is consumed by tools, not people: a purl a scanner cannot parse is
 * worse than no SBOM, because it reports a clean bill for a package it never
 * looked up. These tests pin the encoding, the determinism the committed
 * artifact depends on, and the refusal to invent a licence.
 */
import { describe, expect, it } from 'vitest';

import type { ComponentGraph, InstalledPackage } from '../src/graph.ts';
import { LICENSE_REVIEWS } from '../src/license-review.ts';
import {
  buildSbom,
  contentSerialNumber,
  CYCLONEDX_SPEC_VERSION,
  npmPurl,
  serializeSbom,
  toCycloneHash,
} from '../src/sbom.ts';

const pkg = (overrides: Partial<InstalledPackage> & Pick<InstalledPackage, 'name' | 'version'>): InstalledPackage => ({
  license: 'MIT',
  engines: null,
  dependsOn: [],
  directory: `/fixture/${overrides.name}`,
  ...overrides,
});

const graphOf = (root: InstalledPackage, components: InstalledPackage[] = []): ComponentGraph => ({
  root,
  components,
  unresolved: [],
});

const options = { tool: { name: 'test-tool', version: '0.0.0' }, integrity: new Map<string, string>() };

describe('npmPurl', () => {
  it('percent-encodes a scope into the namespace segment', () => {
    expect(npmPurl('@socket.io/component-emitter', '3.1.2')).toBe(
      'pkg:npm/%40socket.io/component-emitter@3.1.2',
    );
  });

  it('leaves an unscoped name alone', () => {
    expect(npmPurl('ws', '8.21.3')).toBe('pkg:npm/ws@8.21.3');
  });
});

describe('toCycloneHash', () => {
  it('converts an npm integrity string to the hex CycloneDX expects', () => {
    const base64 = Buffer.from('abcd', 'hex').toString('base64');
    expect(toCycloneHash(`sha512-${base64}`)).toEqual({ alg: 'SHA-512', content: 'abcd' });
  });

  it('refuses an unrecognised algorithm rather than emitting a wrong alg', () => {
    expect(toCycloneHash('md5-abc')).toBeNull();
    expect(toCycloneHash('')).toBeNull();
  });
});

describe('contentSerialNumber', () => {
  it('is stable for identical content', () => {
    expect(contentSerialNumber({ a: 1 })).toBe(contentSerialNumber({ a: 1 }));
  });

  it('changes when any content changes', () => {
    expect(contentSerialNumber({ a: 1 })).not.toBe(contentSerialNumber({ a: 2 }));
  });

  it('is a well-formed urn:uuid', () => {
    expect(contentSerialNumber({ a: 1 })).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});

describe('buildSbom', () => {
  it('produces a CycloneDX 1.6 document with the package as the metadata component', () => {
    const document = buildSbom(graphOf(pkg({ name: '@scope/thing', version: '1.2.3' })), options);
    expect(document['bomFormat']).toBe('CycloneDX');
    expect(document['specVersion']).toBe(CYCLONEDX_SPEC_VERSION);
    expect((document['metadata'] as { component: { purl: string } }).component.purl).toBe(
      'pkg:npm/%40scope/thing@1.2.3',
    );
  });

  it('carries no timestamp, so an unchanged workspace regenerates byte-for-byte', () => {
    const graph = graphOf(pkg({ name: 'thing', version: '1.0.0' }), [pkg({ name: 'dep', version: '2.0.0' })]);
    const first = serializeSbom(buildSbom(graph, options));
    const second = serializeSbom(buildSbom(graph, options));
    expect(first).toBe(second);
    expect(first).not.toMatch(/timestamp":\s*"\d{4}-/u);
  });

  it('attaches the lockfile hash to the component it belongs to', () => {
    const integrity = new Map([['dep@2.0.0', `sha512-${Buffer.from('ff', 'hex').toString('base64')}`]]);
    const document = buildSbom(
      graphOf(pkg({ name: 'thing', version: '1.0.0' }), [pkg({ name: 'dep', version: '2.0.0' })]),
      { ...options, integrity },
    );
    const [component] = document['components'] as { hashes?: { alg: string; content: string }[] }[];
    expect(component?.hashes).toEqual([{ alg: 'SHA-512', content: 'ff' }]);
  });

  it('omits hashes rather than inventing one when the lockfile has none', () => {
    const document = buildSbom(
      graphOf(pkg({ name: 'thing', version: '1.0.0' }), [pkg({ name: 'dep', version: '2.0.0' })]),
      options,
    );
    const [component] = document['components'] as { hashes?: unknown }[];
    expect(component?.hashes).toBeUndefined();
  });

  it('emits a known SPDX licence as an id and anything else as a name', () => {
    const document = buildSbom(
      graphOf(pkg({ name: 'thing', version: '1.0.0' }), [
        pkg({ name: 'spdx', version: '1.0.0', license: 'Apache-2.0' }),
        pkg({ name: 'odd', version: '1.0.0', license: 'SEE LICENSE IN COPYING' }),
      ]),
      options,
    );
    const components = document['components'] as { licenses: unknown }[];
    expect(components[0]?.licenses).toEqual([{ license: { id: 'Apache-2.0' } }]);
    expect(components[1]?.licenses).toEqual([{ license: { name: 'SEE LICENSE IN COPYING' } }]);
  });

  it('states no licence, and says so, for an undeclared and unreviewed package', () => {
    const document = buildSbom(
      graphOf(pkg({ name: 'thing', version: '1.0.0' }), [
        pkg({ name: 'mystery', version: '1.0.0', license: null }),
      ]),
      options,
    );
    const [component] = document['components'] as {
      licenses?: unknown;
      properties?: { name: string; value: string }[];
    }[];
    expect(component?.licenses).toBeUndefined();
    expect(component?.properties?.find((p) => p.name === 'waterx:license-source')?.value).toMatch(
      /^UNDECLARED\./u,
    );
  });

  it('uses a recorded human review for an undeclared licence, and marks it as one', () => {
    const review = LICENSE_REVIEWS[0];
    if (review === undefined) throw new Error('expected at least one recorded licence review');
    const at = review.component.lastIndexOf('@');
    const name = review.component.slice(0, at);
    const version = review.component.slice(at + 1);

    const document = buildSbom(
      graphOf(pkg({ name: 'thing', version: '1.0.0' }), [pkg({ name, version, license: null })]),
      options,
    );
    const [component] = document['components'] as {
      licenses?: unknown;
      properties?: { name: string; value: string }[];
    }[];
    expect(component?.licenses).toEqual([{ license: { id: review.license } }]);
    expect(component?.properties?.find((p) => p.name === 'waterx:license-source')?.value).toMatch(
      /^HUMAN_REVIEW\./u,
    );
  });

  it('records the excluded scope instead of leaving a reader to assume completeness', () => {
    const document = buildSbom(graphOf(pkg({ name: 'thing', version: '1.0.0' })), options);
    const properties = (document['metadata'] as { properties: { name: string; value: string }[] }).properties;
    expect(properties.find((p) => p.name === 'waterx:scope')?.value).toContain('RUNTIME_DEPENDENCIES_ONLY');
    expect(properties.find((p) => p.name === 'waterx:timestamp')?.value).toContain('OMITTED_FOR_REPRODUCIBILITY');
  });

  it('reports an unresolved dependency in the document rather than dropping it', () => {
    const document = buildSbom(
      {
        root: pkg({ name: 'thing', version: '1.0.0' }),
        components: [],
        unresolved: [
          { from: 'thing@1.0.0', name: 'gone', optional: false },
          { from: 'thing@1.0.0', name: 'native', optional: true },
        ],
      },
      options,
    );
    const properties = (document['metadata'] as { properties: { name: string }[] }).properties.map(
      (property) => property.name,
    );
    expect(properties).toContain('waterx:dependency-unresolved');
    expect(properties).toContain('waterx:optional-dependency-absent');
  });

  it('links the dependency graph by purl so a scanner can walk it', () => {
    const document = buildSbom(
      graphOf(pkg({ name: 'thing', version: '1.0.0', dependsOn: ['dep@2.0.0'] }), [
        pkg({ name: 'dep', version: '2.0.0' }),
      ]),
      options,
    );
    expect(document['dependencies']).toEqual([
      { ref: 'pkg:npm/thing@1.0.0', dependsOn: ['pkg:npm/dep@2.0.0'] },
      { ref: 'pkg:npm/dep@2.0.0', dependsOn: [] },
    ]);
  });
});

describe('serializeSbom', () => {
  it('ends with a newline, like every other committed artifact here', () => {
    expect(serializeSbom({ a: 1 }).endsWith('}\n')).toBe(true);
  });
});
