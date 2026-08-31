/**
 * Emit (or verify) the committed copies of the command document.
 *
 *   node dist/src/generate.js <output-path>... [--check]
 *
 * Two destinations: `schemas/v1/agent-commands.json` at the repository root,
 * and `agent-commands.json` inside this package, which is what `files` ships.
 * The second is the one that matters to a consumer — a contract published as
 * plain JSON so a surface that cannot import a Node module can still read it is
 * not published at all while it lives only in a git repository.
 *
 * `--check` writes nothing and exits non-zero when the committed artifact has
 * drifted from the source. The same comparison runs as a test, so CI catches
 * drift without this script; the flag exists for a local pre-commit hook.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildCommandDocument, serializeCommandDocument } from './document.ts';

function main(argv: readonly string[]): number {
  const args = argv.filter((arg) => arg !== '--check');
  const check = argv.includes('--check');
  if (args.length === 0) {
    process.stderr.write('usage: generate <output-path>... [--check]\n');
    return 2;
  }

  let worst = 0;
  for (const target of args) worst = Math.max(worst, emit(resolve(process.cwd(), target), check));
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
function emit(outputPath: string, check: boolean): number {
  const contents = serializeCommandDocument(buildCommandDocument());

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
