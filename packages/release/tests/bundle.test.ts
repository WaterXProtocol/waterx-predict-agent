/**
 * The operator bundle's rules, without packing anything.
 *
 * Packing and installing is `pnpm cli:bundle:check`, which reaches the network.
 * What is pinned here is what that command relies on: the manifest a consumer's
 * npm reads, the shape the tarball is held to, and the gate that keeps the
 * bundle out of a release until the decision to ship it has been made.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  adrStatus,
  BUNDLE_ADR_PATH,
  BUNDLE_SBOM_FILE,
  bundledPackagesFor,
  bundleManifest,
  checkBundleListing,
  installSentence,
  KEYSTORE_ADR_PATH,
  heldBackArtifacts,
  OPERATOR_ARTIFACTS,
  releasableArtifacts,
  RUNNER_ADR_PATH,
  runnerSentence,
  releaseRefusal,
  requiredInBundle,
} from '../src/bundle.ts';
import { BUNDLE_ROOT_PACKAGE, findRepoRoot, readWorkspacePackages } from '../src/workspace.ts';

const SDK = '@waterx/predict-agent-sdk';
const SCHEMA = '@waterx/predict-agent-schema';

const cli = (overrides: Record<string, unknown> = {}) => ({
  name: BUNDLE_ROOT_PACKAGE,
  version: '0.1.0',
  private: true,
  bin: { 'waterx-predict': 'dist/src/main.js' },
  files: ['dist', 'README.md'],
  scripts: { build: 'tsc', test: 'vitest run' },
  dependencies: { [SCHEMA]: '0.1.0', [SDK]: 'workspace:*' },
  devDependencies: { vitest: '^4.1.6' },
  ...overrides,
});

const sdk = (dependencies: Record<string, string> = { 'socket.io-client': '^4.8.3' }) => ({
  name: SDK,
  version: '0.1.0',
  dependencies,
});
const schema = { name: SCHEMA, version: '0.1.0' };

describe('bundleManifest', () => {
  it('pins the bundled libraries and lifts their registry dependencies', () => {
    const manifest = bundleManifest(cli(), [sdk(), schema]);

    expect(manifest['dependencies']).toEqual({
      [SCHEMA]: '0.1.0',
      [SDK]: '0.1.0',
      'socket.io-client': '^4.8.3',
    });
    expect(manifest['bundleDependencies']).toEqual([SCHEMA, SDK]);
    // The one third-party runtime dependency is installed from the registry,
    // with the consumer's own integrity checks, and never shipped inside.
    expect(manifest['bundleDependencies']).not.toContain('socket.io-client');
  });

  it('can be installed and never published, and runs nothing at install', () => {
    const manifest = bundleManifest(cli({ private: false, publishConfig: { access: 'public' } }), [sdk(), schema]);
    expect(manifest['private']).toBe(true);
    expect(manifest).not.toHaveProperty('publishConfig');
    expect(manifest).not.toHaveProperty('scripts');
    expect(manifest).not.toHaveProperty('devDependencies');
    expect(manifest['bin']).toEqual({ 'waterx-predict': 'dist/src/main.js' });
  });

  it('ships the SBOM by naming it in files', () => {
    expect(bundleManifest(cli(), [sdk(), schema])['files']).toEqual(['dist', 'README.md', BUNDLE_SBOM_FILE]);
  });

  it('refuses a root with no files list, which would ship its sources', () => {
    expect(() => bundleManifest(cli({ files: undefined }), [sdk(), schema])).toThrow(/declares no `files`/u);
  });

  it('refuses a workspace dependency that is not inside the bundle', () => {
    expect(() => bundleManifest(cli(), [schema])).toThrow(/through the workspace, and it is not bundled/u);
    expect(() => bundleManifest(cli(), [sdk({ '@waterx/predict-agent-other': 'workspace:*' }), schema])).toThrow(
      /through the workspace/u,
    );
  });

  it('refuses to bundle something the root does not use', () => {
    expect(() =>
      bundleManifest(cli(), [sdk(), schema, { name: '@waterx/predict-agent-extra', version: '0.1.0' }]),
    ).toThrow(/does not depend on it/u);
  });

  it('refuses two ranges for one dependency rather than picking one', () => {
    expect(() =>
      bundleManifest(cli({ dependencies: { [SCHEMA]: 'workspace:*', [SDK]: 'workspace:*', 'socket.io-client': '^4.7.0' } }), [
        sdk(),
        schema,
      ]),
    ).toThrow(/required as \^4\.7\.0 and as \^4\.8\.3/u);
  });
});

const CLI_SPEC = OPERATOR_ARTIFACTS[0]!;
const KEYSTORE_SPEC = OPERATOR_ARTIFACTS[1]!;
const RUNNER_SPEC = OPERATOR_ARTIFACTS[2]!;

describe('the tarball listing', () => {
  const bundled = [SCHEMA, SDK];
  const complete = [
    ...requiredInBundle(CLI_SPEC, bundled),
    'package/README.md',
    'package/dist/src/run.js',
    'package/node_modules/@waterx/predict-agent-sdk/dist/src/index.js',
    // A bundled package's own layout is its own business.
    'package/node_modules/@waterx/predict-agent-sdk/src/whatever.ts',
  ];

  it('accepts a bundle with the binary, next, the SBOM and both libraries', () => {
    expect(checkBundleListing(complete, CLI_SPEC, bundled)).toEqual([]);
  });

  it('names what is missing', () => {
    const withoutNext = complete.filter((entry) => !entry.endsWith('commands/next.js'));
    expect(checkBundleListing(withoutNext, CLI_SPEC, bundled)).toEqual(['missing package/dist/src/commands/next.js']);
    const withoutSdk = complete.filter((entry) => entry !== `package/node_modules/${SDK}/package.json`);
    expect(checkBundleListing(withoutSdk, CLI_SPEC, bundled)).toEqual([`missing package/node_modules/${SDK}/package.json`]);
  });

  it('refuses sources, tests and source maps at the top level', () => {
    expect(
      checkBundleListing(
        [...complete, 'package/src/run.ts', 'package/tests/next.test.ts', 'package/dist/src/run.js.map'],
        CLI_SPEC,
        bundled,
      ),
    ).toEqual(['carries package/src/run.ts', 'carries package/tests/next.test.ts', 'carries package/dist/src/run.js.map']);
  });

  it('holds the keystore to its binary, and bundles nothing into it', () => {
    const listing = [...requiredInBundle(KEYSTORE_SPEC, []), 'package/dist/src/agent.js'];
    expect(checkBundleListing(listing, KEYSTORE_SPEC, [])).toEqual([]);
    expect(checkBundleListing(listing.filter((entry) => !entry.endsWith('bin/keystore.js')), KEYSTORE_SPEC, [])).toEqual([
      'missing package/dist/src/bin/keystore.js',
    ]);
  });
});

describe('the release gate', () => {
  it('reads the status line and nothing else', () => {
    expect(adrStatus('# ADR\n\n- Status: Accepted\n- Date: x\n')).toBe('Accepted');
    expect(adrStatus('# ADR\n\n- Status: Proposed\n')).toBe('Proposed');
    // A word in the prose is not a decision.
    expect(adrStatus('# ADR\n\nThis will be Accepted soon.\n')).toBe('UNKNOWN');
    expect(adrStatus('- Status: Approved\n')).toBe('UNKNOWN');
  });

  const repoWith = (
    cli: string | undefined,
    keystore: string | undefined,
    // `null`, not `undefined`: passing `undefined` would take the default and
    // silently write the file this case exists to leave out.
    runner: string | null = 'Accepted',
  ): string => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-gate-'));
    mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
    if (cli !== undefined) writeFileSync(join(root, BUNDLE_ADR_PATH), `# ADR-0010\n\n- Status: ${cli}\n`, 'utf8');
    if (keystore !== undefined) {
      writeFileSync(join(root, KEYSTORE_ADR_PATH), `# ADR-0012\n\n- Status: ${keystore}\n`, 'utf8');
    }
    if (runner !== null) {
      writeFileSync(join(root, RUNNER_ADR_PATH), `# ADR-0029\n\n- Status: ${runner}\n`, 'utf8');
    }
    return root;
  };

  it('refuses a release until every decision is Accepted', () => {
    expect(releaseRefusal(repoWith(undefined, 'Accepted'))).toMatch(/0010.* does not exist/u);
    expect(releaseRefusal(repoWith('Proposed', 'Accepted'))).toMatch(/0010.*is Proposed, not Accepted/u);
    // A CLI released without its signer stops at its first question.
    expect(releaseRefusal(repoWith('Accepted', 'Proposed'))).toMatch(/0012.*is Proposed, not Accepted/u);
    expect(releaseRefusal(repoWith('Accepted', undefined))).toMatch(/0012.* does not exist/u);
    expect(releaseRefusal(repoWith('Superseded', 'Superseded'))).toMatch(/0010.*0012/u);
    expect(releaseRefusal(repoWith('Accepted', 'Accepted'))).toBeUndefined();
  });

  it('holds back an optional artifact instead of refusing the release', () => {
    // The asymmetry ADR-0029 turns on. The Runner is not in the setup sentence,
    // so an undecided daemon must not be able to stop the CLI from shipping —
    // and it must not slip out unnoticed either.
    const undecided = repoWith('Accepted', 'Accepted', 'Proposed');
    expect(releaseRefusal(undecided)).toBeUndefined();
    expect(releasableArtifacts(undecided).map((spec) => spec.root)).toEqual([
      CLI_SPEC.root,
      KEYSTORE_SPEC.root,
    ]);
    expect(heldBackArtifacts(undecided)).toEqual([
      expect.stringContaining('@waterx/predict-agent-runner is NOT in this release'),
    ]);

    const missing = repoWith('Accepted', 'Accepted', null);
    expect(releaseRefusal(missing)).toBeUndefined();
    expect(heldBackArtifacts(missing)[0]).toContain('MISSING');

    const decided = repoWith('Accepted', 'Accepted', 'Accepted');
    expect(releasableArtifacts(decided)).toHaveLength(OPERATOR_ARTIFACTS.length);
    expect(heldBackArtifacts(decided)).toEqual([]);
  });

  it('matches the decision this repository actually holds', () => {
    // Whatever the ADRs say today, the gate must read them — not a copy of them.
    const repoRoot = findRepoRoot();
    const required = OPERATOR_ARTIFACTS.filter((spec) => spec.optional !== true);
    expect(releaseRefusal(repoRoot) === undefined).toBe(
      required.every((spec) => adrStatus(readAdr(repoRoot, spec.adr)) === 'Accepted'),
    );
    expect(releasableArtifacts(repoRoot).length + heldBackArtifacts(repoRoot).length).toBe(
      OPERATOR_ARTIFACTS.length,
    );
  });
});

describe('the workspace', () => {
  it('ships the keystore alone, with nothing of the workspace inside it', () => {
    const { root, bundled } = bundledPackagesFor(readWorkspacePackages(findRepoRoot()), KEYSTORE_SPEC.root);
    expect(root.name).toBe('@waterx/predict-agent-signer-keystore');
    expect(bundled).toEqual([]);
    const manifest = bundleManifest(root.manifest, []);
    expect(manifest['private']).toBe(true);
    expect(manifest['bin']).toEqual({ 'waterx-predict-keystore': 'dist/src/bin/keystore.js' });
    expect(Object.keys(manifest['dependencies'] as object)).toEqual(['@mysten/sui']);
  });


  it('ships the Runner with its own Node floor and no third-party dependency', () => {
    // The two facts ADR-0029 turns on. The floor travels IN the tarball, which
    // is what lets a Node 20 operator install the CLI and be refused only this;
    // and nothing third-party enters the process that decides what gets signed,
    // which is ADR-0007's other half.
    const { root, bundled } = bundledPackagesFor(readWorkspacePackages(findRepoRoot()), RUNNER_SPEC.root);
    expect(root.name).toBe('@waterx/predict-agent-runner');
    expect(bundled.map((pkg) => pkg.name).sort()).toEqual([SCHEMA, SDK]);

    const manifest = bundleManifest(
      root.manifest,
      bundled.map((pkg) => pkg.manifest),
    );
    expect(manifest['private']).toBe(true);
    expect(manifest['engines']).toEqual({ node: '>=24' });
    expect(manifest['bin']).toEqual({ 'waterx-predict-runnerd': 'dist/src/bin/runnerd.js' });
    expect(manifest['bundleDependencies']).toEqual([SCHEMA, SDK]);
    // The SDK's one runtime dependency is lifted, and there is nothing else.
    expect(Object.keys(manifest['dependencies'] as object).sort()).toEqual([SCHEMA, SDK, 'socket.io-client']);
  });

  it('keeps the Runner out of the sentence that installs the minimum setup', () => {
    // Putting it there would raise the floor of the minimum setup to Node 24 to
    // buy a capability the minimum setup does not use.
    const sentence = installSentence(['<cli>', '<keystore>']);
    expect(sentence).not.toContain('runner');
    expect(runnerSentence('<runner>')).toContain('Node 24');
    expect(runnerSentence('<runner>')).toContain('waterx-predict-runnerd');
  });

  it('bundles exactly the published packages the CLI depends on', () => {
    const { root, bundled } = bundledPackagesFor(readWorkspacePackages(findRepoRoot()));
    expect(root.name).toBe(BUNDLE_ROOT_PACKAGE);
    expect(bundled.map((pkg) => pkg.name).sort()).toEqual([SCHEMA, SDK]);
    expect(bundled.every((pkg) => pkg.published)).toBe(true);
  });

  it('builds a manifest from the real packages without refusing', () => {
    const { root, bundled } = bundledPackagesFor(readWorkspacePackages(findRepoRoot()));
    const manifest = bundleManifest(
      root.manifest,
      bundled.map((pkg) => pkg.manifest),
    );
    const dependencies = manifest['dependencies'] as Record<string, string>;
    expect(Object.values(dependencies).some((range) => range.startsWith('workspace:'))).toBe(false);
  });
});

describe('installSentence', () => {
  it('uses npx --no, so a missing install is a failure rather than a registry lookup', () => {
    const sentence = installSentence([
      'https://example.invalid/waterx-predict-agent-cli-0.1.0.tgz',
      'https://example.invalid/waterx-predict-agent-signer-keystore-0.1.0.tgz',
    ]);
    // One `npm install`, so both binaries land in one `.bin` on one PATH.
    expect(sentence).toContain(
      'npm install https://example.invalid/waterx-predict-agent-cli-0.1.0.tgz https://example.invalid/waterx-predict-agent-signer-keystore-0.1.0.tgz`',
    );
    expect(sentence).toContain('npx --no waterx-predict next --json');
  });
});

function readAdr(repoRoot: string, path: string): string {
  try {
    return readFileSync(join(repoRoot, path), 'utf8');
  } catch {
    return '';
  }
}
