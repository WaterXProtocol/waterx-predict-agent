/**
 * What a consumer actually receives — assembled here so it can be installed and
 * used before anything is published.
 *
 * The preflight next door answers "is this workspace fit to publish". This
 * answers the question after it: install what is about to ship, into a project
 * that is not this one, and find out what is really in the box. Those are
 * different failures. A manifest can pass every mechanical check and still ship
 * a `files` list that omits the document the package exists to deliver.
 *
 * Two shapes, because they test different steps and neither subsumes the other:
 *
 *  - a KIT — a portable directory whose `package.json` points at vendored
 *    tarballs. No process to keep running, so it can be handed to somebody (or
 *    to an agent under test) as a folder. It answers everything downstream of
 *    the install, faithfully, because the unit it vendors is the tarball rather
 *    than a hand-picked copy of `dist/`.
 *  - a REGISTRY — a scoped HTTP registry, so `npm install <name>` resolves by
 *    NAME. That is the one step a kit answers in advance, and it is the only way
 *    to test it without publishing for real.
 *
 * Both pack what `publishedPackages` reports rather than a list written here, so
 * a package that becomes publishable becomes installable in the same commit, and
 * one that is `private` cannot be served by accident.
 *
 * NOTE ON FIDELITY: `npm pack` reflects the working tree, so both are a snapshot
 * of the last build. Rebuild, then re-pack; a stale tarball is the one way to
 * pass this check while shipping something else.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { publishedPackages, type WorkspacePackage } from './workspace.ts';

export interface PackedArtifact {
  readonly name: string;
  readonly version: string;
  /** The tarball's file name, exactly as a registry would serve it. */
  readonly fileName: string;
  /** Absolute path to the packed tarball. */
  readonly filePath: string;
  /** The package's own manifest, verbatim. */
  readonly manifest: Record<string, unknown>;
}

/** `@waterx/predict-agent-sdk@0.1.0` → `waterx-predict-agent-sdk-0.1.0.tgz`. */
export const tarballName = (name: string, version: string): string =>
  `${name.replace(/^@/u, '').replace(/\//gu, '-')}-${version}.tgz`;

/**
 * Pack every publishable package into `stagingDir`.
 *
 * Runs `npm pack`, which is the point: reimplementing the tarball would test a
 * second implementation of `files` rather than the one npm applies.
 */
export function packPublished(repoRoot: string, stagingDir: string): readonly PackedArtifact[] {
  return publishedPackages(repoRoot).map((pkg: WorkspacePackage) => {
    execFileSync('npm', ['pack', '--pack-destination', stagingDir], {
      cwd: pkg.directory,
      stdio: 'ignore',
    });
    const fileName = tarballName(pkg.name, pkg.version);
    return {
      name: pkg.name,
      version: pkg.version,
      fileName,
      filePath: join(stagingDir, fileName),
      manifest: pkg.manifest,
    };
  });
}

/* ── The kit ─────────────────────────────────────────────────────────────── */

export interface KitOptions {
  /**
   * The consumer project's name.
   *
   * Neutral by default and deliberately so: this folder is handed to whoever is
   * being observed using it, and a name that says "waterx kit" has already told
   * them what the exercise is about.
   */
  readonly name?: string;
  /** Directory the tarballs sit in, relative to the kit root. */
  readonly vendorDir?: string;
}

/**
 * The consumer project's `package.json`.
 *
 * `private: true` because a scratch project that could be published by accident
 * is a scratch project that eventually is.
 */
export function kitManifest(
  artifacts: readonly PackedArtifact[],
  options: KitOptions = {},
): Record<string, unknown> {
  const vendorDir = options.vendorDir ?? 'vendor';
  return {
    name: options.name ?? 'agent-workspace',
    private: true,
    version: '0.0.0',
    type: 'module',
    dependencies: Object.fromEntries(
      artifacts.map((artifact) => [artifact.name, `file:./${vendorDir}/${artifact.fileName}`]),
    ),
  };
}

/* ── The registry ────────────────────────────────────────────────────────── */

export interface Packument {
  readonly name: string;
  readonly 'dist-tags': Readonly<Record<string, string>>;
  readonly versions: Readonly<Record<string, Record<string, unknown>>>;
}

/**
 * The document npm reads before it downloads anything.
 *
 * `publishConfig` is stripped rather than echoed. It carries
 * `provenance: true`, which asks a registry for an attestation only a CI build
 * can produce — meaningless here, and an invitation for npm to look for a
 * signature nothing generated.
 */
export function buildPackuments(
  artifacts: readonly PackedArtifact[],
  origin: string,
  readTarball: (artifact: PackedArtifact) => Buffer | Uint8Array = (artifact) =>
    readFileSync(artifact.filePath),
): Map<string, Packument> {
  const packuments = new Map<string, Packument>();
  for (const artifact of artifacts) {
    const bytes = readTarball(artifact);
    const { publishConfig: _ignored, ...published } = artifact.manifest;
    packuments.set(artifact.name, {
      name: artifact.name,
      'dist-tags': { latest: artifact.version },
      versions: {
        [artifact.version]: {
          ...published,
          dist: {
            tarball: `${origin}${tarballPath(artifact)}`,
            shasum: createHash('sha1').update(bytes).digest('hex'),
            integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
          },
        },
      },
    });
  }
  return packuments;
}

/** Where a tarball is served, matching npm's own layout. */
export const tarballPath = (artifact: PackedArtifact): string =>
  `/${artifact.name}/-/${artifact.fileName}`;

export type RegistryResponse =
  | { readonly kind: 'packument'; readonly body: Packument }
  | { readonly kind: 'tarball'; readonly filePath: string }
  | { readonly kind: 'not-found'; readonly message: string };

/**
 * Route one request.
 *
 * Separated from the server so the routing is testable without binding a port —
 * and so the one property worth asserting can be asserted: this serves what it
 * was given and nothing else, so a `private` package cannot be reached through
 * it however the URL is spelled.
 *
 * `pathname` is expected already decoded: npm asks for `@scope%2fname`.
 */
export function resolveRegistryRequest(
  pathname: string,
  packuments: ReadonlyMap<string, Packument>,
  artifacts: readonly PackedArtifact[],
): RegistryResponse {
  const artifact = artifacts.find((entry) => tarballPath(entry) === pathname);
  if (artifact !== undefined) return { kind: 'tarball', filePath: artifact.filePath };

  const packument = packuments.get(pathname.replace(/^\//u, ''));
  if (packument !== undefined) return { kind: 'packument', body: packument };

  return { kind: 'not-found', message: `not published here: ${pathname}` };
}

/* ── Checking the install ────────────────────────────────────────────────── */

/**
 * The `files` entries that name an exact path.
 *
 * A glob is skipped rather than half-understood: a checker that quietly treated
 * `dist/**` as satisfied by `dist` would pass on a `files` list it never really
 * read. Nothing here uses one today, and the caller reports what was skipped so
 * a future one is visible instead of silently uncovered.
 */
export function literalFilesEntries(manifest: Record<string, unknown>): {
  readonly literal: readonly string[];
  readonly globs: readonly string[];
} {
  const declared = Array.isArray(manifest.files) ? (manifest.files as unknown[]) : [];
  const entries = declared.filter((entry): entry is string => typeof entry === 'string');
  return {
    literal: entries.filter((entry) => !/[*?[\]{}!]/u.test(entry)),
    globs: entries.filter((entry) => /[*?[\]{}!]/u.test(entry)),
  };
}

/**
 * Did an install deliver what each manifest promised?
 *
 * Derived from each package's own `files` and `bin` rather than from a list
 * written here, because a list written here is a second opinion about what
 * should ship, and the whole failure being guarded against is the two opinions
 * disagreeing. `files` promises it; this asks whether it arrived.
 *
 * `exists` is injected so the check is testable without building a tree.
 */
export function verifyInstalled(
  installRoot: string,
  artifacts: readonly PackedArtifact[],
  exists: (path: string) => boolean,
): readonly string[] {
  const problems: string[] = [];
  for (const artifact of artifacts) {
    const root = join(installRoot, 'node_modules', ...artifact.name.split('/'));
    if (!exists(root)) {
      problems.push(`${artifact.name}: not installed at ${root}`);
      continue;
    }

    const { literal, globs } = literalFilesEntries(artifact.manifest);
    if (literal.length === 0) {
      // No `files` means npm ships almost everything, which is a different
      // problem — and not one an install can detect.
      problems.push(`${artifact.name}: declares no literal \`files\` entries to check`);
    }
    for (const entry of literal) {
      if (!exists(join(root, entry))) {
        problems.push(`${artifact.name}: \`files\` promises ${entry}, and the install has no such path`);
      }
    }
    for (const glob of globs) {
      problems.push(`${artifact.name}: \`files\` entry ${glob} is a pattern and was not checked`);
    }

    // `files: ["dist"]` is satisfied by an empty `dist`. The entry points are
    // paths inside it, and they are what a consumer's resolver actually reaches
    // for — so they are checked as paths, not inferred from the directory.
    for (const key of ['main', 'types'] as const) {
      const entry = artifact.manifest[key];
      if (typeof entry === 'string' && !exists(join(root, entry))) {
        problems.push(`${artifact.name}: \`${key}\` points at ${entry}, which the install does not have`);
      }
    }

    const bin = artifact.manifest.bin;
    const targets =
      typeof bin === 'string'
        ? [bin]
        : typeof bin === 'object' && bin !== null
          ? Object.values(bin as Record<string, unknown>).filter(
              (value): value is string => typeof value === 'string',
            )
          : [];
    for (const target of targets) {
      if (!exists(join(root, target))) {
        problems.push(`${artifact.name}: bin points at ${target}, which the install does not have`);
      }
    }
  }
  return problems;
}

/**
 * The `.npmrc` line a consumer needs.
 *
 * Scoped, so only this workspace's packages come from here and every real
 * dependency still resolves from the public registry. An unscoped override
 * would make the install a different shape from the published one, which is the
 * shape under test.
 */
export const npmrcFor = (artifacts: readonly PackedArtifact[], origin: string): string => {
  const scopes = [...new Set(artifacts.map((artifact) => artifact.name.split('/')[0]))]
    .filter((scope) => scope !== undefined && scope.startsWith('@'))
    .sort();
  return `${scopes.map((scope) => `${scope}:registry=${origin}`).join('\n')}\n`;
};
