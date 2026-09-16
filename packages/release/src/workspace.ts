/**
 * Which packages this workspace publishes, and where they live.
 *
 * The set is derived, not listed. `private: true` is this repository's release
 * gate — a package is published exactly when it lacks that flag — so a new
 * package becomes visible to the SBOM generator and the preflight the moment it
 * becomes publishable, without a second list to forget to update.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WorkspacePackage {
  /** Directory name under `packages/`. */
  readonly id: string;
  /** Absolute path to the package directory. */
  readonly directory: string;
  /** The parsed manifest, verbatim. */
  readonly manifest: Record<string, unknown>;
  readonly name: string;
  readonly version: string;
  readonly published: boolean;
}

/**
 * The repository root, found by walking up from this module until a directory
 * holds `pnpm-workspace.yaml`. Deriving it beats a `../../..` count that breaks
 * the first time the build output moves a level.
 */
export function findRepoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let current = resolve(from);
  for (;;) {
    try {
      readFileSync(join(current, 'pnpm-workspace.yaml'), 'utf8');
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error(`no pnpm-workspace.yaml above ${from}`);
      current = parent;
    }
  }
}

/** Every workspace package, sorted by directory name. */
export function readWorkspacePackages(repoRoot: string): readonly WorkspacePackage[] {
  const packagesDir = join(repoRoot, 'packages');
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const directory = join(packagesDir, id);
      const manifest = JSON.parse(
        readFileSync(join(directory, 'package.json'), 'utf8'),
      ) as Record<string, unknown>;
      return {
        id,
        directory,
        manifest,
        name: String(manifest['name']),
        version: String(manifest['version']),
        published: manifest['private'] !== true,
      };
    });
}

/**
 * The one private package that is distributed anyway — as a self-contained
 * release asset, never to a registry (ADR-0010). Named here rather than in
 * `bundle.ts` so the SBOM generator can reach it without a cycle.
 */
export const BUNDLE_ROOT_PACKAGE = '@waterx/predict-agent-cli';

/** The signer that ships beside it, as its own release asset (ADR-0012). */
export const KEYSTORE_ROOT_PACKAGE = '@waterx/predict-agent-signer-keystore';

/** Every private package distributed as a release asset, in install order. */
export const OPERATOR_ROOT_PACKAGES: readonly string[] = [BUNDLE_ROOT_PACKAGE, KEYSTORE_ROOT_PACKAGE];

export const publishedPackages = (repoRoot: string): readonly WorkspacePackage[] =>
  readWorkspacePackages(repoRoot).filter((pkg) => pkg.published);

/**
 * The SBOM filename for a package: `@waterx/predict-agent-sdk` becomes
 * `waterx-predict-agent-sdk.cdx.json`. Flat, so the directory sorts and diffs
 * readably, and a scope separator never becomes a path separator.
 */
export const sbomFileName = (packageName: string): string =>
  `${packageName.replace(/^@/u, '').replace(/\//gu, '-')}.cdx.json`;
