#!/usr/bin/env node
/**
 * `waterx-predict-keystore` — three subcommands, one key, two postures.
 *
 *   init   create the keystore (a fresh key, or one you paste in)
 *   agent  unlock a sealed keystore once and stay resident, holding it in memory
 *   sign   the per-request signer: SIGNER_PROTOCOL v1 on stdin/stdout
 *
 * ## Sealed (the default)
 *
 *   waterx-predict-keystore init
 *   waterx-predict-keystore agent            # asks for the passphrase, then stays
 *   export WATERX_PREDICT_SIGNER_COMMAND='["waterx-predict-keystore","sign"]'
 *
 * The operator runs `agent` once. Everything after that — the CLI, the Runner, a
 * trigger firing at 03:00 — runs `sign`, which holds nothing. `agent --detach`
 * starts that holder in the background instead of occupying a terminal, for a
 * host that has no second terminal to give it (ADR-0020).
 *
 * The passphrase is read from the terminal, or from a 0600 file named by
 * `WATERX_KEYSTORE_PASSPHRASE_FILE` for a machine that starts unattended. It is
 * never read from an environment variable: `ps eww` shows those to anyone on the
 * box, and a passphrase visible to `ps` is not a passphrase.
 *
 * ## Passphrase-less
 *
 *   waterx-predict-keystore init --no-passphrase
 *   export WATERX_PREDICT_SIGNER_COMMAND='["waterx-predict-keystore","sign"]'
 *
 * No passphrase, no resident agent: `sign` opens the 0600 file itself, signs and
 * exits. This is the perp agent's posture — a key in a file the local account
 * can read — and it exists because an unattended agent host can type nothing and
 * keep nothing running. It is never chosen for anyone: `--no-passphrase` has to
 * be typed, the file says what it is, and so does every surface that reports it.
 */
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { AGENT_PROTOCOL, createAgentServer, type HeldKey } from '../agent.ts';
import { askAgent } from '../client.ts';
import {
  isPlainKeystore,
  KeystoreError,
  openKeystore,
  PLAINTEXT_WARNING,
  plainKeystore,
  sealKeystore,
  type KeystoreFile,
} from '../keystore.ts';
import { parseRequest, sameAddress, SignerRefusal } from '../protocol.ts';

const flags = process.argv.slice(3);
const has = (flag: string): boolean => flags.includes(flag);
const valueOf = (flag: string): string | undefined => {
  const at = flags.indexOf(flag);
  return at === -1 ? undefined : flags[at + 1];
};

const die = (message: string): never => {
  process.stderr.write(`waterx-predict-keystore: ${message}\n`);
  process.exit(1);
};

const runtimeDir = (): string => {
  const named = process.env[AGENT_PROTOCOL.runtimeDirEnv];
  if (named !== undefined && named.trim() !== '') return named;
  const home = homedir();
  if (home === '') die('no home directory, and no WATERX_KEYSTORE_DIR');
  return [home, ...AGENT_PROTOCOL.defaultRuntimeDir].join('/');
};

const keystorePath = (): string => `${runtimeDir()}/keystore.json`;
/**
 * A `sun_path` is about 104 bytes on macOS and 108 on Linux, and exceeding it
 * fails as `EINVAL` from `listen` — a message that tells an operator nothing.
 * Refused here, with the number, so the fix is obvious: set WATERX_KEYSTORE_DIR
 * to something shorter.
 */
const SUN_PATH_MAX = 100;

const socketPath = (): string => {
  const path = `${runtimeDir()}/${AGENT_PROTOCOL.socketFile}`;
  if (Buffer.byteLength(path, 'utf8') > SUN_PATH_MAX) {
    die(
      `the socket path is ${String(Buffer.byteLength(path, 'utf8'))} bytes and the OS limit is about ${String(SUN_PATH_MAX)}: ${path}. Set ${AGENT_PROTOCOL.runtimeDirEnv} to a shorter directory.`,
    );
  }
  return path;
};
const tokenPath = (): string => `${runtimeDir()}/${AGENT_PROTOCOL.tokenFile}`;

/**
 * Refuses a directory another local account can reach, and creates it 0700 when
 * absent. Asserted rather than repaired — see `agent.ts`.
 */
const ensureRuntimeDir = (): string => {
  const dir = runtimeDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  const facts = statSync(dir);
  if (!facts.isDirectory()) die(`${dir} is not a directory`);
  if (facts.uid !== process.getuid?.()) die(`${dir} is not owned by this user`);
  if ((facts.mode & 0o077) !== 0) {
    die(`${dir} is reachable by other local accounts (mode ${(facts.mode & 0o777).toString(8)}); chmod 700 it`);
  }
  return dir;
};

const logPath = (): string => valueOf('--log') ?? `${runtimeDir()}/agent.log`;

/** Reads the whole of stdin. Used by `--import` and by a detached start. */
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const readKeystore = (): KeystoreFile => {
  const path = keystorePath();
  if (!existsSync(path)) die(`no keystore at ${path}. Run \`waterx-predict-keystore init\` first.`);
  return JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
};

const readPassphrase = async (prompt: string): Promise<string> => {
  // A detached child is handed its passphrase on stdin by the parent that read
  // it, because a background process has no terminal to ask.
  if (has('--passphrase-stdin')) return (await readStdin()).replace(/\r?\n$/u, '');
  const file = process.env['WATERX_KEYSTORE_PASSPHRASE_FILE'];
  if (file !== undefined && file !== '') {
    const facts = statSync(file);
    if ((facts.mode & 0o077) !== 0) die(`${file} is readable by other local accounts; chmod 600 it`);
    return readFileSync(file, 'utf8').replace(/\r?\n$/u, '');
  }
  if (!process.stdin.isTTY) {
    die('no terminal to read a passphrase from. Set WATERX_KEYSTORE_PASSPHRASE_FILE to a 0600 file.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
};

const loadKey = async (secretKey: Uint8Array): Promise<HeldKey> => {
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const pair = Ed25519Keypair.fromSecretKey(secretKey);
  return {
    address: pair.getPublicKey().toSuiAddress(),
    signPersonalMessage: async (message) => await pair.signPersonalMessage(message),
    signTransaction: async (bytes) => await pair.signTransaction(bytes),
  };
};

/**
 * Creates the keystore.
 *
 * A NEW key by default, because that is the safe answer and the common one: the
 * wallet this holds should be a delegated agent, not the account owner. Pass
 * `--import` to seal a key you already have, read from stdin so it never appears
 * in `ps` or a shell history.
 *
 * The passphrase is asked for separately, and — unlike the key — may come from
 * the passphrase file, because a machine that starts unattended has to get it
 * from somewhere. `--no-passphrase` writes the key in plaintext instead; see the
 * header, and the warning that writing one prints.
 */
const init = async (): Promise<void> => {
  const dir = ensureRuntimeDir();
  const path = keystorePath();
  if (existsSync(path)) die(`${path} already exists; move it aside first`);
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');

  let pair: InstanceType<typeof Ed25519Keypair>;
  if (process.argv.includes('--import')) {
    const supplied = (await readStdin()).trim();
    if (supplied === '') die('nothing on stdin to import; expected a suiprivkey… secret key');
    pair = Ed25519Keypair.fromSecretKey(supplied);
  } else {
    pair = new Ed25519Keypair();
  }

  // `getSecretKey()` is the bech32 form; the file holds the raw 32 bytes, so a
  // future provider can load it without this SDK's encoding.
  const { secretKey } = decodeSuiPrivateKey(pair.getSecretKey());
  const address = pair.getPublicKey().toSuiAddress();

  let file: KeystoreFile;
  if (has('--no-passphrase')) {
    file = plainKeystore({ secretKey, address });
    // On stderr, so a person reads it and whatever is parsing the JSON on stdout
    // cannot swallow it.
    process.stderr.write(`waterx-predict-keystore: ${PLAINTEXT_WARNING}\n`);
    process.stderr.write(
      "waterx-predict-keystore: fund it as a delegated agent wallet only; the owner's account belongs in a wallet this file cannot reach. Run `init` without --no-passphrase for a passphrase and a resident agent.\n",
    );
  } else {
    const passphrase = await readPassphrase('Passphrase for the keystore: ');
    if (!process.stdin.isTTY || process.env['WATERX_KEYSTORE_PASSPHRASE_FILE'] !== undefined) {
      // No confirmation prompt when it came from a file: asking twice for the same
      // file is theatre, and a second TTY read after a piped import would hang.
    } else {
      const again = await readPassphrase('Again: ');
      if (passphrase !== again) die('the two passphrases did not match');
    }
    file = sealKeystore({ secretKey, address, passphrase });
  }

  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  // The address, and only the address. The key is what the file is for.
  process.stdout.write(
    `${JSON.stringify({
      keystore: path,
      address: file.address,
      dir,
      protection: isPlainKeystore(file) ? 'NONE' : 'SCRYPT_AES_GCM',
      needsAgent: !isPlainKeystore(file),
    })}\n`,
  );
};

/**
 * Starts the holder in the background and returns.
 *
 * The passphrase is read HERE, by the process that still has a terminal, and
 * handed to the child on a pipe — never through `ps`, never through a file the
 * child has to find. The parent then waits for the socket to answer, so a
 * failure to unlock is a failure of this command rather than a line in a log
 * nobody reads.
 */
const detach = async (): Promise<void> => {
  ensureRuntimeDir();
  const file = readKeystore();
  const passphrase = isPlainKeystore(file) ? '' : await readPassphrase('Passphrase: ');
  const log = logPath();
  const logFd = openSync(log, 'a', 0o600);
  const child = spawn(
    process.execPath,
    [process.argv[1] as string, 'agent', '--passphrase-stdin'],
    { detached: true, stdio: ['pipe', 'ignore', logFd], env: process.env },
  );
  child.stdin?.end(`${passphrase}\n`);
  child.unref();

  const socket = socketPath();
  const deadline = Date.now() + 20_000;
  for (;;) {
    // A probe, not a stat: a socket file exists the instant `listen` returns,
    // and what the caller needs to know is that a key is behind it.
    if (existsSync(socket)) {
      try {
        await askAgent({
          socketPath: socket,
          token: 'probe',
          request: { version: 1, type: 'PERSONAL_MESSAGE', agentWallet: '0x0', messageBase64: 'AA==' },
          timeoutMs: 1_000,
        });
      } catch (error) {
        // UNAUTHENTICATED is the right answer to a probe with no token: it means
        // an agent is listening and checked us.
        if (error instanceof Error && error.message.includes('UNAUTHENTICATED')) break;
      }
    }
    if (Date.now() > deadline) {
      die(`the agent did not come up within 20s; see ${log}`);
    }
    if (child.exitCode !== null) die(`the agent exited with code ${String(child.exitCode)}; see ${log}`);
    await sleep(250);
  }
  process.stdout.write(
    `${JSON.stringify({ pid: child.pid, socket, log, address: file.address, detached: true })}\n`,
  );
};

const agent = async (): Promise<void> => {
  if (has('--detach')) return await detach();
  ensureRuntimeDir();
  const file = readKeystore();
  if (isPlainKeystore(file)) {
    die(
      'this keystore has no passphrase, so nothing needs to hold it unlocked: `sign` opens it directly. Do not run an agent for it.',
    );
  }
  const passphrase = await readPassphrase('Passphrase: ');
  const key = await loadKey(openKeystore(file, passphrase));

  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath(), `${token}\n`, { mode: 0o600 });
  const socket = socketPath();
  // A socket a dead agent left behind is taken over; a live one is not, because
  // two agents on one path is two keys nobody can tell apart.
  if (existsSync(socket)) {
    try {
      await askAgent({ socketPath: socket, token: 'probe', request: { version: 1, type: 'PERSONAL_MESSAGE', agentWallet: '0x0', messageBase64: 'AA==' }, timeoutMs: 1_000 });
      die(`an agent is already listening at ${socket}`);
    } catch {
      unlinkSync(socket);
    }
  }
  const server = createAgentServer({
    key,
    token,
    onEvent: (event) => process.stderr.write(`${event}\n`),
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  chmodSync(socket, 0o600);
  process.stderr.write(`holding ${key.address}; listening at ${socket}\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close();
      try {
        unlinkSync(socket);
      } catch {
        /* already gone */
      }
      process.exit(0);
    });
  }
};

/**
 * Signs one request.
 *
 * Two paths, decided by the file rather than by a flag: a sealed keystore is
 * held by the agent and reached over the socket, and a passphrase-less one is
 * opened here, used, and dropped when this process exits. The address check is
 * the same in both — a key that is not the address named in the request signs
 * nothing, whichever path got to it.
 */
const sign = async (): Promise<void> => {
  const request = parseRequest((await readStdin()).trim());
  const path = keystorePath();
  const file = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile) : undefined;

  if (file !== undefined && isPlainKeystore(file)) {
    const key = await loadKey(openKeystore(file, ''));
    if (!sameAddress(request.agentWallet, key.address)) {
      die(`this keystore holds ${key.address}, and the request asked ${request.agentWallet} to sign`);
    }
    const signed =
      request.type === 'PERSONAL_MESSAGE'
        ? await key.signPersonalMessage(Buffer.from(request.messageBase64, 'base64'))
        : await key.signTransaction(Buffer.from(request.transactionBytesBase64, 'base64'));
    process.stdout.write(`${JSON.stringify({ signature: signed.signature })}\n`);
    return;
  }

  if (!existsSync(tokenPath())) {
    die(
      `no agent is holding this keystore: ${tokenPath()} is not there. Start one with \`waterx-predict-keystore agent --detach\`.`,
    );
  }
  const token = readFileSync(tokenPath(), 'utf8').trim();
  const signature = await askAgent({ socketPath: socketPath(), token, request });
  process.stdout.write(`${JSON.stringify({ signature })}\n`);
};

const [subcommand] = process.argv.slice(2);
try {
  if (subcommand === 'init') await init();
  else if (subcommand === 'agent') await agent();
  else if (subcommand === 'sign') await sign();
  else die(`unknown subcommand ${String(subcommand)}; expected init, agent or sign`);
  // Only a resident agent keeps this process alive; `--detach` left one behind.
  if (subcommand !== 'agent' || has('--detach')) process.exit(0);
} catch (error) {
  const known = error instanceof KeystoreError || error instanceof SignerRefusal || error instanceof Error;
  die(known ? (error as Error).message : String(error));
}
