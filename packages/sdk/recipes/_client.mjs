/**
 * The four lines every other recipe would otherwise repeat, plus the three
 * things a script that moves money has to get right before it does anything.
 *
 * In the session these recipes were written after, an agent produced eight
 * throwaway scripts to answer eight questions, and all eight opened with the
 * same preamble: read the key, build a keypair, construct the client,
 * authenticate. That preamble is not where anyone should be improvising.
 *
 * WHY THE ARGUMENT PARSING IS STRICT. A script that quietly drops an option it
 * does not recognise will accept `--dry-run` and then place a real order. So an
 * unknown or misspelled option is refused before anything is read, let alone
 * sent. Fail closed is not a style preference here; it is the difference
 * between a typo and a trade.
 *
 * WHY THE KEY FILE IS CHECKED, AND CHECKED ON A DESCRIPTOR. This is the one
 * recipe that loads a raw private key off disk, which the signer interface
 * exists so that a caller need not do. A key anyone else on the machine can
 * read is already compromised, and a key reached through a symlink is a key
 * somebody else chose for you. Both are refused rather than warned about.
 *
 * Checking the PATH and then reading the PATH is a race, and not a tight one:
 * an `await import()` sits between them, so the gap is however long a module
 * takes to load. Whatever passed the check can be replaced before the read. So
 * the file is opened ONCE with `O_NOFOLLOW` — a symlink fails the open itself
 * rather than being followed — validated with `fstat` on that descriptor, and
 * read from that same descriptor. Nothing re-resolves the name.
 *
 * What that does not cover is a symlinked DIRECTORY on the way to the file;
 * closing that needs `openat` and a walk, which is more machinery than a
 * recipe should carry. Keep the key in a directory you own.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

import { PredictAgentClient, createFileIntentStore } from '@waterx/predict-agent-sdk';

/** Where a caller can put a key file. There is no default location and no search. */
export const KEY_FILE = process.env.WATERX_PREDICT_KEY_FILE ?? './agent.key';

/** testnet is practice money. There is no default; naming it is deliberate. */
export const DEPLOYMENT = process.env.WATERX_PREDICT_ENVIRONMENT ?? 'testnet';

/** The durable ledger of what this project has written. See `reconcile.mjs`. */
export const INTENT_LEDGER = process.env.WATERX_PREDICT_INTENTS ?? '.waterx/intents.json';

export const out = (text) => {
  process.stderr.write(`${text}\n`);
};

/* ── Output ───────────────────────────────────────────────────────────────── */

const wantsJson = process.argv.includes('--json');

/**
 * ONE document on stdout, whatever happens.
 *
 * The guard is here because the mistake is easy and silent: emit the result,
 * then emit an error on the way out, and stdout now holds two objects. Nothing
 * complains — `JSON.parse` on the pair just fails somewhere downstream, in
 * whatever is consuming it. A second write is diverted to stderr with a marker
 * instead, so stdout stays parseable and the bug is visible where a person will
 * see it.
 */
let written = false;

const write = (document) => {
  if (!wantsJson) return;
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (written) {
    process.stderr.write(`[recipe bug: a second stdout document was suppressed]\n${text}`);
    return;
  }
  written = true;
  process.stdout.write(text);
};

/** The success document. One JSON object on stdout, human lines on stderr. */
export const emit = (value) => {
  write({ ok: true, ...value });
};

/**
 * The failure document, in the same place and the same shape.
 *
 * A caller parsing stdout must not have to tell "this failed" apart from "this
 * produced nothing" — those are different facts and only one of them is safe to
 * retry. EVERY handled exit goes through here, including the ones that happen
 * before anything is read: a refused option is a failure a caller has to see.
 */
export const emitError = (code, detail = {}) => {
  write({ ok: false, error: { code, ...detail } });
};

/**
 * Anything that gets out of a recipe still leaves a document behind.
 *
 * The `--json` contract is that stdout says what happened, and an unexpected
 * throw is a thing that happened. Without this, a malformed ledger or any other
 * unhandled failure exits with stdout empty, which is exactly the "failed"
 * versus "produced nothing" ambiguity the contract exists to remove — and the
 * caller cannot tell whether it is safe to retry.
 *
 * 70 is `EX_SOFTWARE`: this is a fault, not one of the outcomes the exit codes
 * in the README enumerate.
 */
const onFatal = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  out(`Unexpected failure: ${message}`);
  emitError('UNEXPECTED', { message });
  process.exit(70);
};

process.on('uncaughtException', onFatal);
process.on('unhandledRejection', onFatal);

/* ── Arguments ────────────────────────────────────────────────────────────── */

/**
 * Parse `process.argv`, refusing anything not declared.
 *
 * `known` maps an option to `'boolean'` or `'value'`. Everything that does not
 * start with `-` is a positional, in order.
 */
export function parseArgv(known = {}) {
  const spec = { '--json': 'boolean', ...known };
  const argv = process.argv.slice(2);
  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const kind = spec[arg];
    if (kind === undefined) {
      out(`Unknown option ${arg}.`);
      out(`This recipe accepts: ${Object.keys(spec).join(' ')}`);
      out('Refused rather than ignored — a dropped option on a script that places');
      out('orders is a real trade nobody asked for.');
      emitError('UNKNOWN_OPTION', { option: arg, accepts: Object.keys(spec) });
      process.exit(2);
    }
    if (kind === 'boolean') {
      options[arg] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      out(`${arg} needs a value.`);
      emitError('MISSING_OPTION_VALUE', { option: arg });
      process.exit(2);
    }
    options[arg] = value;
    index += 1;
  }
  return { positionals, options };
}

/* ── The key ──────────────────────────────────────────────────────────────── */

const refuse = (reason, fix) => {
  const error = new Error(`${KEY_FILE}: ${reason}`);
  error.fix = fix;
  throw error;
};

/**
 * Open the key file once, validate THAT descriptor, and read from it.
 *
 * One `open`, one `fstat`, one read — the name is never resolved twice, so
 * there is no window in which what was checked stops being what is read.
 * `O_NOFOLLOW` makes a symlink fail the open itself; on Windows the flag and the
 * mode bits both mean nothing, and this runtime does not verify Windows anyway
 * (ADR-0002), so those checks apply where they apply.
 */
function readKeySecret() {
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = openSync(KEY_FILE, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === 'ELOOP') {
      refuse(
        'is a symlink',
        'Pass the real path. A key reached through a link is a key somebody else can redirect.',
      );
    }
    if (error.code === 'ENOENT') {
      refuse(
        'no such file',
        `Point WATERX_PREDICT_KEY_FILE at the agent's key, or generate one. It must be the AGENT's wallet, never the account owner's.`,
      );
    }
    throw error;
  }

  try {
    const stats = fstatSync(handle);
    if (!stats.isFile()) {
      refuse('is not a regular file', 'Pass the path of the key file itself.');
    }
    if (process.platform !== 'win32') {
      const uid = process.getuid?.();
      if (uid !== undefined && stats.uid !== uid) {
        refuse(
          `is owned by uid ${String(stats.uid)}, not by you (${String(uid)})`,
          'Do not read a key another account controls; it can be replaced under you.',
        );
      }
      if ((stats.mode & 0o077) !== 0) {
        refuse(
          `is readable by others (mode ${(stats.mode & 0o777).toString(8)})`,
          `chmod 600 ${KEY_FILE}`,
        );
      }
    }
    // From the descriptor that was just checked, not from the name again.
    return readFileSync(handle, 'utf8').trim();
  } finally {
    closeSync(handle);
  }
}

async function loadKeypair() {
  // Read FIRST, so the validated bytes are already in hand before the dynamic
  // import below opens a window in which the path could change under us.
  const secret = readKeySecret();
  let Ed25519Keypair;
  try {
    ({ Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519'));
  } catch (error) {
    const failure = new Error(
      "These recipes load a key with `@mysten/sui`, which is your dependency rather than this package's.",
    );
    failure.fix = 'npm install @mysten/sui — or implement AgentSigner over your own KMS and skip this file entirely.';
    failure.cause = error;
    throw failure;
  }
  return Ed25519Keypair.fromSecretKey(secret);
}

/**
 * An authenticated client, with the durable intent store already attached.
 *
 * The store is on by default here on purpose: a recipe that places an order
 * without one is a recipe whose idempotency dies with the process, and that is
 * the exact gap these recipes exist to stop each caller from reinventing.
 */
export async function connect({ authenticate = true } = {}) {
  let signer;
  try {
    signer = await loadKeypair();
  } catch (error) {
    out(`Refusing to load a signer: ${error.message}`);
    if (error.fix !== undefined) out(`  ${error.fix}`);
    emitError('SIGNER_REFUSED', { message: error.message, fix: error.fix });
    process.exit(2);
  }
  const client = new PredictAgentClient({
    deployment: DEPLOYMENT,
    signer,
    intentStore: createFileIntentStore(INTENT_LEDGER),
  });
  if (authenticate) await client.authenticate();
  return client;
}
