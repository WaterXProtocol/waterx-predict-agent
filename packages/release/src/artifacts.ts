/**
 * The committed SBOM set: one CycloneDX document per published package.
 *
 * Kept separate from the CLI entry point so a test can build the same bytes the
 * generator writes and compare them against what is committed. That comparison
 * is the whole point of a reproducible artifact — a generated file nobody
 * re-derives is just a file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveComponentGraph, readIntegrityIndex } from './graph.ts';
import { buildSbom, serializeSbom } from './sbom.ts';
import {
  BUNDLE_ROOT_PACKAGE,
  OPERATOR_ROOT_PACKAGES,
  findRepoRoot,
  publishedPackages,
  readWorkspacePackages,
  sbomFileName,
} from './workspace.ts';

export const SBOM_DIR = join('sbom', 'v1');

/** The operator bundle's SBOM. Its own directory, because it is not a published package. */
export const BUNDLE_SBOM_DIR = join('sbom', 'bundle');

export interface SbomArtifact {
  /** Path relative to the SBOM output directory. */
  readonly fileName: string;
  readonly packageName: string;
  readonly contents: string;
}

const toolVersion = (repoRoot: string): string => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'packages', 'release', 'package.json'), 'utf8'),
  ) as { name?: unknown; version?: unknown };
  return String(manifest.version);
};

const sbomOptions = (repoRoot: string) => ({
  integrity: readIntegrityIndex(readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')),
  tool: { name: '@waterx/predict-agent-release', version: toolVersion(repoRoot) },
});

/** Build every SBOM from the installed tree. Pure with respect to the clock. */
export function buildSbomArtifacts(repoRoot: string = findRepoRoot()): readonly SbomArtifact[] {
  const { integrity, tool } = sbomOptions(repoRoot);

  return publishedPackages(repoRoot).map((pkg) => ({
    fileName: sbomFileName(pkg.name),
    packageName: pkg.name,
    contents: serializeSbom(buildSbom(resolveComponentGraph(pkg.directory), { tool, integrity })),
  }));
}

/**
 * An operator artifact's SBOM: the package, anything bundled inside it, and
 * every third-party package they reach — resolved from its installed tree, which
 * is the same closure the artifact installs into a consumer.
 */
export function buildBundleSbom(repoRoot: string = findRepoRoot(), packageName: string = BUNDLE_ROOT_PACKAGE): string {
  const root = readWorkspacePackages(repoRoot).find((pkg) => pkg.name === packageName);
  if (root === undefined) throw new Error(`${packageName} is not in this workspace.`);
  return serializeSbom(buildSbom(resolveComponentGraph(root.directory), sbomOptions(repoRoot)));
}

/** One SBOM per operator artifact, committed under `sbom/bundle/`. */
export const bundleSbomArtifacts = (repoRoot: string = findRepoRoot()): readonly SbomArtifact[] =>
  OPERATOR_ROOT_PACKAGES.map((packageName) => ({
    fileName: sbomFileName(packageName),
    packageName,
    contents: buildBundleSbom(repoRoot, packageName),
  }));
