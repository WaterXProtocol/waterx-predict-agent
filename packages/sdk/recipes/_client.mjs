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
 * WHY THE KEY FILE IS CHECKED. This is the one recipe that loads a raw private
 * key off disk, which the signer interface exists so that a caller need not do.
 * A key anyone else on the machine can read is already compromised, and a key
 * reached through a symlink is a key somebody else chose for you. Both are
 * refused rather than warned about — the keystore signer holds the same line,
 * and a raw-key path that is laxer than the guarded one teaches the wrong habit.
 */
import { lstatSync, readFileSync } from 'node:fs';

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
      process.exit(2);
    }
    if (kind === 'boolean') {
      options[arg] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      out(`${arg} needs a value.`);
      process.exit(2);
    }
    options[arg] = value;
    index += 1;
  }
  return { positionals, options };
}

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
 * retry. Every handled exit below goes through here.
 */
export const emitError = (code, detail = {}) => {
  write({ ok: false, error: { code, ...detail } });
};

/* ── The key ──────────────────────────────────────────────────────────────── */

const refuse = (reason, fix) => {
  const error = new Error(`${KEY_FILE}: ${reason}`);
  error.fix = fix;
  throw error;
};

/**
 * Refuse a key file this process should not be reading.
 *
 * `lstat`, not `stat`, so a symlink is seen as a symlink rather than followed to
 * whatever it points at. Mode and ownership are meaningless on Windows, which
 * this runtime does not verify anyway (ADR-0002), so they are checked where they
 * mean something.
 */
function checkKeyFile() {
  let stats;
  try {
    stats = lstatSync(KEY_FILE);
  } catch (error) {
    refuse(
      'no such file',
      `Point WATERX_PREDICT_KEY_FILE at the agent's key, or generate one. It must be the AGENT's wallet, never the account owner's.`,
    );
    throw error;
  }

  if (stats.isSymbolicLink()) {
    refuse(
      'is a symlink',
      'Pass the real path. A key reached through a link is a key somebody else can redirect.',
    );
  }
  if (!stats.isFile()) {
    refuse('is not a regular file', 'Pass the path of the key file itself.');
  }
  if (process.platform === 'win32') return;

  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    refuse(
      `is owned by uid ${String(stats.uid)}, not by you (${String(uid)})`,
      'Do not read a key another account controls; it can be replaced under you.',
    );
  }
  // eslint-disable-next-line no-bitwise
  const group_and_other = stats.mode & 0o077;
  if (group_and_other !== 0) {
    refuse(
      `is readable by others (mode ${(stats.mode & 0o777).toString(8)})`,
      `chmod 600 ${KEY_FILE}`,
    );
  }
}

async function loadKeypair() {
  checkKeyFile();
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
  return Ed25519Keypair.fromSecretKey(readFileSync(KEY_FILE, 'utf8').trim());
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
