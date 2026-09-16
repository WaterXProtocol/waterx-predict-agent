/**
 * The operator bundle: the `waterx-predict` CLI as ONE installable tarball.
 *
 * WHY THIS EXISTS. An agent host's whole setup can be one sentence — "install
 * this, run `waterx-predict next --json`, do what it says" — only if "install
 * this" is one command that yields a working binary. The CLI cannot get there
 * by itself: it depends on the SDK and the schema through `workspace:*`, which
 * npm does not understand, and neither of those is on a registry yet. Installing
 * this repository by git URL does not help either: its root is a private pnpm
 * workspace with no `bin`, and npm cannot install a subdirectory of a git
 * repository.
 *
 * So the two libraries travel INSIDE the CLI's tarball, as `bundleDependencies`,
 * taken from their own `npm pack` output — the same bytes their tarballs would
 * carry, never a hand-picked copy of `dist/`. Their third-party dependencies are
 * NOT bundled; they are lifted onto the bundle's own `dependencies`, so npm
 * installs them from the registry with the lockfile and integrity checks a
 * consumer already trusts, and a vulnerability fix in one reaches the bundle on
 * the consumer's next install rather than on our next release.
 *
 * WHAT IT DOES NOT CHANGE. The bundle is `private: true`, so `npm publish`
 * refuses it outright; it is a release asset, not a registry package. It carries
 * no lifecycle script, so an installer running with `--ignore-scripts` — the
 * setting a careful operator uses — gets the same thing as everybody else. And
 * whether it may be handed to anyone outside this repository is not decided
 * here: it is ADR-0010, which `--release` reads before it will produce an
 * artifact for a release.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { buildBundleSbom } from './artifacts.ts';
import { tarballName } from './consumer.ts';
import { BUNDLE_ROOT_PACKAGE, KEYSTORE_ROOT_PACKAGE, readWorkspacePackages, type WorkspacePackage } from './workspace.ts';

/** The decision that authorizes handing the CLI bundle to anyone. */
export const BUNDLE_ADR_PATH = join('docs', 'adr', '0010-operator-cli-bundle.md');

/** The decision that authorizes handing the keystore signer to anyone. */
export const KEYSTORE_ADR_PATH = join('docs', 'adr', '0012-operator-keystore-signer.md');

/**
 * What an operator installs, one tarball each.
 *
 * Two, not one, because the signer is a separate PROCESS with a separate trust
 * boundary: the CLI must never import it (it would put the Sui SDK and a key
 * path into the process that decides policy), so it cannot live inside the
 * CLI's tarball either — npm links a bundled package's binary nowhere a shell
 * can find it. Installed side by side, both binaries land in
 * `node_modules/.bin`, which is on PATH for everything `npx` runs.
 */
export interface OperatorArtifactSpec {
  readonly root: string;
  /** The ADR whose `Accepted` status allows a release to carry it. */
  readonly adr: string;
  /** Paths under `package/` the tarball must contain, beyond the manifest and SBOM. */
  readonly required: readonly string[];
}

export const OPERATOR_ARTIFACTS: readonly OperatorArtifactSpec[] = [
  {
    root: BUNDLE_ROOT_PACKAGE,
    adr: BUNDLE_ADR_PATH,
    required: ['dist/src/main.js', 'dist/src/commands/next.js'],
  },
  {
    root: KEYSTORE_ROOT_PACKAGE,
    adr: KEYSTORE_ADR_PATH,
    required: ['dist/src/bin/keystore.js'],
  },
];

/** The file that ships the SBOM inside the bundle, and beside it in a release. */
export const BUNDLE_SBOM_FILE = 'sbom.cdx.json';

type Manifest = Record<string, unknown>;

const record = (value: unknown): Record<string, string> =>
  typeof value === 'object' && value !== null ? { ...(value as Record<string, string>) } : {};

/**
 * The bundle's manifest, from the CLI's and the bundled packages'.
 *
 * Pure, so every rule it applies is testable without packing anything:
 *
 * - every dependency that is a workspace package is pinned to that package's
 *   exact version and listed in `bundleDependencies` — it is IN the tarball, and
 *   a range would claim a choice the bundle does not offer;
 * - every third-party dependency of a bundled package is lifted onto the root,
 *   so it resolves from the registry; two different ranges for one name is a
 *   refusal, not a pick;
 * - build and test plumbing is dropped, and `private` is forced on, so the
 *   tarball can be installed and can never be published by name;
 * - the SBOM is added to `files`, because npm ships nothing it is not told to,
 *   and a root that declares no `files` is refused — it would ship its sources.
 */
export function bundleManifest(root: Manifest, bundled: readonly Manifest[]): Manifest {
  const bundledNames = new Map(bundled.map((pkg) => [String(pkg['name']), String(pkg['version'])]));
  const dependencies: Record<string, string> = {};

  for (const [name, range] of Object.entries(record(root['dependencies']))) {
    const pinned = bundledNames.get(name);
    if (pinned === undefined && range.startsWith('workspace:')) {
      throw new Error(`${String(root['name'])} depends on ${name} through the workspace, and it is not bundled.`);
    }
    dependencies[name] = pinned ?? range;
  }
  for (const name of bundledNames.keys()) {
    if (!(name in dependencies)) {
      throw new Error(`${name} is bundled but ${String(root['name'])} does not depend on it.`);
    }
  }

  for (const pkg of bundled) {
    for (const [name, range] of Object.entries(record(pkg['dependencies']))) {
      if (bundledNames.has(name)) continue;
      if (range.startsWith('workspace:')) {
        throw new Error(`${String(pkg['name'])} depends on ${name} through the workspace, and it is not bundled.`);
      }
      const existing = dependencies[name];
      if (existing !== undefined && existing !== range) {
        throw new Error(
          `${name} is required as ${existing} and as ${range}. The bundle states one range per dependency; align them.`,
        );
      }
      dependencies[name] = range;
    }
  }

  const files = root['files'];
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`${String(root['name'])} declares no \`files\`, so its tarball would carry its sources and tests.`);
  }

  const sorted = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
  const {
    scripts: _scripts,
    devDependencies: _devDependencies,
    publishConfig: _publishConfig,
    ...kept
  } = root;
  return {
    ...kept,
    private: true,
    files: [...new Set([...(files as string[]), BUNDLE_SBOM_FILE])],
    dependencies: sorted,
    bundleDependencies: [...bundledNames.keys()].sort(),
  };
}

export type AdrStatus = 'Accepted' | 'Proposed' | 'Superseded' | 'Deferred' | 'UNKNOWN';

/** The `- Status:` line of an ADR, and nothing cleverer. */
export function adrStatus(text: string): AdrStatus {
  const match = /^- Status:\s*(\w+)/mu.exec(text);
  const value = match?.[1];
  return value === 'Accepted' || value === 'Proposed' || value === 'Superseded' || value === 'Deferred'
    ? value
    : 'UNKNOWN';
}

/**
 * Whether a release may carry the operator artifacts, read from the decisions
 * themselves.
 *
 * Read rather than remembered: a workflow input that said "yes" would be a
 * second place the decision lives, and the one nobody reviews. All or nothing,
 * because the setup sentence installs both: a CLI released without a signer is
 * a CLI that stops at its first question.
 */
export function releaseRefusal(repoRoot: string): string | undefined {
  const refusals: string[] = [];
  for (const spec of OPERATOR_ARTIFACTS) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, spec.adr), 'utf8');
    } catch {
      refusals.push(`${spec.adr} does not exist, so nothing authorizes distributing ${spec.root}.`);
      continue;
    }
    const status = adrStatus(text);
    if (status !== 'Accepted') {
      refusals.push(`${spec.adr} is ${status}, not Accepted, so ${spec.root} cannot be released.`);
    }
  }
  return refusals.length === 0
    ? undefined
    : `${refusals.join(' ')} ADR-0009 D-28 keeps these private until then; they can be built and checked, and not released.`;
}

/** Paths an operator artifact must never carry. Source and tests are not what an operator runs. */
export const FORBIDDEN_IN_BUNDLE: readonly RegExp[] = [
  /^package\/src\//u,
  /^package\/tests\//u,
  /^package\/tsconfig/u,
  /^package\/vitest/u,
  /\.map$/u,
];

/** What an artifact's tarball must contain to do its job. */
export function requiredInBundle(spec: OperatorArtifactSpec, bundled: readonly string[]): readonly string[] {
  return [
    'package/package.json',
    `package/${BUNDLE_SBOM_FILE}`,
    ...spec.required.map((path) => `package/${path}`),
    ...bundled.map((name) => `package/node_modules/${name}/package.json`),
  ];
}

/** Problems with a tarball's file list. Empty means it is shaped as promised. */
export function checkBundleListing(
  entries: readonly string[],
  spec: OperatorArtifactSpec,
  bundled: readonly string[],
): readonly string[] {
  const present = new Set(entries.map((entry) => entry.replace(/\/$/u, '')));
  const problems: string[] = [];
  for (const required of requiredInBundle(spec, bundled)) {
    if (!present.has(required)) problems.push(`missing ${required}`);
  }
  for (const entry of present) {
    // Inside a bundled package its own `files` already decided; only the
    // artifact's top level is held to this list.
    if (entry.startsWith('package/node_modules/')) continue;
    if (FORBIDDEN_IN_BUNDLE.some((pattern) => pattern.test(entry))) problems.push(`carries ${entry}`);
  }
  return problems;
}

export interface BuiltArtifact {
  readonly name: string;
  readonly version: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly sha256: string;
  readonly sbomPath: string;
  readonly bundled: readonly string[];
}

export interface BuiltBundle {
  /** In `OPERATOR_ARTIFACTS` order: the CLI first. */
  readonly artifacts: readonly BuiltArtifact[];
  /** `SHA256SUMS` for every artifact, in the format `sha256sum -c` reads. */
  readonly checksumsPath: string;
}

/** The workspace packages a root depends on, which is exactly what gets bundled into it. */
export function bundledPackagesFor(
  packages: readonly WorkspacePackage[],
  rootName: string = BUNDLE_ROOT_PACKAGE,
): {
  root: WorkspacePackage;
  bundled: readonly WorkspacePackage[];
} {
  const root = packages.find((pkg) => pkg.name === rootName);
  if (root === undefined) throw new Error(`${rootName} is not in this workspace.`);
  const names = Object.entries(record(root.manifest['dependencies']))
    .filter(([, range]) => range.startsWith('workspace:'))
    .map(([name]) => name);
  const bundled = names.map((name) => {
    const found = packages.find((pkg) => pkg.name === name);
    if (found === undefined) throw new Error(`${name} is not in this workspace.`);
    if (!found.published) {
      // A private workspace package inside an artifact would ship something that
      // never passed the published-package gates: files, engines, exports.
      throw new Error(`${name} is private, so it cannot be bundled.`);
    }
    return found;
  });
  return { root, bundled };
}

const pack = (tool: 'npm' | 'pnpm', directory: string, destination: string): string => {
  const before = new Set(readdirSync(destination));
  execFileSync(tool, ['pack', '--pack-destination', destination], { cwd: directory, stdio: 'ignore' });
  const created = readdirSync(destination).filter((entry) => entry.endsWith('.tgz') && !before.has(entry));
  if (created.length !== 1) throw new Error(`${tool} pack in ${directory} produced ${String(created.length)} tarballs.`);
  return join(destination, created[0] ?? '');
};

const extract = (tarball: string, into: string): string => {
  mkdirSync(into, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', into], { stdio: 'ignore' });
  return join(into, 'package');
};

export const listTarball = (tarball: string): readonly string[] =>
  execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim() !== '');

function buildArtifact(
  repoRoot: string,
  spec: OperatorArtifactSpec,
  packages: readonly WorkspacePackage[],
  outDir: string,
  scratch: string,
): BuiltArtifact {
  const { root, bundled } = bundledPackagesFor(packages, spec.root);
  const work = mkdtempSync(join(scratch, `${root.id}-`));

  // pnpm packs the root, because only pnpm rewrites `workspace:*`; the rest of
  // the manifest is replaced below anyway, but `files` is applied by the tool
  // that owns it rather than re-implemented here.
  const stage = extract(pack('pnpm', root.directory, work), join(work, 'root'));
  const bundledManifests: Manifest[] = [];
  for (const pkg of bundled) {
    const unpacked = extract(pack('npm', pkg.directory, work), join(work, pkg.id));
    const target = join(stage, 'node_modules', ...pkg.name.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    renameSync(unpacked, target);
    bundledManifests.push(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as Manifest);
  }

  const manifest = bundleManifest(root.manifest, bundledManifests);
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  cpSync(join(repoRoot, 'LICENSE'), join(stage, 'LICENSE'));
  const sbom = buildBundleSbom(repoRoot, root.name);
  writeFileSync(join(stage, BUNDLE_SBOM_FILE), sbom, 'utf8');

  const fileName = tarballName(root.name, root.version);
  const filePath = join(outDir, fileName);
  rmSync(filePath, { force: true });
  // Its own directory: the intermediate tarball in `work` has the same name,
  // and a pack that overwrote it would look like no pack at all.
  const finalDir = join(work, 'final');
  mkdirSync(finalDir);
  renameSync(pack('npm', stage, finalDir), filePath);

  const names = bundled.map((pkg) => pkg.name);
  const problems = checkBundleListing(listTarball(filePath), spec, names);
  if (problems.length > 0) {
    rmSync(filePath, { force: true });
    throw new Error(`${fileName} is not shaped as promised:\n  ${problems.join('\n  ')}`);
  }

  const sbomPath = join(outDir, `${fileName.replace(/\.tgz$/u, '')}.cdx.json`);
  writeFileSync(sbomPath, sbom, 'utf8');
  return {
    name: root.name,
    version: root.version,
    fileName,
    filePath,
    sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    sbomPath,
    bundled: names,
  };
}

/**
 * Assemble, pack and checksum every operator artifact into `outDir`.
 *
 * Packs the working tree, like every other packing step here: build first. Each
 * tarball is checked against its promised shape before it is reported, so an
 * artifact that comes back from this function has its binary in it.
 */
export function buildBundle(repoRoot: string, outDir: string): BuiltBundle {
  const packages = readWorkspacePackages(repoRoot);
  const versions = new Set(
    OPERATOR_ARTIFACTS.map((spec) => packages.find((pkg) => pkg.name === spec.root)?.version),
  );
  if (versions.size !== 1) {
    // One sentence installs them together; two versions in it is two releases.
    throw new Error(`the operator artifacts must share one version; found ${[...versions].join(', ')}.`);
  }
  mkdirSync(outDir, { recursive: true });
  const scratch = mkdtempSync(join(outDir, '.bundle-'));
  try {
    const artifacts = OPERATOR_ARTIFACTS.map((spec) => buildArtifact(repoRoot, spec, packages, outDir, scratch));
    const checksumsPath = join(outDir, 'SHA256SUMS');
    writeFileSync(
      checksumsPath,
      artifacts.map((artifact) => `${artifact.sha256}  ${artifact.fileName}\n`).join(''),
      'utf8',
    );
    return { artifacts, checksumsPath };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The one-sentence setup, spelled for the download URLs of the CLI and the
 * signer. One `npm install`, so both binaries land in one `.bin`.
 */
export function installSentence(urls: readonly string[]): string {
  return `Run \`npm install ${urls.join(' ')}\`, then \`npx --no waterx-predict next --json\`, and do what it says.`;
}
