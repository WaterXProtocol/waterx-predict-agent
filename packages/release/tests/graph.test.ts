/**
 * The graph is what the SBOM claims a consumer installs, so these tests build
 * real directory trees rather than stubbing the filesystem: a resolver that
 * agrees with a mock but disagrees with Node is the failure worth catching.
 *
 * Every fixture lives in a temporary directory and is removed afterwards.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageKey, readIntegrityIndex, resolveComponentGraph, resolveFrom } from '../src/graph.ts';
import { findRepoRoot } from '../src/workspace.ts';

let root: string;

const write = (relativePath: string, manifest: Record<string, unknown>): string => {
  const directory = join(root, relativePath);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return directory;
};

beforeEach(() => {
  // Realpath'd up front: on macOS `/var` is a symlink to `/private/var`, and
  // the resolver returns realpaths on purpose, so a raw tmpdir would compare
  // unequal for a reason that has nothing to do with resolution.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wx-release-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveFrom', () => {
  it('walks up to a parent node_modules the way Node does', () => {
    write('app', { name: 'app', version: '1.0.0' });
    const target = write('node_modules/shared', { name: 'shared', version: '2.0.0' });
    expect(resolveFrom(join(root, 'app'), 'shared')).toBe(target);
  });

  it('prefers the nearest copy over an outer one', () => {
    write('app', { name: 'app', version: '1.0.0' });
    const near = write('app/node_modules/shared', { name: 'shared', version: '9.9.9' });
    write('node_modules/shared', { name: 'shared', version: '2.0.0' });
    expect(resolveFrom(join(root, 'app'), 'shared')).toBe(near);
  });

  it('returns null rather than throwing when nothing is installed', () => {
    write('app', { name: 'app', version: '1.0.0' });
    expect(resolveFrom(join(root, 'app'), 'absent')).toBeNull();
  });

  it('collapses a symlink into the store entry it points at', () => {
    write('app', { name: 'app', version: '1.0.0' });
    const store = write('store/shared@2.0.0/node_modules/shared', { name: 'shared', version: '2.0.0' });
    mkdirSync(join(root, 'app/node_modules'), { recursive: true });
    symlinkSync(store, join(root, 'app/node_modules/shared'), 'dir');
    expect(resolveFrom(join(root, 'app'), 'shared')).toBe(store);
  });
});

describe('resolveComponentGraph', () => {
  it('reports the exact installed versions, not the declared ranges', () => {
    write('app', { name: 'app', version: '1.0.0', dependencies: { left: '^1.0.0' } });
    write('node_modules/left', { name: 'left', version: '1.4.2', license: 'MIT' });

    const graph = resolveComponentGraph(join(root, 'app'));
    expect(graph.root.dependsOn).toEqual(['left@1.4.2']);
    expect(graph.components.map(packageKey)).toEqual(['left@1.4.2']);
  });

  it('never follows devDependencies or peerDependencies into the SBOM', () => {
    write('app', {
      name: 'app',
      version: '1.0.0',
      dependencies: { shipped: '*' },
      devDependencies: { tooling: '*' },
      peerDependencies: { host: '*' },
    });
    write('node_modules/shipped', { name: 'shipped', version: '1.0.0', license: 'MIT' });
    write('node_modules/tooling', { name: 'tooling', version: '1.0.0', license: 'MIT' });
    write('node_modules/host', { name: 'host', version: '1.0.0', license: 'MIT' });

    const graph = resolveComponentGraph(join(root, 'app'));
    expect(graph.components.map((component) => component.name)).toEqual(['shipped']);
    expect(graph.unresolved).toEqual([]);
  });

  it('records an absent optional dependency separately from a broken required one', () => {
    write('app', {
      name: 'app',
      version: '1.0.0',
      dependencies: { missing: '*' },
      optionalDependencies: { native: '*' },
    });

    const graph = resolveComponentGraph(join(root, 'app'));
    expect(graph.unresolved).toEqual([
      { from: 'app@1.0.0', name: 'missing', optional: false },
      { from: 'app@1.0.0', name: 'native', optional: true },
    ]);
  });

  it('terminates on a dependency cycle instead of overflowing the stack', () => {
    write('app', { name: 'app', version: '1.0.0', dependencies: { a: '*' } });
    write('node_modules/a', { name: 'a', version: '1.0.0', license: 'MIT', dependencies: { b: '*' } });
    write('node_modules/b', { name: 'b', version: '1.0.0', license: 'MIT', dependencies: { a: '*' } });

    const graph = resolveComponentGraph(join(root, 'app'));
    expect(graph.components.map(packageKey)).toEqual(['a@1.0.0', 'b@1.0.0']);
  });

  it('reports an undeclared licence as null rather than guessing one', () => {
    write('app', { name: 'app', version: '1.0.0', dependencies: { legacy: '*', modern: '*' } });
    // The deprecated array form. Common in old packages, and not machine-safe:
    // reading it as a declaration would put an unverified claim in the SBOM.
    write('node_modules/legacy', {
      name: 'legacy',
      version: '1.0.0',
      licenses: [{ type: 'MIT' }],
    });
    write('node_modules/modern', { name: 'modern', version: '1.0.0', license: 'Apache-2.0' });

    const graph = resolveComponentGraph(join(root, 'app'));
    expect(graph.components.map((component) => `${component.name}=${String(component.license)}`)).toEqual([
      'legacy=null',
      'modern=Apache-2.0',
    ]);
  });

  it('carries the declared node range through so the floor can be checked', () => {
    write('app', { name: 'app', version: '1.0.0', dependencies: { dep: '*' } });
    write('node_modules/dep', { name: 'dep', version: '1.0.0', license: 'MIT', engines: { node: '>=18' } });

    const graph = resolveComponentGraph(join(root, 'app'));
    expect(graph.components[0]?.engines).toBe('>=18');
  });

  it('counts one store entry reached by two paths as one component', () => {
    write('app', { name: 'app', version: '1.0.0', dependencies: { left: '*', right: '*' } });
    const shared = write('store/shared@1.0.0/node_modules/shared', {
      name: 'shared',
      version: '1.0.0',
      license: 'MIT',
    });
    for (const holder of ['left', 'right']) {
      write(`node_modules/${holder}`, {
        name: holder,
        version: '1.0.0',
        license: 'MIT',
        dependencies: { shared: '*' },
      });
      mkdirSync(join(root, `node_modules/${holder}/node_modules`), { recursive: true });
      symlinkSync(shared, join(root, `node_modules/${holder}/node_modules/shared`), 'dir');
    }

    const graph = resolveComponentGraph(join(root, 'app'));
    expect(graph.components.map(packageKey)).toEqual(['left@1.0.0', 'right@1.0.0', 'shared@1.0.0']);
  });
});

describe('readIntegrityIndex', () => {
  const lockfile = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    devDependencies:',
    '      typescript:',
    '        specifier: ^5.9.3',
    '        version: 5.9.3',
    '',
    'packages:',
    '',
    '  ms@2.1.3:',
    '    resolution: {integrity: sha512-MS}',
    '',
    "  'vitest@4.1.10(vite@8.1.5)':",
    '    resolution: {integrity: sha512-VITEST}',
    '',
    'snapshots:',
    '',
    '  ms@2.1.3: {}',
    '    resolution: {integrity: sha512-WRONG}',
    '',
  ].join('\n');

  it('reads integrity from the packages block only', () => {
    const index = readIntegrityIndex(lockfile);
    expect(index.get('ms@2.1.3')).toBe('sha512-MS');
  });

  it('indexes a peer-suffixed key under its base name and version', () => {
    expect(readIntegrityIndex(lockfile).get('vitest@4.1.10')).toBe('sha512-VITEST');
  });

  it('drops a key whose suffixed entries disagree rather than picking one', () => {
    const conflicting = [
      'packages:',
      '',
      "  'x@1.0.0(a@1)':",
      '    resolution: {integrity: sha512-ONE}',
      '',
      "  'x@1.0.0(a@2)':",
      '    resolution: {integrity: sha512-TWO}',
      '',
    ].join('\n');
    expect(readIntegrityIndex(conflicting).has('x@1.0.0')).toBe(false);
  });

  it('reads the real lockfile of this workspace', () => {
    const index = readIntegrityIndex(readFileSync(join(findRepoRoot(), 'pnpm-lock.yaml'), 'utf8'));
    expect(index.size).toBeGreaterThan(20);
    for (const value of index.values()) expect(value).toMatch(/^sha\d+-/u);
  });
});
