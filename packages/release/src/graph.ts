/**
 * What a published package actually carries into a consumer.
 *
 * The graph is resolved from `node_modules` on disk rather than from the
 * manifest, because a manifest states a *range* and an SBOM has to state a
 * version. It is resolved by walking the same directory chain Node's resolver
 * walks, so what this file reports is what a consumer's `import` would reach —
 * not what a lockfile section implies, and not what pnpm's virtual store
 * happens to contain for some other package's benefit.
 *
 * Only `dependencies` and `optionalDependencies` are followed.
 * `devDependencies` never reach a consumer, and `peerDependencies` are the
 * consumer's to supply. That exclusion is deliberate and is recorded in the
 * SBOM rather than left for a reader to infer.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A package as installed: one exact version, read from its own manifest. */
export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  /**
   * The declared license string, or `null` when the package declares none.
   * Never guessed: an undeclared license is a fact a human has to settle
   * before publishing, and inventing `MIT` here would hide it.
   */
  readonly license: string | null;
  /** Declared Node range, or `null`. A component below the floor breaks it. */
  readonly engines: string | null;
  /** Resolved `name@version` keys, sorted. */
  readonly dependsOn: readonly string[];
  /** Absolute realpath of the installed directory. */
  readonly directory: string;
}

/** A declared dependency that is not installed. */
export interface UnresolvedDependency {
  /** The `name@version` that declared it. */
  readonly from: string;
  readonly name: string;
  /** Optional dependencies are routinely absent; a required one is a defect. */
  readonly optional: boolean;
}

export interface ComponentGraph {
  /** The published package itself. */
  readonly root: InstalledPackage;
  /** Every third-party package reachable from it, sorted by `name@version`. */
  readonly components: readonly InstalledPackage[];
  readonly unresolved: readonly UnresolvedDependency[];
}

export const packageKey = (pkg: { name: string; version: string }): string =>
  `${pkg.name}@${pkg.version}`;

interface RawManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
  readonly engines?: unknown;
  readonly dependencies?: unknown;
  readonly optionalDependencies?: unknown;
}

const readManifest = (directory: string): RawManifest =>
  JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as RawManifest;

const names = (value: unknown): readonly string[] =>
  typeof value === 'object' && value !== null ? Object.keys(value as object) : [];

/**
 * The declared license, normalized to a string or `null`.
 *
 * npm has three historical shapes here. Only the current one — a plain SPDX
 * expression — is read as declared; the deprecated object and array forms are
 * reported as undeclared so a human looks at them, which is the correct answer
 * for a package whose metadata predates SPDX.
 */
const licenseOf = (manifest: RawManifest): string | null =>
  typeof manifest.license === 'string' && manifest.license.trim() !== ''
    ? manifest.license.trim()
    : null;

const enginesOf = (manifest: RawManifest): string | null => {
  const engines = manifest.engines;
  if (typeof engines !== 'object' || engines === null) return null;
  const node = (engines as { node?: unknown }).node;
  return typeof node === 'string' && node.trim() !== '' ? node.trim() : null;
};

/**
 * Node's own lookup: from `directory`, try `node_modules/<name>` at each level
 * up to the filesystem root. Under pnpm every hit is a symlink into the
 * virtual store, so the result is realpath'd — two different symlinks to one
 * store entry are one component, not two.
 */
export const resolveFrom = (directory: string, name: string): string | null => {
  let current = realpathSync(directory);
  for (;;) {
    const candidate = join(current, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

/** Resolve everything a consumer of the package at `packageDir` would install. */
export function resolveComponentGraph(packageDir: string): ComponentGraph {
  const seen = new Map<string, InstalledPackage>();
  const unresolved: UnresolvedDependency[] = [];

  const visit = (directory: string): InstalledPackage => {
    const manifest = readManifest(directory);
    const name = String(manifest.name);
    const version = String(manifest.version);
    const key = `${name}@${version}`;

    const existing = seen.get(key);
    if (existing !== undefined) return existing;

    // Placed before the recursion so a dependency cycle terminates. npm allows
    // one, and an SBOM generator that stack-overflows on it is worse than one
    // that reports the cycle as the single node it is.
    const partial: InstalledPackage = {
      name,
      version,
      license: licenseOf(manifest),
      engines: enginesOf(manifest),
      dependsOn: [],
      directory,
    };
    seen.set(key, partial);

    const edges: string[] = [];
    const follow = (dependency: string, optional: boolean): void => {
      const resolved = resolveFrom(directory, dependency);
      if (resolved === null) {
        unresolved.push({ from: key, name: dependency, optional });
        return;
      }
      edges.push(packageKey(visit(resolved)));
    };

    for (const dependency of names(manifest.dependencies)) follow(dependency, false);
    for (const dependency of names(manifest.optionalDependencies)) follow(dependency, true);

    const complete: InstalledPackage = { ...partial, dependsOn: [...edges].sort() };
    seen.set(key, complete);
    return complete;
  };

  const root = visit(realpathSync(packageDir));
  const components = [...seen.values()]
    .filter((pkg) => packageKey(pkg) !== packageKey(root))
    .sort((left, right) => packageKey(left).localeCompare(packageKey(right)));

  return {
    root: seen.get(packageKey(root)) ?? root,
    components,
    unresolved: [...unresolved].sort((left, right) =>
      `${left.from} ${left.name}`.localeCompare(`${right.from} ${right.name}`),
    ),
  };
}

/**
 * `name@version` → the registry integrity string, read from the pnpm lockfile.
 *
 * Only the top-level `packages:` block is read, and only its `resolution`
 * integrity. That block is a flat map of exactly the shape this needs; the
 * `snapshots:` block below it carries the peer-resolved graph, which is not
 * used here because the graph comes from disk instead.
 *
 * A key with a peer suffix — `vitest@4.1.10(vite@8.1.5)` — is indexed under its
 * base `name@version`. If two suffixed entries disagree on integrity the base
 * key is dropped rather than resolved arbitrarily: an SBOM that states the
 * wrong hash is worse than one that states none.
 */
export function readIntegrityIndex(lockfileText: string): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();

  let inPackages = false;
  let currentKey: string | null = null;

  for (const line of lockfileText.split('\n')) {
    if (/^\S/u.test(line)) {
      inPackages = line.startsWith('packages:');
      currentKey = null;
      continue;
    }
    if (!inPackages) continue;

    const entry = /^ {2}(\S.*):$/u.exec(line);
    if (entry?.[1] !== undefined) {
      const raw = entry[1].replace(/^'|'$/gu, '');
      const base = raw.includes('(') ? raw.slice(0, raw.indexOf('(')) : raw;
      currentKey = base;
      continue;
    }

    if (currentKey === null) continue;
    const integrity = /resolution:\s*\{integrity:\s*([^,}]+)/u.exec(line);
    if (integrity?.[1] === undefined) continue;

    const value = integrity[1].trim();
    const known = index.get(currentKey);
    if (known !== undefined && known !== value) {
      ambiguous.add(currentKey);
      continue;
    }
    index.set(currentKey, value);
  }

  for (const key of ambiguous) index.delete(key);
  return index;
}
