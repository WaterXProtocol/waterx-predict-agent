#!/usr/bin/env node
/**
 * `pnpm kit` — build a portable consumer project against the packed tarballs.
 *
 *   node dist/src/bin/kit.js <output-dir> [--name <project-name>]
 *
 * The output is a directory somebody can be handed: `npm install` in it produces
 * the same `node_modules` a published install would, because the unit vendored
 * is the tarball rather than a hand-picked copy of `dist/`. That distinction is
 * the whole value — a hand-assembled folder tests the copier's judgement about
 * what belongs in the package, which is exactly the judgement `files` is
 * supposed to be making.
 *
 * What it does NOT cover, stated so it is not read into the result: the step
 * where a name becomes an install. The dependencies are already written down
 * here. `bin/registry.ts` is the tool for that step.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { kitManifest, packPublished } from '../consumer.ts';
import { findRepoRoot } from '../workspace.ts';

function main(argv: readonly string[]): number {
  const flagIndex = argv.indexOf('--name');
  const name = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  const target = argv.filter((arg, index) => !arg.startsWith('--') && index !== flagIndex + 1)[0];

  if (target === undefined) {
    process.stderr.write('usage: kit <output-dir> [--name <project-name>]\n');
    return 2;
  }

  const outputDir = resolve(process.cwd(), target);
  const vendorDir = join(outputDir, 'vendor');
  const staging = mkdtempSync(join(tmpdir(), 'waterx-kit-'));

  try {
    const artifacts = packPublished(findRepoRoot(), staging);
    if (artifacts.length === 0) {
      process.stderr.write('nothing is publishable, so there is no kit to build.\n');
      return 1;
    }

    mkdirSync(vendorDir, { recursive: true });
    for (const artifact of artifacts) {
      cpSync(artifact.filePath, join(vendorDir, artifact.fileName));
      process.stderr.write(`vendored ${artifact.name}@${artifact.version}\n`);
    }

    writeFileSync(
      join(outputDir, 'package.json'),
      // `exactOptionalPropertyTypes`: an absent flag must be an absent property,
      // not a present one holding `undefined`.
      `${JSON.stringify(kitManifest(artifacts, name === undefined ? {} : { name }), null, 2)}\n`,
      'utf8',
    );

    process.stderr.write(`\nkit at ${outputDir}\n`);
    process.stderr.write('  cd there and run `npm install`.\n');
    process.stderr.write('  rebuild and re-run this to refresh: the tarballs are a snapshot.\n');
    return 0;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

process.exitCode = main(process.argv.slice(2));
