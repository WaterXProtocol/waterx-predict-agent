#!/usr/bin/env node
/**
 * `pnpm cli:bundle` — build the operator bundle.
 *
 *   node dist/src/bin/bundle.js [--out <dir>] [--release]
 *
 * Without `--release` this builds every artifact, for anyone in this repository
 * to install and inspect — which is how an artifact's ADR gets reviewed against
 * something that exists rather than against a description. With it, the bundle
 * is being prepared for a release: refused outright unless ADR-0010 (the CLI)
 * and ADR-0012 (the keystore signer) are both Accepted, and carrying an OPTIONAL
 * artifact only if its own ADR is Accepted too — ADR-0029 (the Runner), whose
 * absence is reported rather than refusing the release, because nothing in the
 * setup sentence stops without it.
 *
 * Packs the working tree: build first.
 */
import { join, resolve } from 'node:path';

import {
  buildBundle,
  heldBackArtifacts,
  installSentence,
  releasableArtifacts,
  releaseRefusal,
  runnerSentence,
} from '../bundle.ts';
import { RUNNER_ROOT_PACKAGE } from '../workspace.ts';
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
  const heldBack = release ? heldBackArtifacts(repoRoot) : [];
  if (release) {
    const refusal = releaseRefusal(repoRoot);
    if (refusal !== undefined) {
      process.stderr.write(`refused: ${refusal}\n`);
      return 1;
    }
  }

  // Relative to where the command was typed, or the workspace's own `dist/`
  // by default — never the release package's, which the next build wipes.
  // A release carries only what a decision authorizes. Without `--release` all
  // three are built, because building and checking an artifact is how its ADR
  // gets reviewed against something that exists.
  const bundle = buildBundle(
    repoRoot,
    out === undefined ? join(repoRoot, 'dist', 'bundle') : resolve(process.env['INIT_CWD'] ?? process.cwd(), out),
    release ? releasableArtifacts(repoRoot) : undefined,
  );
  const lines = bundle.artifacts.flatMap((artifact) => [
    `${artifact.name}@${artifact.version}${artifact.bundled.length > 0 ? `, with ${artifact.bundled.join(' and ')} inside` : ''}`,
    `  ${artifact.filePath}`,
    `  sha256 ${artifact.sha256}`,
    `  ${artifact.sbomPath}`,
  ]);
  const url = (fileName: string): string => `<release-asset-url>/${fileName}`;
  const setup = bundle.artifacts.filter((artifact) => artifact.name !== RUNNER_ROOT_PACKAGE);
  const runner = bundle.artifacts.find((artifact) => artifact.name === RUNNER_ROOT_PACKAGE);
  process.stderr.write(
    [
      ...lines,
      `${bundle.checksumsPath}`,
      ...heldBack.map((line) => `held back: ${line}`),
      '',
      'Once they are attached to a release, the whole setup is one sentence:',
      `  ${installSentence(setup.map((artifact) => url(artifact.fileName)))}`,
      ...(runner === undefined ? [] : ['', `  ${runnerSentence(url(runner.fileName))}`]),
      '',
    ].join('\n'),
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
