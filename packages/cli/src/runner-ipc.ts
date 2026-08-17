/**
 * The CLI's client for the local Runner's socket.
 *
 * A strategy is durable, and nothing server-side holds it: the price target, the
 * lease, the job store and the signer all live in a Runner process on this
 * machine (ADR-0001 §6, ADR-0008). So `strategy create` is not an API call — it
 * is a request to a daemon the operator started, and this file is how a one-shot
 * command reaches it.
 *
 * WHY A SECOND IMPLEMENTATION. The obvious move is to import the Runner's own
 * client. That edge is refused (`tests/workspace.test.ts`): it would put a
 * daemon, a SQLite store, a scheduler and a signer inside a CLI that must run on
 * a machine with none of them, and it would make `waterx-predict describe` — the
 * command you run when nothing works — depend on the heaviest package here. So
 * the wire is the shared thing instead. {@link RUNNER_IPC_PROTOCOL} below is a
 * copy of the Runner's descriptor, the workspace test asserts the two are equal,
 * and it then feeds the frames this file actually writes through the Runner's
 * real decoder. That is what makes the duplication safe rather than hopeful; it
 * is the same arrangement as `SIGNER_PROTOCOL`, for the same reason.
 *
 * WHAT THIS FILE DOES NOT DO. It does not decide anything about a strategy. It
 * does not default an expiry, choose between sizing fields, name a policy, or
 * translate a refusal into a different refusal. The Runner owns those rules and
 * answers with a symbolic code; this file carries the code out to the envelope
 * and the exit table. A CLI that re-decided any of it would be a second place
 * where "sell half" could mean something else.
 *
 * THE CHECKS BEFORE THE DIAL. The runtime directory is asserted private —
 * existing, owned by this uid, no group or other bits — BEFORE a socket is
 * opened, and the token is read from inside it. This is not hygiene. A
 * world-writable `~/.waterx/runner` lets another local account plant a socket
 * and a token file and receive the operator's strategy, complete with wallet
 * addresses and sizes, and answer with a plausible job id. Refusing costs one
 * `chmod`; not refusing costs the trade.
 */
import type { Socket } from 'node:net';
import type { Stats } from 'node:fs';

import { CliError } from './errors.ts';

/**
 * The wire, as data. A verbatim copy of the Runner's `RUNNER_IPC_PROTOCOL`,
 * held equal to it by `tests/workspace.test.ts`.
 *
 * Edit neither copy alone. The failure mode a drift produces is not a type
 * error: it is a CLI reporting "no Runner is listening" at a machine where one
 * is, in the minute an operator is trying to cancel something.
 */
export const RUNNER_IPC_PROTOCOL = {
  version: 1,
  /** Inside the runtime directory. Both are named by the descriptor, not guessed. */
  socketFile: 'runner.sock',
  tokenFile: 'runner.token',
  runtimeDirEnv: 'WATERX_RUNNER_DIR',
  /** Joined onto the home directory when the environment names none. */
  defaultRuntimeDir: ['.waterx', 'runner'],
  maxFrameBytes: 1_048_576,
  /** Exact key sets. A frame with more or fewer keys is a different protocol. */
  clientFrames: [
    { type: 'hello', fields: ['v', 'type', 'token', 'client'] },
    { type: 'request', fields: ['v', 'type', 'id', 'command', 'input'] },
  ],
  serverFrames: [
    { type: 'hello-ok', fields: ['v', 'type', 'instanceId', 'driving'] },
    { type: 'response', fields: ['v', 'type', 'id', 'ok', 'result', 'error'] },
  ],
  /** The only family a client outside that package is expected to call. */
  strategyCommands: [
    'strategy.create',
    'strategy.get',
    'strategy.list',
    'strategy.cancel',
    'strategy.events',
  ],
} as const;

/**
 * The Runner refused, or could not be reached.
 *
 * A third namespace beside `CliError` and the server's codes, because "the
 * daemon on this machine said no" is a different thing to act on than either
 * "this CLI said no" or "the exchange said no" — the fix is usually to start,
 * configure or `chmod` something local. The code is the Runner's own symbol,
 * carried through unchanged.
 */
export class RunnerRefusal extends Error {
  override readonly name = 'RunnerRefusal';

  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export const isRunnerRefusal = (value: unknown): value is RunnerRefusal =>
  value instanceof RunnerRefusal;

/* ── The seams ───────────────────────────────────────────────────────────── */

export interface PathFacts {
  readonly kind: 'directory' | 'file' | 'other';
  readonly uid: number;
  /** Permission bits only, already masked to `0o777`. */
  readonly mode: number;
}

/** Returns null when the path does not exist. Injected, so a test needs no chmod. */
export type PathStat = (path: string) => PathFacts | null;

/** One connection. Deliberately smaller than a Node socket. */
export interface RunnerSocket {
  write(line: string): void;
  /** Idempotent: called on the happy path and again from the failure path. */
  close(): void;
  onData(listener: (chunk: string) => void): void;
  /** Fires once, whichever way the connection ends. */
  onClose(listener: (error?: Error) => void): void;
}

export type RunnerDialer = (socketPath: string, timeoutMs: number) => Promise<RunnerSocket>;

/* ── Locating the Runner ─────────────────────────────────────────────────── */

export interface RuntimeDirSources {
  readonly env: Readonly<Record<string, string | undefined>>;
  homeDir(): string | null;
  /** `--runner-dir`, which outranks both. */
  readonly explicit?: string | undefined;
}

/**
 * Where the Runner's runtime directory is, by the same rule the Runner uses.
 *
 * A home directory that cannot be determined is an error rather than a fallback
 * to the working directory: `./.waterx/runner` would be a different Runner in
 * every shell, and the resulting "no Runner is listening" would be true and
 * useless.
 */
export function resolveRuntimeDir(sources: RuntimeDirSources): string {
  const explicit = sources.explicit ?? sources.env[RUNNER_IPC_PROTOCOL.runtimeDirEnv];
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  const home = sources.homeDir();
  if (home === null || home === '') {
    throw new CliError(
      'NOT_CONFIGURED',
      `No home directory could be determined, so the Runner's runtime directory cannot be located. Set ${RUNNER_IPC_PROTOCOL.runtimeDirEnv} or pass \`--runner-dir\`.`,
    );
  }
  return [home, ...RUNNER_IPC_PROTOCOL.defaultRuntimeDir].join('/');
}

export const runnerSocketPath = (runtimeDir: string): string =>
  `${runtimeDir}/${RUNNER_IPC_PROTOCOL.socketFile}`;

export const runnerTokenPath = (runtimeDir: string): string =>
  `${runtimeDir}/${RUNNER_IPC_PROTOCOL.tokenFile}`;

/**
 * `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux. A longer path
 * does not fail — it binds and connects to a TRUNCATED one — so refuse at the
 * lower limit, matching the Runner, rather than talking to an address neither
 * side meant.
 */
const MAX_SOCKET_PATH_BYTES = 103;

/**
 * Prove the directory is private and read the token, before anything is dialled.
 *
 * The two failure classes are kept apart on purpose. An ABSENT directory or
 * token means no Runner has ever started here, which is a normal state and gets
 * a message naming the directory and how to change it. A directory that exists
 * and is readable by other accounts is a security refusal, not an absence, and
 * must not be repaired automatically — chmod'ing it would erase the evidence
 * that the socket and the token were reachable up to this moment.
 */
function readRunnerToken(
  runtimeDir: string,
  stat: PathStat,
  readFile: (path: string) => string | null,
  onSecret: ((secret: string) => void) | undefined,
): string {
  const dir = stat(runtimeDir);
  if (dir === null) {
    throw new RunnerRefusal(
      'RUNNER_UNREACHABLE',
      `No Runner runtime directory at ${runtimeDir}. Start one with \`runnerd\`, or point this command at another with \`--runner-dir\` or ${RUNNER_IPC_PROTOCOL.runtimeDirEnv}. Nothing was attempted.`,
      { runtimeDir },
    );
  }
  assertPrivate(runtimeDir, dir, 'directory');

  const tokenPath = runnerTokenPath(runtimeDir);
  const tokenFile = stat(tokenPath);
  if (tokenFile === null) {
    throw new RunnerRefusal(
      'RUNNER_UNREACHABLE',
      `The runtime directory ${runtimeDir} holds no ${RUNNER_IPC_PROTOCOL.tokenFile}, so no Runner is listening there. Nothing was attempted.`,
      { runtimeDir },
    );
  }
  assertPrivate(tokenPath, tokenFile, 'file');

  const token = readFile(tokenPath)?.trim() ?? '';
  if (token === '') {
    throw new RunnerRefusal(
      'UNAUTHENTICATED',
      `The Runner token file at ${tokenPath} is empty. A Runner rewrites it at every start; restart the daemon.`,
      { runtimeDir },
    );
  }
  // Before the caller can hold it, and well before it is written to a socket.
  onSecret?.(token);
  return token;
}

function assertPrivate(path: string, facts: PathFacts, expect: 'directory' | 'file'): void {
  if (facts.kind !== expect) {
    throw new RunnerRefusal('INSECURE_RUNTIME_DIR', `${path} is not a ${expect}.`, { path });
  }
  const uid = process.getuid?.();
  if (uid !== undefined && facts.uid !== uid) {
    throw new RunnerRefusal(
      'INSECURE_RUNTIME_DIR',
      `${path} is owned by uid ${String(facts.uid)}, not by this process's uid ${String(uid)}. Nothing was sent to it.`,
      { path, ownerUid: facts.uid, expectedUid: uid },
    );
  }
  if ((facts.mode & 0o077) !== 0) {
    throw new RunnerRefusal(
      'INSECURE_RUNTIME_DIR',
      `${path} is accessible beyond its owner (mode ${(facts.mode & 0o777).toString(8)}). Another local account could stand in for the Runner, so nothing was sent. Fix it with \`chmod 700 ${path}\`.`,
      { path, mode: (facts.mode & 0o777).toString(8) },
    );
  }
}

/* ── The session ─────────────────────────────────────────────────────────── */

export interface RunnerSession {
  readonly instanceId: string;
  /**
   * Whether that Runner actually advances jobs. A Runner that is not driving
   * still accepts a create and writes a durable job nothing will move, so this
   * is the difference between "armed" and "armed and watching".
   */
  readonly driving: boolean;
  readonly socketPath: string;
  request(command: string, input: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): void;
}

export interface OpenRunnerSessionOptions {
  readonly runtimeDir: string;
  readonly dial: RunnerDialer;
  readonly stat: PathStat;
  readFile(path: string): string | null;
  readonly timeoutMs: number;
  /** Free-form, for `runner status`. Not identity — the token is. */
  readonly client: string;
  /**
   * Called with the bearer token the moment it is read, before it is written to
   * any socket, so the output redactor is watching it for the whole invocation.
   *
   * This module is careful not to echo the token — no message here quotes a
   * frame it wrote — but that care is exactly what the redactor exists to stop
   * depending on. The token is a live credential for a process that holds a
   * signer, and the path that leaks one is always the path nobody audited: an
   * error from a dependency, a stack trace, a Runner that helpfully includes
   * what it was sent in its own refusal.
   */
  onSecret?(secret: string): void;
}

export async function openRunnerSession(
  options: OpenRunnerSessionOptions,
): Promise<RunnerSession> {
  const { runtimeDir } = options;
  // Everything that can fail without touching the network fails here, so a
  // refusal for a missing or world-readable directory costs zero socket traffic.
  const token = readRunnerToken(runtimeDir, options.stat, options.readFile, options.onSecret);
  const socketPath = runnerSocketPath(runtimeDir);
  if (Buffer.byteLength(socketPath, 'utf8') > MAX_SOCKET_PATH_BYTES) {
    throw new RunnerRefusal(
      'SOCKET_PATH_TOO_LONG',
      `The socket path is ${String(Buffer.byteLength(socketPath, 'utf8'))} bytes; the platform truncates above ${String(MAX_SOCKET_PATH_BYTES)}, so this would connect somewhere else. Use a shorter \`--runner-dir\`.`,
      { socketPath },
    );
  }
  if (options.stat(socketPath) === null) {
    throw new RunnerRefusal(
      'RUNNER_UNREACHABLE',
      `No Runner is listening at ${socketPath}. Start one with \`runnerd\`. Nothing was attempted.`,
      { runtimeDir, socketPath },
    );
  }

  const socket = await dialOrRefuse(options.dial, socketPath, options.timeoutMs, runtimeDir);
  const connection = new Connection(socket, options.timeoutMs);

  // The handshake, before any command. A version mismatch has to surface here
  // rather than halfway through a strategy, which is why the Runner refuses
  // rather than negotiating down.
  const hello = await connection.exchange({
    v: RUNNER_IPC_PROTOCOL.version,
    type: 'hello',
    token,
    client: options.client,
  });
  if (hello['type'] !== 'hello-ok' || typeof hello['instanceId'] !== 'string') {
    connection.close();
    throw refusalFrom(hello, `The Runner at ${socketPath} did not complete the handshake.`);
  }

  const instanceId = hello['instanceId'];
  const driving = hello['driving'] === true;
  let nextId = 0;

  return {
    instanceId,
    driving,
    socketPath,
    request: async (command, input) => {
      nextId += 1;
      const id = `cli-${String(nextId)}`;
      const frame = await connection.exchange({
        v: RUNNER_IPC_PROTOCOL.version,
        type: 'request',
        id,
        command,
        input,
      });
      if (frame['type'] !== 'response') {
        throw refusalFrom(frame, `The Runner answered a ${command} with a frame that is not a response.`);
      }
      // A response id that is not the one asked for cannot be correlated, and
      // treating it as this command's answer is how a reply about one job gets
      // reported as another's. The Runner also uses `-` for a failure that
      // belongs to the connection rather than to any request.
      if (frame['id'] !== id && frame['id'] !== '-') {
        connection.close();
        throw new RunnerRefusal(
          'MALFORMED_FRAME',
          `The Runner answered request ${id} with a frame for ${JSON.stringify(frame['id'])}. The connection was closed rather than guessing which request it belonged to.`,
        );
      }
      if (frame['ok'] === true) return frame['result'];
      throw refusalFrom(frame, `The Runner refused ${command}.`);
    },
    close: () => {
      connection.close();
    },
  };
}

async function dialOrRefuse(
  dial: RunnerDialer,
  socketPath: string,
  timeoutMs: number,
  runtimeDir: string,
): Promise<RunnerSocket> {
  try {
    return await dial(socketPath, timeoutMs);
  } catch (error: unknown) {
    const code = (error as { code?: string } | null)?.code;
    // A socket file with nothing behind it: a Runner that crashed without
    // unlinking. Reported as unreachable rather than as a broken socket,
    // because what the operator has to do is the same — start one.
    if (code === 'ECONNREFUSED' || code === 'ENOENT') {
      throw new RunnerRefusal(
        'RUNNER_UNREACHABLE',
        `Nothing is listening on ${socketPath} — the file is there but no Runner has it open, which is what a crashed daemon leaves behind. Start one with \`runnerd\`. Nothing was attempted.`,
        { runtimeDir, socketPath },
      );
    }
    throw new RunnerRefusal(
      'CONNECTION_CLOSED',
      `Could not connect to the Runner at ${socketPath}: ${error instanceof Error ? error.message : String(error)}`,
      { runtimeDir, socketPath },
    );
  }
}

/** A refusal built from a frame the Runner sent, keeping its own code. */
function refusalFrom(frame: Record<string, unknown>, fallback: string): RunnerRefusal {
  const error = frame['error'];
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const body = error as Record<string, unknown>;
    if (typeof body['code'] === 'string') {
      const detail = body['detail'];
      return new RunnerRefusal(
        body['code'],
        typeof body['message'] === 'string' ? body['message'] : fallback,
        detail !== null && typeof detail === 'object' && !Array.isArray(detail)
          ? (detail as Record<string, unknown>)
          : undefined,
      );
    }
  }
  return new RunnerRefusal('MALFORMED_FRAME', fallback);
}

/* ── Framing ─────────────────────────────────────────────────────────────── */

/**
 * One request in flight at a time, which is all a one-shot command needs.
 *
 * The frame bound is applied to the ACCUMULATING buffer rather than to a
 * finished line, matching the Runner. A peer that streams bytes without ever
 * sending a newline must be disconnected, not buffered — and while the Runner
 * enforces this because it holds the signer, the CLI enforces it because
 * whatever is on the other end of this socket is not necessarily the Runner.
 */
class Connection {
  private buffer = '';
  private lines: string[] = [];
  private waiting: ((line: string) => void) | undefined;
  private failure: Error | undefined;
  private notifyFailure: ((error: Error) => void) | undefined;
  private closed = false;

  constructor(
    private readonly socket: RunnerSocket,
    private readonly timeoutMs: number,
  ) {
    socket.onData((chunk) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim().length > 0) this.deliver(line);
        index = this.buffer.indexOf('\n');
      }
      if (Buffer.byteLength(this.buffer, 'utf8') > RUNNER_IPC_PROTOCOL.maxFrameBytes) {
        this.fail(
          new RunnerRefusal(
            'FRAME_TOO_LARGE',
            `The Runner sent more than ${String(RUNNER_IPC_PROTOCOL.maxFrameBytes)} bytes without terminating a frame. The connection was dropped.`,
          ),
        );
      }
    });
    socket.onClose((error) => {
      this.fail(
        error ??
          new RunnerRefusal(
            'CONNECTION_CLOSED',
            'The Runner closed the connection before answering. On a create this says nothing about whether the strategy was written.',
          ),
      );
    });
  }

  private deliver(line: string): void {
    const waiting = this.waiting;
    if (waiting === undefined) {
      this.lines.push(line);
      return;
    }
    this.waiting = undefined;
    waiting(line);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.notifyFailure?.(this.failure);
  }

  async exchange(frame: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    if (this.failure !== undefined) throw this.failure;
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, 'utf8') > RUNNER_IPC_PROTOCOL.maxFrameBytes) {
      // The one input that can plausibly reach this is a twenty-leg strategy
      // pasted from a generator. Refused whole rather than truncated: half a
      // JSON document on the wire desynchronizes the Runner's parser.
      throw new RunnerRefusal(
        'FRAME_TOO_LARGE',
        `This request is ${String(Buffer.byteLength(line, 'utf8'))} bytes, above the ${String(RUNNER_IPC_PROTOCOL.maxFrameBytes)}-byte frame limit. Nothing was sent.`,
      );
    }
    this.socket.write(line);
    return parseFrame(await this.readLine());
  }

  private readLine(): Promise<string> {
    const buffered = this.lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        this.notifyFailure = undefined;
        this.close();
        reject(
          new RunnerRefusal(
            'TIMEOUT',
            `The Runner did not answer within ${String(this.timeoutMs)}ms. No answer was seen, so this says nothing about what it did.`,
          ),
        );
      }, this.timeoutMs);

      this.waiting = (line) => {
        clearTimeout(timer);
        this.notifyFailure = undefined;
        resolve(line);
      };
      this.notifyFailure = (error) => {
        clearTimeout(timer);
        this.waiting = undefined;
        this.notifyFailure = undefined;
        reject(error);
      };
      if (this.failure !== undefined) this.notifyFailure(this.failure);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

/**
 * A server frame, checked as far as the version and no further.
 *
 * The version gate runs before any other field is trusted, for the same reason
 * it does on the Runner: a client that read a field out of a frame it does not
 * understand would be guessing at the state of a job.
 */
function parseFrame(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new RunnerRefusal('MALFORMED_FRAME', 'The Runner sent something that is not JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RunnerRefusal('MALFORMED_FRAME', 'The Runner sent a frame that is not an object.');
  }
  const frame = parsed as Record<string, unknown>;
  if (frame['v'] !== RUNNER_IPC_PROTOCOL.version) {
    throw new RunnerRefusal(
      'PROTOCOL_VERSION',
      `The Runner speaks IPC protocol version ${JSON.stringify(frame['v'])}; this CLI speaks ${String(RUNNER_IPC_PROTOCOL.version)}. Versions are refused, never negotiated down — upgrade whichever is older.`,
      { expected: RUNNER_IPC_PROTOCOL.version, received: frame['v'] },
    );
  }
  return frame;
}

/* ── Node bindings ───────────────────────────────────────────────────────── */

/** Just enough of `net.connect`, so the whole file above is testable. */
export type NetConnect = (options: { path: string }) => Socket;

export const createNodeRunnerDialer =
  (connect: NetConnect): RunnerDialer =>
  (socketPath, timeoutMs) =>
    new Promise<RunnerSocket>((resolve, reject) => {
      const socket = connect({ path: socketPath });
      socket.setEncoding('utf8');
      // The dial gets the same deadline as a request. Without it a socket whose
      // peer accepted and then stopped reading would hang the CLI forever, which
      // is a worse answer than "no Runner is listening".
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
      });

      let settled = false;
      socket.once('error', (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        resolve({
          write: (line) => {
            socket.write(line);
          },
          close: () => {
            socket.destroy();
          },
          onData: (listener) => {
            socket.on('data', (chunk: string | Buffer) => {
              listener(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
            });
          },
          onClose: (listener) => {
            socket.once('close', () => {
              listener();
            });
            // After the handshake an error is no longer a dial failure; it is the
            // connection ending, and the pending request has to learn about it.
            socket.on('error', (error: Error) => {
              listener(error);
            });
          },
        });
      });
    });

/** `statSync`-shaped, narrowed to the three facts the privacy check needs. */
export const createNodePathStat =
  (statSync: (path: string) => Stats): PathStat =>
  (path) => {
    let stats: Stats;
    try {
      stats = statSync(path);
    } catch {
      // Every failure to stat is treated as absence, including a permission
      // error on a parent directory: from here they are the same fact, which is
      // that this process cannot see a Runner there.
      return null;
    }
    return {
      kind: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
      uid: stats.uid,
      mode: stats.mode & 0o777,
    };
  };
