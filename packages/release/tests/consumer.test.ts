/**
 * The consumer kit and the local registry.
 *
 * Asserted on the pure halves — the manifest, the packument, the routing —
 * because the impure halves are `npm pack` and a listening socket, and neither
 * belongs in a suite that is supposed to install nothing and open nothing. The
 * seam is the point: routing that can only be exercised by binding a port is
 * routing nobody tests.
 */
import { createHash } from 'node:crypto';

import {
  buildPackuments,
  kitManifest,
  literalFilesEntries,
  npmrcFor,
  resolveRegistryRequest,
  tarballName,
  tarballPath,
  verifyInstalled,
  type PackedArtifact,
} from '../src/consumer.ts';

const bytesFor = (name: string): Buffer => Buffer.from(`tarball-bytes-for-${name}`);

const artifact = (name: string, version = '0.1.0'): PackedArtifact => ({
  name,
  version,
  fileName: tarballName(name, version),
  filePath: `/staging/${tarballName(name, version)}`,
  manifest: {
    name,
    version,
    files: ['dist', 'AGENT_INSTRUCTIONS.md'],
    publishConfig: { access: 'public', provenance: true },
  },
});

const SDK = artifact('@waterx/predict-agent-sdk');
const SCHEMA = artifact('@waterx/predict-agent-schema');
const ARTIFACTS = [SDK, SCHEMA];
const ORIGIN = 'http://127.0.0.1:4873';

describe('tarballName', () => {
  it('spells a scoped name the way npm packs it', () => {
    expect(tarballName('@waterx/predict-agent-sdk', '0.1.0')).toBe(
      'waterx-predict-agent-sdk-0.1.0.tgz',
    );
    expect(tarballName('unscoped', '2.0.0-rc.1')).toBe('unscoped-2.0.0-rc.1.tgz');
  });
});

describe('kitManifest', () => {
  it('points every dependency at a vendored tarball and nothing else', () => {
    // The tarball is the unit under test. A dependency resolved any other way —
    // a workspace link, a copied `dist/` — would install a tree this package's
    // `files` never produced, which is the one thing the kit exists to check.
    const manifest = kitManifest(ARTIFACTS) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(
      ARTIFACTS.map((entry) => entry.name).sort(),
    );
    for (const specifier of Object.values(manifest.dependencies)) {
      expect(specifier).toMatch(/^file:\.\/vendor\/.+\.tgz$/u);
    }
  });

  it('is private, so a scratch project cannot be published by accident', () => {
    expect(kitManifest(ARTIFACTS)).toMatchObject({ private: true });
  });

  it('takes a neutral name by default, and whatever the caller asks for', () => {
    // The folder is handed to whoever is being observed using it. A name that
    // says "waterx kit" has already told them what the exercise is about.
    expect(kitManifest(ARTIFACTS)).toMatchObject({ name: 'agent-workspace' });
    expect(kitManifest(ARTIFACTS, { name: 'my-betting-bot' })).toMatchObject({
      name: 'my-betting-bot',
    });
  });
});

describe('buildPackuments', () => {
  const packuments = buildPackuments(ARTIFACTS, ORIGIN, (entry) => bytesFor(entry.name));

  it('publishes one version, tagged latest, at a tarball under this origin', () => {
    const packument = packuments.get(SDK.name);
    expect(packument?.['dist-tags']).toEqual({ latest: '0.1.0' });
    const version = packument?.versions['0.1.0'] as { dist: { tarball: string } };
    expect(version.dist.tarball).toBe(`${ORIGIN}${tarballPath(SDK)}`);
  });

  it('hashes the bytes it will actually serve', () => {
    // npm verifies the integrity it was promised. A hash of anything but these
    // bytes turns every install into EINTEGRITY, which reads as a corrupt
    // download rather than as a tool that lied.
    const version = packuments.get(SDK.name)?.versions['0.1.0'] as {
      dist: { integrity: string; shasum: string };
    };
    const bytes = bytesFor(SDK.name);
    expect(version.dist.integrity).toBe(`sha512-${createHash('sha512').update(bytes).digest('base64')}`);
    expect(version.dist.shasum).toBe(createHash('sha1').update(bytes).digest('hex'));
  });

  it('strips publishConfig rather than echoing it', () => {
    // It asks for `provenance`, which is an attestation only a CI build can
    // produce. Echoed here, npm goes looking for a signature nothing generated.
    const version = packuments.get(SDK.name)?.versions['0.1.0'];
    expect(version).not.toHaveProperty('publishConfig');
    // The rest of the manifest survives — `files` in particular, since that is
    // the field whose effect the whole exercise is checking.
    expect(version).toMatchObject({ files: ['dist', 'AGENT_INSTRUCTIONS.md'] });
  });
});

describe('resolveRegistryRequest', () => {
  const packuments = buildPackuments(ARTIFACTS, ORIGIN, (entry) => bytesFor(entry.name));

  it('serves a packument by name and a tarball by path', () => {
    expect(resolveRegistryRequest(`/${SDK.name}`, packuments, ARTIFACTS)).toMatchObject({
      kind: 'packument',
    });
    expect(resolveRegistryRequest(tarballPath(SDK), packuments, ARTIFACTS)).toEqual({
      kind: 'tarball',
      filePath: SDK.filePath,
    });
  });

  it('refuses a package it was not given, however the URL is spelled', () => {
    // This is the structural half of "serves what `publishedPackages` reports".
    // A registry that could hand out `@waterx/predict-agent-cli` would install a
    // package the release policy keeps `private` (ADR-0009 D-28), and the tester
    // would be observing a first-wave experience that includes the second wave.
    for (const path of [
      '/@waterx/predict-agent-cli',
      '/@waterx/predict-agent-runner',
      `/@waterx/predict-agent-cli/-/${tarballName('@waterx/predict-agent-cli', '0.1.0')}`,
      '/',
      '/@waterx',
    ]) {
      expect(resolveRegistryRequest(path, packuments, ARTIFACTS).kind, path).toBe('not-found');
    }
  });
});

describe('verifyInstalled', () => {
  const present = new Set([
    '/project/node_modules/@waterx/predict-agent-sdk',
    '/project/node_modules/@waterx/predict-agent-sdk/dist',
    '/project/node_modules/@waterx/predict-agent-sdk/dist/src/index.js',
    '/project/node_modules/@waterx/predict-agent-sdk/dist/src/index.d.ts',
    '/project/node_modules/@waterx/predict-agent-sdk/dist/src/bin/describe.js',
    '/project/node_modules/@waterx/predict-agent-sdk/AGENT_INSTRUCTIONS.md',
  ]);
  const shipped: PackedArtifact = {
    ...SDK,
    manifest: {
      name: SDK.name,
      version: SDK.version,
      files: ['dist', 'AGENT_INSTRUCTIONS.md'],
      main: 'dist/src/index.js',
      types: 'dist/src/index.d.ts',
      bin: { 'waterx-predict-agent-sdk': 'dist/src/bin/describe.js' },
    },
  };

  const check = (artifact: PackedArtifact, extra: readonly string[] = []): readonly string[] =>
    verifyInstalled('/project', [artifact], (path) => present.has(path) || extra.includes(path));

  it('passes when everything a manifest promised arrived', () => {
    expect(check(shipped)).toEqual([]);
  });

  it('reports a `files` entry that never arrived', () => {
    const artifact = {
      ...shipped,
      manifest: { ...shipped.manifest, files: ['dist', 'AGENT_INSTRUCTIONS.md', 'SKILL.md'] },
    };
    expect(check(artifact)).toEqual([
      `${SDK.name}: \`files\` promises SKILL.md, and the install has no such path`,
    ]);
  });

  it('checks entry points as paths, because a shipped `dist` can be an empty one', () => {
    // `files: ["dist"]` is satisfied by a directory. What a consumer's resolver
    // reaches for is a file inside it.
    const artifact = { ...shipped, manifest: { ...shipped.manifest, main: 'dist/src/entry.js' } };
    expect(check(artifact)).toEqual([
      `${SDK.name}: \`main\` points at dist/src/entry.js, which the install does not have`,
    ]);
  });

  it('reports a bin the install does not have', () => {
    const artifact = {
      ...shipped,
      manifest: { ...shipped.manifest, bin: { tool: 'dist/src/bin/missing.js' } },
    };
    expect(check(artifact)).toEqual([
      `${SDK.name}: bin points at dist/src/bin/missing.js, which the install does not have`,
    ]);
  });

  it('says a package is not installed rather than listing everything it lacks', () => {
    const problems = verifyInstalled('/elsewhere', [shipped], () => false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not installed');
  });

  it('refuses to be satisfied by a manifest that promises nothing', () => {
    // No `files` means npm ships nearly everything — a different problem, and
    // one an install cannot detect. Passing silently would report a package
    // nobody constrained as a package that was checked.
    const artifact = { ...shipped, manifest: { ...shipped.manifest, files: [] } };
    expect(check(artifact).some((problem) => problem.includes('no literal'))).toBe(true);
  });

  it('reports a glob instead of pretending to have understood it', () => {
    const artifact = { ...shipped, manifest: { ...shipped.manifest, files: ['dist/**'] } };
    expect(check(artifact).some((problem) => problem.includes('was not checked'))).toBe(true);
  });

  it('reads `bin` in both of the shapes npm allows', () => {
    expect(literalFilesEntries({ files: ['a', 'b/*'] })).toEqual({
      literal: ['a'],
      globs: ['b/*'],
    });
    const asString = { ...shipped, manifest: { ...shipped.manifest, bin: 'dist/src/bin/describe.js' } };
    expect(check(asString)).toEqual([]);
  });
});

describe('npmrcFor', () => {
  it('scopes the override, so real dependencies still come from the public registry', () => {
    // An unscoped `registry=` would send `socket.io-client` here too, and the
    // install would have a different shape from the published one — which is
    // the shape being tested.
    expect(npmrcFor(ARTIFACTS, ORIGIN)).toBe(`@waterx:registry=${ORIGIN}\n`);
  });

  it('names every scope once, in a stable order', () => {
    const lines = npmrcFor([...ARTIFACTS, artifact('@other/thing')], ORIGIN).trimEnd().split('\n');
    expect(lines).toEqual([`@other:registry=${ORIGIN}`, `@waterx:registry=${ORIGIN}`]);
  });
});
