/**
 * The four lines every other recipe would otherwise repeat.
 *
 * In the session these recipes were written after, an agent produced eight
 * throwaway scripts to answer eight questions, and all eight opened with the
 * same preamble: read the key, build a keypair, construct the client,
 * authenticate. That preamble is not where anyone should be improvising, and it
 * is not what any of those scripts was actually about.
 *
 * `@mysten/sui` is YOUR dependency, not this package's. The SDK takes a signer
 * structurally, so a Sui `Keypair` satisfies it with no adapter — and a caller
 * holding their key in a KMS implements the same two methods without this
 * import existing at all.
 */
import { readFileSync } from 'node:fs';

import { PredictAgentClient, createFileIntentStore } from '@waterx/predict-agent-sdk';

/** Where a caller can put a key file. There is no default location and no search. */
export const KEY_FILE = process.env.WATERX_PREDICT_KEY_FILE ?? './agent.key';

/** testnet is practice money. There is no default; naming it is deliberate. */
export const DEPLOYMENT = process.env.WATERX_PREDICT_ENVIRONMENT ?? 'testnet';

/** The durable ledger of what this project has written. See `reconcile.mjs`. */
export const INTENT_LEDGER = process.env.WATERX_PREDICT_INTENTS ?? '.waterx/intents.json';

async function loadKeypair() {
  let Ed25519Keypair;
  try {
    ({ Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519'));
  } catch (error) {
    throw new Error(
      'These recipes load a key with `@mysten/sui`, which is your dependency rather than this package\'s: `npm install @mysten/sui`. Any signer with signTransaction, signPersonalMessage and toSuiAddress works instead — see the SDK README on where the key lives.',
      { cause: error },
    );
  }
  let secret;
  try {
    secret = readFileSync(KEY_FILE, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `No key at ${KEY_FILE}. Point WATERX_PREDICT_KEY_FILE at one, or read the SDK README on generating an agent wallet — this file is the agent's identity and must never be the account owner's key.`,
      { cause: error },
    );
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
  const signer = await loadKeypair();
  const client = new PredictAgentClient({
    deployment: DEPLOYMENT,
    signer,
    intentStore: createFileIntentStore(INTENT_LEDGER),
  });
  if (authenticate) await client.authenticate();
  return client;
}

/** JSON on stdout when asked for, human lines on stderr — the CLI's discipline. */
export const wantsJson = process.argv.includes('--json');

export const out = (text) => {
  process.stderr.write(`${text}\n`);
};

export const emit = (value) => {
  if (wantsJson) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
