/**
 * The filesystem half of local IPC authentication.
 *
 * Node's `net` exposes no peer credentials — there is no portable `SO_PEERCRED`
 * here — so "only the owner may talk to the Runner" cannot be enforced by asking
 * the connection who it is. It is enforced the way Unix has always enforced it:
 * the socket lives in a directory that is mode `0700` and owned by this uid, so
 * no other uid can traverse to it in the first place. The bearer token in
 * `protocol.ts` is the second factor, for anything that *did* obtain the path.
 *
 * That makes the directory check load-bearing rather than hygienic, which is why
 * a directory that is group- or world-accessible stops the Runner from starting
 * instead of producing a warning. Starting anyway would mean the process holding
 * the signer is reachable by another local account, and the failure would be
 * silent until someone used it.
 *
 * Root is the exception that cannot be closed: root can read any file and connect
 * to any socket regardless of mode. Nothing here pretends otherwise.
 */
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { RunnerIpcError } from './protocol.ts';

export const RUNTIME_DIR_MODE = 0o700;
export const SECRET_FILE_MODE = 0o600;

/**
 * `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux, including the
 * terminator. Binding a longer path does not fail loudly — it binds a truncated
 * one, and the Runner ends up listening somewhere nobody will look. Refuse at the
 * lower of the two limits so a path that works on Linux cannot silently differ on
 * macOS (ADR-0002 supports both).
 */
export const MAX_SOCKET_PATH_BYTES = 103;

const currentUid = (): number | undefined => process.getuid?.();

export const assertUnixPlatform = (): void => {
  if (process.platform === 'win32') {
    throw new RunnerIpcError(
      'UNSUPPORTED_PLATFORM',
      'the Runner speaks local IPC over a Unix domain socket; Windows is not supported (ADR-0002)',
      { platform: process.platform },
    );
  }
};

export const assertSocketPathLength = (socketPath: string): void => {
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new RunnerIpcError(
      'SOCKET_PATH_TOO_LONG',
      `socket path is ${String(bytes)} bytes; the platform limit truncates above ${String(MAX_SOCKET_PATH_BYTES)}`,
      { bytes, limit: MAX_SOCKET_PATH_BYTES },
    );
  }
};

/**
 * The gate: this path exists, this uid owns it, and nobody else has any bit.
 *
 * Applied to the runtime directory and to every secret-bearing file inside it.
 */
export const assertPrivatePath = (path: string, expect: 'directory' | 'file'): void => {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new RunnerIpcError('INSECURE_RUNTIME_DIR', `${path} does not exist`, { path });
  }
  if (expect === 'directory' && !stats.isDirectory()) {
    throw new RunnerIpcError('INSECURE_RUNTIME_DIR', `${path} is not a directory`, { path });
  }
  if (expect === 'file' && !stats.isFile()) {
    throw new RunnerIpcError('INSECURE_RUNTIME_DIR', `${path} is not a regular file`, { path });
  }

  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new RunnerIpcError(
      'INSECURE_RUNTIME_DIR',
      `${path} is owned by uid ${String(stats.uid)}, not by this process's uid ${String(uid)}`,
      { path, ownerUid: stats.uid, expectedUid: uid },
    );
  }

  // Group and other bits, in octal, so the message is the one a reader would
  // type into `chmod`.
  const shared = stats.mode & 0o077;
  if (shared !== 0) {
    throw new RunnerIpcError(
      'INSECURE_RUNTIME_DIR',
      `${path} is accessible beyond its owner (mode ${(stats.mode & 0o777).toString(8)}); the Runner holds the signer and refuses to start`,
      { path, mode: (stats.mode & 0o777).toString(8) },
    );
  }
};

/**
 * Creates the runtime directory if needed and proves it is private.
 *
 * `mkdirSync`'s `mode` is masked by the process umask, so a directory this call
 * created still has to be tightened explicitly. A directory that *already
 * existed* is deliberately not tightened: it is refused instead. Quietly
 * chmod'ing it would hide that the socket and the token file were reachable by
 * another local account up to this moment, which is precisely the fact the
 * operator needs to see.
 */
export const ensureRuntimeDir = (dir: string): string => {
  const created = mkdirSync(dir, { recursive: true, mode: RUNTIME_DIR_MODE });
  if (created !== undefined) chmodSync(dir, RUNTIME_DIR_MODE);
  assertPrivatePath(dir, 'directory');
  return dir;
};

/** 256 bits from the CSPRNG. Base64url so it survives JSON without escaping. */
export const mintIpcToken = (): string => randomBytes(32).toString('base64url');

/**
 * Writes the token where a client running as the same user can read it.
 *
 * The file is rewritten on every start, deliberately: a token left behind by a
 * crashed Runner must stop working the moment a new one takes over, or a client
 * holding it would be authenticated against a daemon that never issued it.
 */
export const writeIpcToken = (path: string, token: string): void => {
  writeFileSync(path, `${token}\n`, { mode: SECRET_FILE_MODE });
  chmodSync(path, SECRET_FILE_MODE);
};

export const readIpcToken = (path: string): string => {
  assertPrivatePath(path, 'file');
  const token = readFileSync(path, 'utf8').trim();
  if (token.length === 0) {
    throw new RunnerIpcError('UNAUTHENTICATED', `the token file at ${path} is empty`, { path });
  }
  return token;
};
