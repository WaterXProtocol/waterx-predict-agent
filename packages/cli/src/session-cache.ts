/**
 * Reusing one session across commands, so one signature is not one command.
 *
 * Every invocation is a fresh process, so without this the CLI authenticates
 * every time — and with an interactive signer (a browser wallet, a hardware key)
 * that means a human interaction per `market list`. The `interactive` policy is
 * unusable at that price, which makes this a correctness problem for the mode
 * rather than a convenience.
 *
 * What is cached is the SESSION TOKEN the server already issued, and the rules
 * are the ones this repository already applies to the Runner's bearer token:
 *
 * - It lives in a **0600 file inside a 0700 directory owned by this uid**, and it
 *   is neither read nor written when that cannot be proven. A cache is an
 *   optimisation; a cache that lowers the bar for reading a credential is not.
 * - It is keyed by **base URL and agent wallet**. A token minted against one
 *   deployment must never be offered to another, and one wallet's session must
 *   never be replayed as another's.
 * - It carries the server's own expiry, and is discarded early by a margin, so a
 *   token is never handed to a command that will outlive it mid-order.
 * - It is **never** written to the config file, which is still refused outright
 *   for holding anything credential-shaped (`config.ts`).
 *
 * Anything unparseable, stale, or belonging to another key is treated as absent.
 * The cost of a miss is one signature; the cost of guessing is using a credential
 * nobody meant to reuse.
 */
import type { PathStat } from './runner-ipc.ts';

/** Inside the home directory. Its own directory: the Runner asserts over its own. */
export const SESSION_CACHE_DIR = ['.waterx', 'cli'] as const;
export const SESSION_CACHE_FILE = 'session.json';

/**
 * Discarded this long before the server's expiry.
 *
 * A command that starts with four seconds left would spend them mid-request and
 * re-authenticate anyway, having already paid for the round trip.
 */
const EXPIRY_MARGIN_MS = 30_000;

export interface SessionCacheIo {
  readonly stat: PathStat;
  /** Null when absent. Any read error is treated as absent. */
  readFile(path: string): string | null;
  /** Must create the file 0600, and the directory 0700 if it does not exist. */
  writeFile(path: string, contents: string): void;
  now(): number;
}

export interface SessionKey {
  readonly baseUrl: string;
  readonly agentWallet: string | undefined;
}

interface StoredSession {
  readonly baseUrl?: unknown;
  readonly agentWallet?: unknown;
  readonly token?: unknown;
  readonly expiresAt?: unknown;
}

export const sessionCacheDir = (homeDir: string): string =>
  [homeDir, ...SESSION_CACHE_DIR].join('/');

export const sessionCachePath = (homeDir: string): string =>
  `${sessionCacheDir(homeDir)}/${SESSION_CACHE_FILE}`;

/**
 * Whether the directory is private to this uid.
 *
 * Absent counts as private: nothing has been written yet, and `writeFile` is
 * responsible for creating it with the right mode. A directory that exists and
 * is readable by anyone else is refused rather than repaired — silently
 * tightening someone's filesystem is not this tool's decision to make.
 */
const dirIsPrivate = (io: SessionCacheIo, dir: string, uid: number): boolean => {
  const facts = io.stat(dir);
  if (facts === null) return true;
  return facts.kind === 'directory' && facts.uid === uid && (facts.mode & 0o077) === 0;
};

const fileIsPrivate = (io: SessionCacheIo, path: string, uid: number): boolean => {
  const facts = io.stat(path);
  if (facts === null) return false;
  return facts.kind === 'file' && facts.uid === uid && (facts.mode & 0o077) === 0;
};

const sameKey = (stored: StoredSession, key: SessionKey): boolean =>
  stored.baseUrl === key.baseUrl && (stored.agentWallet ?? null) === (key.agentWallet ?? null);

/**
 * The cached token for this exact key, or undefined.
 *
 * Undefined is the answer for every doubt — absent, unreadable, world-readable,
 * malformed, expired, another deployment's, another wallet's.
 */
export function readCachedSession(
  io: SessionCacheIo,
  homeDir: string,
  key: SessionKey,
  uid: number,
): string | undefined {
  const dir = sessionCacheDir(homeDir);
  const path = sessionCachePath(homeDir);
  if (!dirIsPrivate(io, dir, uid) || !fileIsPrivate(io, path, uid)) return undefined;

  const raw = io.readFile(path);
  if (raw === null) return undefined;
  let stored: StoredSession;
  try {
    stored = JSON.parse(raw) as StoredSession;
  } catch {
    return undefined;
  }
  if (typeof stored.token !== 'string' || stored.token === '') return undefined;
  if (typeof stored.expiresAt !== 'number' || !Number.isFinite(stored.expiresAt)) return undefined;
  if (!sameKey(stored, key)) return undefined;
  if (io.now() >= stored.expiresAt - EXPIRY_MARGIN_MS) return undefined;
  return stored.token;
}

/**
 * Records a session the server just issued.
 *
 * A response with no `expiresIn` is NOT cached: a token whose lifetime is
 * unknown would be reused until the server rejected it, turning a saved
 * signature into a failed command at an arbitrary later moment. Nothing is
 * written when the directory cannot be proven private.
 */
export function writeCachedSession(
  io: SessionCacheIo,
  homeDir: string,
  key: SessionKey,
  session: { readonly token: string; readonly expiresIn?: number | undefined },
  uid: number,
): void {
  if (session.token === '') return;
  if (typeof session.expiresIn !== 'number' || !Number.isFinite(session.expiresIn)) return;
  if (session.expiresIn <= 0) return;
  const dir = sessionCacheDir(homeDir);
  if (!dirIsPrivate(io, dir, uid)) return;
  io.writeFile(
    sessionCachePath(homeDir),
    `${JSON.stringify({
      baseUrl: key.baseUrl,
      agentWallet: key.agentWallet ?? null,
      token: session.token,
      expiresAt: io.now() + session.expiresIn * 1_000,
    })}\n`,
  );
}
