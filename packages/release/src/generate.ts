/**
 * Emit (or verify) the committed `sbom/v1/*.cdx.json`.
 *
 *   node dist/src/generate.js <output-dir>
 *   node dist/src/generate.js <output-dir> --check
 *
 * `--check` writes nothing and exits non-zero when a committed SBOM has drifted
 * from the installed tree — a dependency bumped without regenerating, or a
 * hand-edited document. The same comparison runs as a test; the flag exists for
 * CI and for a local pre-commit hook.
 *
 * Drift here is not cosmetic: a stale SBOM tells a consumer's scanner that a
 * version they are not running is the one they are.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildSbomArtifacts } from './artifacts.ts';

function main(argv: readonly string[]): number {
  const args = argv.filter((arg) => arg !== '--check');
  const check = argv.includes('--check');
  const target = args[0];
  if (target === undefined) {
    process.stderr.write('usage: generate <output-dir> [--check]\n');
    return 2;
  }

  const outputDir = resolve(process.cwd(), target);
  const artifacts = buildSbomArtifacts();

  if (check) {
    let failed = false;
    for (const artifact of artifacts) {
      const path = join(outputDir, artifact.fileName);
      let current: string;
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        process.stderr.write(`${path} is missing; run the generator.\n`);
        failed = true;
        continue;
      }
      if (current !== artifact.contents) {
        process.stderr.write(`${path} is stale; run the generator.\n`);
        failed = true;
      }
    }

    // A package that stopped being published leaves its SBOM behind, and a
    // stale document for a package nobody ships is still read as current.
    const expected = new Set(artifacts.map((artifact) => artifact.fileName));
    for (const entry of readdirSync(outputDir).filter((name) => name.endsWith('.cdx.json'))) {
      if (!expected.has(entry)) {
        process.stderr.write(`${join(outputDir, entry)} has no published package; delete it.\n`);
        failed = true;
      }
    }

    if (failed) return 1;
    process.stderr.write(`${outputDir} is up to date (${String(artifacts.length)} packages).\n`);
    return 0;
  }

  mkdirSync(outputDir, { recursive: true });
  for (const artifact of artifacts) {
    const path = join(outputDir, artifact.fileName);
    writeFileSync(path, artifact.contents, 'utf8');
    process.stderr.write(`wrote ${path}\n`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
