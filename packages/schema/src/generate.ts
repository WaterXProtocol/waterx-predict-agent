/**
 * Emit (or verify) the committed `schemas/v1/agent-commands.json`.
 *
 *   node dist/src/generate.js <output-path>
 *   node dist/src/generate.js <output-path> --check
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
  const target = args[0];
  if (target === undefined) {
    process.stderr.write('usage: generate <output-path> [--check]\n');
    return 2;
  }

  const outputPath = resolve(process.cwd(), target);
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
