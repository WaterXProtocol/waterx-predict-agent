/**
 * The committed SBOMs must be exactly what the generator produces.
 *
 * This is the same discipline `schemas/v1/agent-commands.json` and
 * `agent-instructions/AGENT_INSTRUCTIONS.md` are held to: a generated file that
 * is committed and never re-derived is a file that quietly stops being true.
 * A stale SBOM is worse than a missing one — it tells a consumer's scanner that
 * a version they are not running is the version they are.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSbomArtifacts, SBOM_DIR } from '../src/artifacts.ts';
import { findRepoRoot, publishedPackages, sbomFileName } from '../src/workspace.ts';

const repoRoot = findRepoRoot();
const sbomDir = join(repoRoot, SBOM_DIR);
const artifacts = buildSbomArtifacts(repoRoot);

describe('sbomFileName', () => {
  it('flattens a scope so a package name never becomes a path', () => {
    expect(sbomFileName('@waterx/predict-agent-sdk')).toBe('waterx-predict-agent-sdk.cdx.json');
    expect(sbomFileName('ws')).toBe('ws.cdx.json');
  });
});

describe('the committed SBOM set', () => {
  it('covers every published package and nothing else', () => {
    const expected = publishedPackages(repoRoot).map((pkg) => sbomFileName(pkg.name)).sort();
    expect(artifacts.map((artifact) => artifact.fileName).sort()).toEqual(expected);
    expect(readdirSync(sbomDir).filter((name) => name.endsWith('.cdx.json')).sort()).toEqual(expected);
  });

  it('is committed, and byte-identical to a fresh generation', () => {
    for (const artifact of artifacts) {
      const path = join(sbomDir, artifact.fileName);
      expect(existsSync(path), `${artifact.fileName} is missing; run \`pnpm sbom:generate\``).toBe(true);
      expect(readFileSync(path, 'utf8'), `${artifact.fileName} is stale; run \`pnpm sbom:generate\``).toBe(
        artifact.contents,
      );
    }
  });

  it('regenerates identically twice in a row', () => {
    const again = buildSbomArtifacts(repoRoot);
    expect(again.map((artifact) => artifact.contents)).toEqual(artifacts.map((artifact) => artifact.contents));
  });

  it('parses as JSON and declares the CycloneDX version tools key on', () => {
    for (const artifact of artifacts) {
      const document = JSON.parse(artifact.contents) as Record<string, unknown>;
      expect(document['bomFormat']).toBe('CycloneDX');
      expect(document['specVersion']).toBe('1.6');
      expect(String(document['serialNumber'])).toMatch(/^urn:uuid:/u);
    }
  });

  it('lists the socket.io transport chain the SDK actually ships', () => {
    const sdk = artifacts.find((artifact) => artifact.packageName === '@waterx/predict-agent-sdk');
    const document = JSON.parse(sdk?.contents ?? '{}') as { components: { name: string }[] };
    const names = document.components.map((component) => component.name);
    expect(names).toContain('socket.io-client');
    expect(names).toContain('engine.io-client');
    expect(names).toContain('ws');
  });

  it('ships no third-party runtime dependency from the schema package', () => {
    const schema = artifacts.find((artifact) => artifact.packageName === '@waterx/predict-agent-schema');
    const document = JSON.parse(schema?.contents ?? '{}') as { components: unknown[] };
    expect(document.components).toEqual([]);
  });
});
