/**
 * What `next` can learn about the keystore signer on this machine, without
 * becoming a client of it.
 *
 * The keystore is the signer an operator installs beside this CLI (ADR-0012).
 * `next` has to be able to say which of its steps is still undone — installed,
 * initialised, agent started, wired in — or its hand-over is a paragraph of
 * generic advice an operator has to translate into commands. So it looks.
 *
 * It looks the way a person with `ls` would, and no further:
 *
 * - the binary is on PATH (under `npx`, `node_modules/.bin` is);
 * - `keystore.json` exists, and its `address` and `protection` fields — both
 *   public; the address is exactly the agent wallet an owner will grant — are
 *   read;
 * - something exists at the agent's socket path.
 *
 * It never imports the keystore package (the CLI must not carry the Sui SDK or
 * a key path), never reads anything but the address out of the file, and never
 * dials the socket: talking to the agent is `sign`'s job, spawned under the
 * signing gate. A socket that exists may belong to an agent that died, and that
 * is reported as `SOCKET_PRESENT` rather than as a running agent — the session
 * that follows is what proves it.
 *
 * `protection` is what decides whether an agent is part of the setup at all: a
 * passphrase-less keystore (ADR-0020) is opened by `sign` itself, so a hand-over
 * that told an operator to start an agent for one would be asking for a process
 * that refuses to start.
 *
 * The layout is a copy of the keystore's own `AGENT_PROTOCOL`, held equal to it
 * by `tests/workspace.test.ts`, the same way the Runner IPC copy is.
 */
import type { ResolvedConfig } from './config.ts';
import type { PathStat } from './runner-ipc.ts';

export const KEYSTORE_LAYOUT = {
  command: 'waterx-predict-keystore',
  runtimeDirEnv: 'WATERX_KEYSTORE_DIR',
  defaultRuntimeDir: ['.waterx', 'keystore'],
  socketFile: 'keystore.sock',
  keystoreFile: 'keystore.json',
} as const;

/** The signer command an operator sets to use it. Spelled once. */
export const KEYSTORE_SIGNER_COMMAND = `["${KEYSTORE_LAYOUT.command}","sign"]`;

export interface KeystoreProbe {
  /** Whether `waterx-predict-keystore` resolves on PATH. */
  readonly installed: boolean;
  /** Whether WATERX_PREDICT_SIGNER_COMMAND already points at it. */
  readonly configuredAsSigner: boolean;
  readonly dir: string;
  readonly keystore:
    | { readonly status: 'ABSENT' }
    | { readonly status: 'UNREADABLE' }
    | {
        readonly status: 'PRESENT';
        readonly address: string;
        /**
         * `NONE` means the key is at rest in plaintext and `sign` opens it
         * without an agent. Files written before the variant existed carry no
         * such field, and are all sealed.
         */
        readonly protection: 'SCRYPT_AES_GCM' | 'NONE';
      };
  /**
   * `SOCKET_PRESENT` is not proof of a live agent; see the module comment.
   * `NOT_NEEDED` is a passphrase-less keystore: there is nothing to run.
   */
  readonly agent: 'SOCKET_PRESENT' | 'NO_SOCKET' | 'NOT_NEEDED';
}

export interface KeystoreProbeSources {
  readonly env: Readonly<Record<string, string | undefined>>;
  homeDir(): string | null;
  readFile(path: string): string | null;
  readonly pathStat: PathStat;
  /** Resolves a bare command name on PATH. Absent means this host cannot say. */
  findExecutable?(name: string): string | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{64}$/u;

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Whether the configured signer is the keystore — by the executable's base
 * name, so `["/abs/path/.bin/waterx-predict-keystore","sign"]` counts too.
 */
export const signsWithKeystore = (config: ResolvedConfig): boolean => {
  const first = config.signerCommand?.[0];
  return first !== undefined && baseName(first) === KEYSTORE_LAYOUT.command;
};

/**
 * Probe, or `undefined` when the keystore is none of this invocation's business:
 * a signer is configured and it is some other command.
 */
export function probeKeystore(
  config: ResolvedConfig,
  sources: KeystoreProbeSources,
): KeystoreProbe | undefined {
  const configuredAsSigner = signsWithKeystore(config);
  if (config.signerCommand !== undefined && !configuredAsSigner) return undefined;

  const named = sources.env[KEYSTORE_LAYOUT.runtimeDirEnv];
  const home = sources.homeDir();
  const dir =
    named !== undefined && named.trim() !== ''
      ? named
      : home === null || home === ''
        ? null
        : [home, ...KEYSTORE_LAYOUT.defaultRuntimeDir].join('/');

  const installed = sources.findExecutable?.(KEYSTORE_LAYOUT.command) != null;
  if (dir === null) {
    return { installed, configuredAsSigner, dir: '', keystore: { status: 'ABSENT' }, agent: 'NO_SOCKET' };
  }

  let keystore: KeystoreProbe['keystore'];
  let text: string | null;
  try {
    text = sources.readFile(`${dir}/${KEYSTORE_LAYOUT.keystoreFile}`);
  } catch {
    text = '';
  }
  if (text === null) {
    keystore = { status: 'ABSENT' };
  } else {
    let address: unknown;
    let protection: unknown;
    try {
      const parsed = JSON.parse(text) as { address?: unknown; protection?: unknown };
      address = parsed.address;
      protection = parsed.protection;
    } catch {
      address = undefined;
    }
    keystore =
      typeof address === 'string' && ADDRESS.test(address)
        ? { status: 'PRESENT', address, protection: protection === 'NONE' ? 'NONE' : 'SCRYPT_AES_GCM' }
        : { status: 'UNREADABLE' };
  }

  const socket = sources.pathStat(`${dir}/${KEYSTORE_LAYOUT.socketFile}`);
  const agent: KeystoreProbe['agent'] =
    keystore.status === 'PRESENT' && keystore.protection === 'NONE'
      ? 'NOT_NEEDED'
      : socket === null
        ? 'NO_SOCKET'
        : 'SOCKET_PRESENT';
  return { installed, configuredAsSigner, dir, keystore, agent };
}
