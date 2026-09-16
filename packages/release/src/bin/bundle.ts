#!/usr/bin/env node
/**
 * `pnpm cli:bundle` — build the operator bundle.
 *
 *   node dist/src/bin/bundle.js [--out <dir>] [--release]
 *
 * Without `--release` this builds a bundle anyone in this repository may install
 * and inspect. With it, the bundle is being prepared for a release, and that is
 * refused unless ADR-0010 (the CLI) and ADR-0012 (the keystore signer) are both
 * Accepted: the decisions to hand an order-placing executable and a key-holding
 * one to people outside this repository are recorded there, and this is the one
 * place they are enforced mechanically.
 *
 * Packs the working tree: build first.
 */
import { join, resolve } from 'node:path';

import { buildBundle, installSentence, releaseRefusal } from '../bundle.ts';
import { findRepoRoot } from '../workspace.ts';

function main(argv: readonly string[]): number {
  const release = argv.includes('--release');
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && (out === undefined || out.startsWith('--'))) {
    process.stderr.write('usage: bundle [--out <dir>] [--release]\n');
    return 2;
  }

  const repoRoot = findRepoRoot();
  if (release) {
    const refusal = releaseRefusal(repoRoot);
    if (refusal !== undefined) {
      process.stderr.write(`refused: ${refusal}\n`);
      return 1;
    }
  }

  // Relative to where the command was typed, or the workspace's own `dist/`
  // by default — never the release package's, which the next build wipes.
  const bundle = buildBundle(
    repoRoot,
    out === undefined ? join(repoRoot, 'dist', 'bundle') : resolve(process.env['INIT_CWD'] ?? process.cwd(), out),
  );
  const lines = bundle.artifacts.flatMap((artifact) => [
    `${artifact.name}@${artifact.version}${artifact.bundled.length > 0 ? `, with ${artifact.bundled.join(' and ')} inside` : ''}`,
    `  ${artifact.filePath}`,
    `  sha256 ${artifact.sha256}`,
    `  ${artifact.sbomPath}`,
  ]);
  process.stderr.write(
    [
      ...lines,
      `${bundle.checksumsPath}`,
      '',
      'Once they are attached to a release, the whole setup is one sentence:',
      `  ${installSentence(bundle.artifacts.map((artifact) => `<release-asset-url>/${artifact.fileName}`))}`,
      '',
    ].join('\n'),
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
