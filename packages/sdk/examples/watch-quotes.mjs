#!/usr/bin/env node
/**
 * Watch one market over the quote stream, and say when a target WOULD fire.
 *
 * There is no CLI command for this on purpose: a stream is a subscription that
 * lives as long as the process holding it, and a command that answers once is
 * the wrong shape for it. This is the library surface, used the way the Runner's
 * own price observer uses it.
 *
 * WHAT IT DEMONSTRATES:
 *
 *   1. Every frame is INDICATIVE. Nothing here is an executable price, and no
 *      order is ever built on one: an order is built on `POST /quotes`, which
 *      this example never calls. A stream decides WHEN to ask for a price.
 *   2. A change-only feed cannot be judged by silence. A quiet market and a dead
 *      socket look identical by frame arrival alone, so the stream says
 *      UNAVAILABLE — GAP, DISCONNECTED, DEGRADED or a server refusal — and this
 *      script stops trusting its last price the moment it hears one.
 *   3. A trigger reads the side it would trade on: a BUY against the ask (what
 *      it would pay), a SELL against the bid (what it would receive). A STALE
 *      frame yields no trigger price at all rather than a remembered one.
 *   4. Recovery is a SNAPSHOT, not a replay. `seq` is per connection and per
 *      topic and means nothing off the connection that issued it, so there is no
 *      cursor to persist — the snapshot after a reconnect IS the recovery.
 *
 * WHAT IT CANNOT DO: sign a transaction. The signer below refuses outright, so
 * this process cannot place an order however it is used.
 *
 * Usage:
 *   node watch-quotes.mjs --marketId <id> [--outcomeId YES] [--side BUY]
 *                         [--target 0.80] [--seconds 60]
 *
 * Environment (the same variables the CLI reads):
 *   WATERX_PREDICT_BASE_URL        the API this watches
 *   WATERX_PREDICT_ENVIRONMENT     must be a non-production label
 *   WATERX_PREDICT_AGENT_WALLET    the address the session authenticates as
 *   WATERX_PREDICT_SIGNER_COMMAND  an executable that signs the login challenge
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_OK = 0;
const EXIT_CONFIG = 3;

const say = (line) => process.stderr.write(`${line}\n`);

/* ── arguments ───────────────────────────────────────────────────────────── */

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const next = process.argv[index + 1];
  args.set(token.slice(2), next === undefined || next.startsWith('--') ? 'true' : next);
}

const marketId = args.get('marketId');
const outcomeId = args.get('outcomeId') ?? 'YES';
const side = args.get('side') ?? 'BUY';
const target = args.get('target');
const seconds = Number(args.get('seconds') ?? '60');

if (marketId === undefined) {
  say('Usage: node watch-quotes.mjs --marketId <id> [--outcomeId YES] [--side BUY] [--target 0.80] [--seconds 60]');
  say('A market id is resolved by the SERVER — `waterx-predict market search` prints one. Never invent it.');
  process.exit(EXIT_CONFIG);
}
if (side !== 'BUY' && side !== 'SELL') {
  say(`--side is BUY or SELL, not ${side}. The side decides which half of the book a target is read against.`);
  process.exit(EXIT_CONFIG);
}

/* ── provisioning ────────────────────────────────────────────────────────── */

const baseUrl = process.env.WATERX_PREDICT_BASE_URL;
const environment = process.env.WATERX_PREDICT_ENVIRONMENT;
const agentWallet = process.env.WATERX_PREDICT_AGENT_WALLET;
const signerCommandRaw = process.env.WATERX_PREDICT_SIGNER_COMMAND;

const missing = [];
if (!baseUrl) missing.push(['WATERX_PREDICT_BASE_URL', 'OPERATOR', 'the API this connects to']);
if (!agentWallet)
  missing.push([
    'WATERX_PREDICT_AGENT_WALLET',
    'ACCOUNT OWNER',
    'the address the session authenticates as; the server checks the signature resolves to it',
  ]);
if (!signerCommandRaw)
  missing.push([
    'WATERX_PREDICT_SIGNER_COMMAND',
    'OPERATOR',
    'an executable that signs the login challenge; no key ever enters this process',
  ]);

if (missing.length > 0) {
  say('NOT PROVISIONED: this example cannot open an authenticated stream.');
  for (const [key, supplier, why] of missing) say(`  ${supplier} supplies ${key} — ${why}.`);
  process.exit(EXIT_CONFIG);
}

// An UNLABELLED deployment is treated as production, which is the point of an
// allowlist: a label nobody anticipated is refused rather than trusted. This
// example only reads prices, and it still refuses — the habit is the lesson.
const NON_PRODUCTION = new Set([
  'test',
  'testnet',
  'devnet',
  'localnet',
  'local',
  'staging',
  'sandbox',
]);
if (!environment || !NON_PRODUCTION.has(environment)) {
  say(
    environment
      ? `REFUSING: the environment is labelled "${environment}", which is not a known non-production one.`
      : 'REFUSING: no environment label is configured, so this deployment is treated as production.',
  );
  say('  OPERATOR supplies WATERX_PREDICT_ENVIRONMENT=testnet.');
  process.exit(EXIT_CONFIG);
}

/* ── the SDK, from this workspace's build ────────────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
let sdk;
try {
  sdk = await import(join(here, '..', 'dist', 'src', 'index.js'));
} catch {
  say('The SDK is not built. Run `pnpm build` at the workspace root and try again.');
  say('(An installed application imports "@waterx/predict-agent-sdk" instead of a path.)');
  process.exit(EXIT_CONFIG);
}
const { PredictAgentClient, streamTriggerPrice } = sdk;

/* ── the signer: a login challenge and nothing else ──────────────────────── */

// Same wire the CLI and the Runner speak, so one keystore command serves all
// three: a JSON request on stdin, `{"signature":"<base64>"}` on stdout. A bare
// string is an executable name; a JSON array is argv.
const signerCommand = signerCommandRaw.trim().startsWith('[')
  ? JSON.parse(signerCommandRaw)
  : [signerCommandRaw.trim()];

const runSigner = (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(signerCommand[0], signerCommand.slice(1), {
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: false,
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', (error) => reject(new Error(`the signer could not be started: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`the signer exited with status ${code}; its output was not used`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error('the signer did not write {"signature":"<base64>"} to stdout'));
        return;
      }
      // The signature itself is never printed. It is not secret, but a script
      // that echoes one teaches a habit that leaks the next thing.
      if (typeof parsed?.signature !== 'string' || parsed.signature === '') {
        reject(new Error('the signer returned JSON with no `signature` string'));
        return;
      }
      resolve(parsed.signature);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });

const signer = {
  toSuiAddress: () => agentWallet,
  signPersonalMessage: async (bytes) => {
    const messageBase64 = Buffer.from(bytes).toString('base64');
    const signature = await runSigner({
      version: 1,
      type: 'PERSONAL_MESSAGE',
      agentWallet,
      messageBase64,
    });
    return { signature, bytes: messageBase64 };
  },
  // Not "unimplemented": refused. A watcher that could sign a transaction is one
  // bug away from placing an order nobody asked for.
  signTransaction: async () => {
    throw new Error('this example watches prices and never signs a transaction');
  },
};

/* ── watch ───────────────────────────────────────────────────────────────── */

const client = new PredictAgentClient({ baseUrl, signer, quoteStream: 'native' });
const stream = client.quoteStream();

let frames = 0;
let unavailable = 0;
let lastTrigger = null;
let reached = false;

say(`Watching ${marketId} / ${outcomeId} on the ${side} side for ${seconds}s.`);
if (target !== undefined) say(`A ${side} would fire at ${target}. This example never places one.`);

const stop = (reason) => {
  say('');
  say(`Stopped: ${reason}.`);
  say(`Frames: ${frames}. Unavailable notices: ${unavailable}. Last trigger price: ${lastTrigger ?? 'none'}.`);
  if (target !== undefined) {
    say(reached ? `The target ${target} was reached at least once.` : `The target ${target} was not reached.`);
  }
  unsubscribe();
  client.close();
  process.exitCode = EXIT_OK;
};

const unsubscribe = stream.onQuote({ marketId, outcomeId }, (event) => {
  if (event.type === 'UNAVAILABLE') {
    unavailable += 1;
    lastTrigger = null;
    // Each reason means something different afterwards, and collapsing them is
    // how a strategy ends up trading on a price it can no longer see.
    const meaning = {
      GAP: 'frames were dropped; the next snapshot is the whole recovery',
      DISCONNECTED: 'the connection is gone; nothing cached survives it',
      DEGRADED: 'the stream gave up; prices now come from REST for this process',
      MARKET_CLOSED: 'terminal for this round — a strategy stops, it does not wait',
      NOT_QUOTABLE: 'temporary: no live book right now — a strategy pauses',
      RATE_LIMITED: 'the server refused the subscription rate',
      SUBSCRIPTION_LIMIT: 'too many topics on this connection',
      UNKNOWN_MARKET: 'the server does not know this market id',
      INVALID_REQUEST: 'the topic was not a valid one',
    };
    say(`UNAVAILABLE ${event.reason} — ${meaning[event.reason] ?? 'the feed cannot be proven live'}`);
    return;
  }

  frames += 1;
  const { frame } = event;
  const trigger = streamTriggerPrice(side, frame);
  lastTrigger = trigger;

  const age = frame.freshness.sourceAgeMs;
  say(
    `${frame.kind} seq=${frame.seq}${frame.gap ? ' GAP' : ''} bid=${frame.indicativeBid ?? '—'} ` +
      `ask=${frame.indicativeAsk ?? '—'} trigger=${trigger ?? 'none (stale)'} ` +
      `age=${age === null ? 'unknown' : `${age}ms`} flags=${frame.qualityFlags.join(',') || 'none'}`,
  );

  if (target !== undefined && trigger !== null && !reached) {
    // Compared as text, padded — a price is never turned into a float here.
    const pad = (value) => {
      const [whole, fraction = ''] = String(value).split('.');
      return whole.padStart(12, '0') + fraction.padEnd(12, '0');
    };
    const fires = side === 'BUY' ? pad(trigger) <= pad(target) : pad(trigger) >= pad(target);
    if (fires) {
      reached = true;
      say(`TARGET REACHED: ${trigger} ${side === 'BUY' ? '<=' : '>='} ${target}.`);
      say('A strategy would now mint a FRESH executable quote and re-check the target');
      say('before submitting. This indicative price is not what it would trade at.');
    }
  }
});

const timer = setTimeout(() => stop(`${seconds}s elapsed`), seconds * 1000);
process.on('SIGINT', () => {
  clearTimeout(timer);
  stop('interrupted');
});
