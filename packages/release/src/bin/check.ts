#!/usr/bin/env node
/**
 * `pnpm consumer:check` — pack, install into a throwaway project, and find out
 * whether what arrived is what the manifests promised.
 *
 *   node dist/src/bin/check.js [--keep]
 *
 * The gap this closes: every other check in this repository reads a manifest or
 * compares bytes in the working tree. None of them runs npm. So a `files` list
 * that omits the document the package exists to deliver passes typecheck,
 * passes the suite, passes the preflight, and fails for the first consumer.
 *
 * What is asserted is derived from each package's own `files` and `bin`, never
 * from a list written here — a list written here would be a second opinion
 * about what should ship, and two opinions disagreeing is the failure itself.
 *
 * A binary is spawned rather than trusted to exist. `Cannot find module` is the
 * shape a bad `files` list actually takes at runtime: the entry point ships, and
 * something it imports does not.
 *
 * This reaches the network — `npm install` fetches real dependencies — which is
 * why it is a command rather than a test.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { kitManifest, packPublished, verifyInstalled } from '../consumer.ts';
import { findRepoRoot } from '../workspace.ts';

/** Spawn a shipped binary and report what a missing file would look like. */
function runBinary(installRoot: string, binName: string): string | undefined {
  const executable = join(installRoot, 'node_modules', '.bin', binName);
  if (!existsSync(executable)) return `${binName}: npm linked no such binary`;

  const result = spawnSync(executable, [], { cwd: installRoot, encoding: 'utf8' });
  if (result.error !== undefined) return `${binName}: could not be spawned (${result.error.message})`;

  // The exit code is the package's own business — this one answers 3 when
  // nothing is configured, which is correct. What must not appear is a
  // resolution failure, because that is a shipped entry point importing
  // something `files` left behind.
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/u.test(output)) {
    return `${binName}: ran, but could not resolve its own imports — ${output.split('\n')[0] ?? ''}`;
  }
  return undefined;
}

function main(argv: readonly string[]): number {
  const keep = argv.includes('--keep');
  const staging = mkdtempSync(join(tmpdir(), 'waterx-check-'));
  const project = join(staging, 'consumer');

  try {
    const artifacts = packPublished(findRepoRoot(), staging);
    if (artifacts.length === 0) {
      process.stderr.write('nothing is publishable, so there is nothing to check.\n');
      return 1;
    }

    const vendor = join(project, 'vendor');
    mkdirSync(vendor, { recursive: true });
    for (const artifact of artifacts) cpSync(artifact.filePath, join(vendor, artifact.fileName));
    writeFileSync(
      join(project, 'package.json'),
      `${JSON.stringify(kitManifest(artifacts), null, 2)}\n`,
      'utf8',
    );

    process.stderr.write(`installing ${String(artifacts.length)} packed package(s)…\n`);
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: project, stdio: 'ignore' });

    const problems = [...verifyInstalled(project, artifacts, existsSync)];

    // What a consumer does first. A path check cannot see a `dist` that shipped
    // without a module something in it imports; a resolver can, and this is the
    // same resolver the consumer will use.
    for (const artifact of artifacts) {
      if (typeof artifact.manifest.main !== 'string') continue;
      const imported = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(artifact.name)});`],
        { cwd: project, encoding: 'utf8' },
      );
      if (imported.status !== 0) {
        const detail = (imported.stderr ?? '').split('\n').find((line) => line.trim() !== '') ?? '';
        problems.push(`${artifact.name}: could not be imported from the install — ${detail}`);
      }
    }
    for (const artifact of artifacts) {
      const bin = artifact.manifest.bin;
      const names =
        typeof bin === 'object' && bin !== null ? Object.keys(bin as Record<string, unknown>) : [];
      for (const name of names) {
        const problem = runBinary(project, name);
        if (problem !== undefined) problems.push(`${artifact.name}: ${problem}`);
      }
    }

    for (const artifact of artifacts) {
      process.stderr.write(`  ${artifact.name}@${artifact.version}\n`);
    }
    if (problems.length > 0) {
      process.stderr.write(`\n${String(problems.length)} problem(s):\n`);
      for (const problem of problems) process.stderr.write(`  ${problem}\n`);
      return 1;
    }

    process.stderr.write('\nEverything each manifest promised arrived, and every binary ran.\n');
    return 0;
  } finally {
    if (keep) process.stderr.write(`kept: ${project}\n`);
    else rmSync(staging, { recursive: true, force: true });
  }
}

process.exitCode = main(process.argv.slice(2));
