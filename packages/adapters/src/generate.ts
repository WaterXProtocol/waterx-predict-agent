/**
 * Emit (or verify) the committed copies of the host-neutral instructions.
 *
 *   node dist/src/generate.js <output-path>... [--check]
 *
 * Two destinations each: one at the repository root, and one inside
 * `packages/sdk`, which is what that package's `files` ships. This package is
 * private and the SDK is the one an agent installs, so the SDK tarball is the
 * only path by which any of this reaches the population it was written for.
 *
 * `--skill` renders the skill instead — the trigger and the route a host loads
 * so that one sentence reaches this runtime. It is a different document with a
 * different job, and it is emitted by the same generator so that neither can be
 * regenerated without the other being regenerated too.
 *
 * Same arrangement as the command document: generated, committed, and compared
 * byte-for-byte by a test. The committed file is what a host that cannot run
 * this toolchain reads, so it has to be evidence rather than a copy someone
 * remembered to update.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { renderAgentInstructions } from './instructions.ts';
import { renderAgentSkill } from './skill.ts';

const FLAGS = new Set(['--check', '--skill']);

function main(argv: readonly string[]): number {
  const args = argv.filter((arg) => !FLAGS.has(arg));
  const check = argv.includes('--check');
  if (args.length === 0) {
    process.stderr.write('usage: generate <output-path>... [--skill] [--check]\n');
    return 2;
  }

  // Rendered once, written to every destination. Rendering per path would let
  // two copies of the same document differ if the renderer ever stopped being
  // pure, which is the exact failure the byte comparison exists to catch.
  const contents = argv.includes('--skill') ? renderAgentSkill() : renderAgentInstructions();

  let worst = 0;
  for (const target of args) {
    worst = Math.max(worst, emit(resolve(process.cwd(), target), contents, check));
  }
  return worst;
}

/**
 * One destination.
 *
 * More than one is not a convenience: the committed copy at the repository root
 * is what a reader of this repository sees, and the copy inside a published
 * package is what an agent that ran `npm install` sees. They are the same
 * document by construction here, rather than by somebody remembering.
 */
function emit(outputPath: string, contents: string, check: boolean): number {
  if (check) {
    let current: string;
    try {
      current = readFileSync(outputPath, 'utf8');
    } catch {
      process.stderr.write(`${outputPath} is missing; run the generator.\n`);
      return 1;
    }
    if (current !== contents) {
      process.stderr.write(`${outputPath} is stale; run the generator.\n`);
      return 1;
    }
    process.stderr.write(`${outputPath} is up to date.\n`);
    return 0;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents, 'utf8');
  process.stderr.write(`wrote ${outputPath}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
