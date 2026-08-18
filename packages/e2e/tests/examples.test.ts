/**
 * The shipped examples, checked two ways.
 *
 * Statically: every `waterx-predict …` invocation in every example and in this
 * package's README is linted against the real command contract. A documented
 * command that does not run is the defect this whole package started from.
 *
 * Dynamically: each example is EXECUTED with nothing provisioned. What that
 * proves is narrow and worth having — the script refuses with an explanation
 * rather than a stack trace, and reaches no write. It does not prove the happy
 * path, and nothing here should be read as though it did.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateCliBinary } from '../src/cli-process.ts';
import { extractInvocations, lintInvocation } from '../src/lint.ts';

const PACKAGE_DIR = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const EXAMPLES_DIR = join(PACKAGE_DIR, 'examples');

const EXAMPLES = readdirSync(EXAMPLES_DIR)
  .filter((name) => name.endsWith('.sh') && !name.startsWith('_'))
  .sort();

/** The one example that is not a shell script, and not in this package. */
const WATCH_EXAMPLE = join(PACKAGE_DIR, '../sdk/examples/watch-quotes.mjs');

const read = (path: string): string => readFileSync(path, 'utf8');

describe('the shipped examples', () => {
  it('ships every path the north star needs, and nothing undocumented', () => {
    expect(EXAMPLES).toEqual([
      'delegation-revocation.sh',
      'multi-leg-entry.sh',
      'north-star-bot.sh',
      'one-shot-entry.sh',
      'reconciliation.sh',
      'restart-recovery.sh',
      'slippage-rejection.sh',
      'target-exit.sh',
    ]);
  });

  // The stream example lives with the package that implements the stream, and
  // is executed from here for the same reason as the others. It is a library
  // example because there is no CLI command for a subscription: a command that
  // answers once is the wrong shape for something that lives as long as the
  // process holding it.
  it('keeps the stream example with the SDK, not here', () => {
    expect(EXAMPLES.some((name) => name.includes('watch'))).toBe(false);
    expect(readFileSync(WATCH_EXAMPLE, 'utf8')).toContain('streamTriggerPrice');
  });

  // The READMEs tell a reader to run `./target-exit.sh`. A file committed
  // without its executable bit answers that with "permission denied", which
  // reads as a broken example rather than a missing chmod.
  it('ships every example executable, as its documentation says to run it', () => {
    for (const path of [...EXAMPLES.map((name) => join(EXAMPLES_DIR, name)), WATCH_EXAMPLE]) {
      expect(statSync(path).mode & 0o100, path).toBe(0o100);
    }
  });

  it('is syntactically valid shell', () => {
    for (const name of [...EXAMPLES, '_lib.sh']) {
      expect(() => execFileSync('bash', ['-n', join(EXAMPLES_DIR, name)]), name).not.toThrow();
    }
  });

  it.each([...EXAMPLES, '_lib.sh'])('%s runs only commands the CLI accepts', (name) => {
    const invocations = extractInvocations(read(join(EXAMPLES_DIR, name)));
    for (const argv of invocations) {
      const violations = lintInvocation(argv);
      expect(violations.map((violation) => violation.message), argv.join(' ')).toEqual([]);
    }
  });

  it('actually finds invocations to check, rather than passing on an empty list', () => {
    // A linter over nothing passes forever. This is the test that notices the
    // extractor silently stopped matching.
    const total = [...EXAMPLES, '_lib.sh'].reduce(
      (count, name) => count + extractInvocations(read(join(EXAMPLES_DIR, name))).length,
      0,
    );
    expect(total).toBeGreaterThan(15);
  });

  // The CLI's own README is included, and is the one that matters most: it is
  // where an operator copies a command from, and a documented flag that is not a
  // field exits USAGE at the worst possible moment. That is the defect this
  // linter was written for.
  it.each([
    ['the harness README', join(PACKAGE_DIR, 'README.md')],
    ['the CLI README', join(PACKAGE_DIR, '../cli/README.md')],
  ])('checks %s the same way', (_label, path) => {
    const invocations = extractInvocations(read(path));
    expect(invocations.length).toBeGreaterThan(0);
    for (const argv of invocations) {
      expect(lintInvocation(argv).map((v) => v.message), argv.join(' ')).toEqual([]);
    }
  });

  it('never hard-codes a mainnet or production environment label', () => {
    for (const name of [...EXAMPLES, '_lib.sh']) {
      const source = read(join(EXAMPLES_DIR, name));
      expect(source, name).not.toMatch(/WATERX_PREDICT_ENVIRONMENT=\s*(mainnet|production|prod)\b/u);
      expect(source, name).not.toMatch(/https:\/\/[^\s"']*\bmainnet\b/u);
    }
  });

  it('never prints a token, signature or key', () => {
    // The approval token is carried between commands and must not be echoed:
    // it is not a secret, but printing it teaches the habit, and the same lines
    // would carry a real one later.
    for (const name of [...EXAMPLES, '_lib.sh']) {
      const source = read(join(EXAMPLES_DIR, name));
      expect(source, name).not.toMatch(/say .*\$APPROVAL/u);
      expect(source, name).not.toMatch(/privateKey|PRIVATE_KEY|--key\b/u);
    }
    const watch = readFileSync(WATCH_EXAMPLE, 'utf8');
    expect(watch).not.toMatch(/privateKey|PRIVATE_KEY/u);
    // The stream example signs a login challenge and must never print what came
    // back, nor be able to sign anything that moves funds.
    expect(watch).not.toMatch(/say\(.*signature/u);
    expect(watch).toContain('never signs a transaction');
  });

  it('checks the invocations documented in the stream example too', () => {
    for (const argv of extractInvocations(readFileSync(WATCH_EXAMPLE, 'utf8'))) {
      expect(lintInvocation(argv).map((v) => v.message), argv.join(' ')).toEqual([]);
    }
  });

  it('points at the stream example from the bot that would want it', () => {
    // A composed example that names a file which does not exist is worse than
    // one that names nothing: the reader assumes the mistake is theirs.
    const bot = read(join(EXAMPLES_DIR, 'north-star-bot.sh'));
    expect(bot).toContain('../../sdk/examples/watch-quotes.mjs');
    expect(existsSync(join(EXAMPLES_DIR, '../../sdk/examples/watch-quotes.mjs'))).toBe(true);
  });
});

describe('an example with nothing provisioned', () => {
  const located = locateCliBinary();

  // Not `it.skip`: an example suite that quietly stopped running would look
  // exactly like one that passed. If the CLI is not built, that is a real
  // failure of this repository's own build, and it should say so.
  it('has a built CLI to run against', () => {
    expect(located.found ? '' : `${located.reason} ${located.fix}`).toBe('');
  });

  it.each(EXAMPLES)('%s refuses with an explanation and places no order', (name) => {
    if (!located.found) throw new Error('the CLI is not built');

    const result = spawnSync('bash', [join(EXAMPLES_DIR, name)], {
      encoding: 'utf8',
      // The environment is REPLACED, so the developer's own configuration cannot
      // make this pass. HOME points nowhere, so no config file is found either.
      env: {
        // The examples invoke `waterx-predict` by name, exactly as their own
        // header tells a reader to. `.bin` is where an install puts it.
        PATH: `${join(PACKAGE_DIR, 'node_modules', '.bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: join(PACKAGE_DIR, 'node_modules', '.no-such-home'),
      },
      timeout: 30_000,
    });

    // 3 is CONFIG: "you have not configured this", which is the correct answer.
    expect(result.status, `${name}: ${result.stderr}`).toBe(3);
    expect(result.stderr).toContain('NOT PROVISIONED');
    // It must name a supplier rather than leaving the reader to guess.
    expect(result.stderr).toMatch(/OPERATOR|ACCOUNT OWNER/u);
    // Nothing crashed on the way there.
    expect(result.stderr).not.toContain('Traceback');
    expect(result.stderr).not.toMatch(/^\s*at .*\(/mu);
  });

  // Same standard for the stream example, which cannot use the CLI at all: it
  // must refuse before it opens a socket, and say who supplies what.
  it('the stream example refuses before it connects', () => {
    const result = spawnSync('node', [WATCH_EXAMPLE, '--marketId', 'mkt_example', '--seconds', '1'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain('NOT PROVISIONED');
    expect(result.stderr).toMatch(/OPERATOR|ACCOUNT OWNER/u);
    expect(result.stderr).not.toMatch(/^\s*at .*\(/mu);
    // It got nowhere near a connection, so it printed no frame and no summary.
    expect(result.stderr).not.toContain('Watching');
  });
});
