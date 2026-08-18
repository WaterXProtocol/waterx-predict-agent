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
import { findRepoRoot, publishedPackages, sbomFileName } from './workspace.ts';

export const SBOM_DIR = join('sbom', 'v1');

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

/** Build every SBOM from the installed tree. Pure with respect to the clock. */
export function buildSbomArtifacts(repoRoot: string = findRepoRoot()): readonly SbomArtifact[] {
  const integrity = readIntegrityIndex(readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  const tool = { name: '@waterx/predict-agent-release', version: toolVersion(repoRoot) };

  return publishedPackages(repoRoot).map((pkg) => ({
    fileName: sbomFileName(pkg.name),
    packageName: pkg.name,
    contents: serializeSbom(buildSbom(resolveComponentGraph(pkg.directory), { tool, integrity })),
  }));
}
