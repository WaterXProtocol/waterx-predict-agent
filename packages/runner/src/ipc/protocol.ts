/**
 * The local IPC wire format.
 *
 * The plan (§6.4) puts the signer and the long-lived job state inside the Runner
 * so that CLI and adapter subprocesses call it rather than each reading a private
 * key. That call needs a wire format, and this is it: newline-delimited JSON over
 * a Unix domain socket, one frame per line.
 *
 * Three properties are deliberate and each one is a failure mode somebody hits:
 *
 * 1. **The version is checked before anything else is read.** A newer CLI talking
 *    to an older daemon must fail on the handshake, not misinterpret a field
 *    halfway through an order. `PROTOCOL_VERSION` is refused, never negotiated
 *    down.
 * 2. **A frame is bounded.** `MAX_FRAME_BYTES` is enforced on the *accumulating*
 *    buffer, not on a completed line — a peer that opens a socket and streams
 *    bytes without ever sending a newline must be disconnected, not buffered
 *    until the Runner runs out of memory. The Runner is the process holding the
 *    signer; it is the last one that should be killable by a local peer.
 * 3. **A malformed frame is a disconnect, not a skipped line.** Once the stream
 *    stops parsing there is no way to know where the next frame begins, and
 *    guessing is how a request gets executed under the wrong id.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const RUNNER_IPC_PROTOCOL_VERSION = 1;

/**
 * One mebibyte. Far above any real command input and far below what would
 * pressure the process — the point is that the bound exists, not its exact value.
 */
export const MAX_FRAME_BYTES = 1_048_576;

/**
 * The wire, as data — everything a second implementation needs to speak it.
 *
 * The CLI has to reach a Runner to create a strategy, and it cannot depend on
 * this package: that edge would put a daemon, a SQLite store and a scheduler
 * inside a one-shot command, and `tests/workspace.test.ts` refuses it outright.
 * So the CLI carries its own client, and this descriptor is the thing the two
 * implementations are held to — `tests/workspace.test.ts` asserts the two copies
 * are equal and then runs the CLI's real frames through `decodeClientFrame`,
 * which is what makes it a claim about behaviour rather than a comment. It is
 * the same arrangement as `SIGNER_PROTOCOL`, for the same reason.
 *
 * The filenames and the default directory are in here rather than in
 * `daemon.ts` because they are half of the address: a client that guessed
 * `runner.socket` would report "no Runner is listening" while one was.
 */
export const RUNNER_IPC_PROTOCOL = {
  version: RUNNER_IPC_PROTOCOL_VERSION,
  /** Inside the runtime directory. Both are named by the descriptor, not guessed. */
  socketFile: 'runner.sock',
  tokenFile: 'runner.token',
  runtimeDirEnv: 'WATERX_RUNNER_DIR',
  /** Joined onto the home directory when the environment names none. */
  defaultRuntimeDir: ['.waterx', 'runner'],
  maxFrameBytes: MAX_FRAME_BYTES,
  /** Exact key sets. A frame with more or fewer keys is a different protocol. */
  clientFrames: [
    { type: 'hello', fields: ['v', 'type', 'token', 'client'] },
    { type: 'request', fields: ['v', 'type', 'id', 'command', 'input'] },
  ],
  serverFrames: [
    { type: 'hello-ok', fields: ['v', 'type', 'instanceId', 'driving'] },
    { type: 'response', fields: ['v', 'type', 'id', 'ok', 'result', 'error'] },
  ],
  /** The only family a client outside this package is expected to call. */
  strategyCommands: [
    'strategy.create',
    'strategy.get',
    'strategy.list',
    'strategy.cancel',
    'strategy.events',
  ],
} as const;

export type RunnerIpcErrorCode =
  /** The peer speaks a different protocol version. Never negotiated down. */
  | 'PROTOCOL_VERSION'
  /** Not JSON, or not a frame shape this version defines. */
  | 'MALFORMED_FRAME'
  /** The peer exceeded `MAX_FRAME_BYTES` without terminating a frame. */
  | 'FRAME_TOO_LARGE'
  /**
   * No handshake, or a handshake whose token did not match. Deliberately ONE
   * code for both: distinguishing "you sent no token" from "you sent the wrong
   * token" turns the socket into an oracle for whoever is guessing.
   */
  | 'UNAUTHENTICATED'
  /** The command is not in the agent command contract nor the Runner's own set. */
  | 'UNKNOWN_COMMAND'
  /** The command exists and the input does not satisfy its schema. */
  | 'INVALID_INPUT'
  /** The command is real, and this build cannot perform it. Names the gap. */
  | 'NOT_IMPLEMENTED'
  /**
   * This Runner is draining and will not admit new work (ADR-0009, `drain.ts`).
   *
   * Distinct from a closed socket on purpose: the caller must be able to tell a
   * planned upgrade from a crash, because the two differ on whether the request
   * might have taken effect. This one says plainly that it did not.
   */
  | 'RUNNER_DRAINING'
  /** The runtime directory is not private to this uid; the Runner refuses to start. */
  | 'INSECURE_RUNTIME_DIR'
  /** A live Runner is already listening on this socket. */
  | 'ADDRESS_IN_USE'
  /** `sun_path` is a fixed-size buffer; a longer path binds a truncated address. */
  | 'SOCKET_PATH_TOO_LONG'
  /** Unix domain sockets only (ADR-0002). */
  | 'UNSUPPORTED_PLATFORM'
  | 'CONNECTION_CLOSED'
  | 'TIMEOUT'
  | 'INTERNAL';

export class RunnerIpcError extends Error {
  override readonly name = 'RunnerIpcError';

  constructor(
    readonly code: RunnerIpcErrorCode,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export const isRunnerIpcError = (value: unknown): value is RunnerIpcError =>
  value instanceof RunnerIpcError;

export interface HelloFrame {
  readonly v: number;
  readonly type: 'hello';
  /** The bearer token minted at daemon start. Never logged, never echoed. */
  readonly token: string;
  /** Free-form, for `runner status`. Not identity — the token is. */
  readonly client?: string;
}

export interface HelloOkFrame {
  readonly v: number;
  readonly type: 'hello-ok';
  readonly instanceId: string;
  /**
   * Whether this daemon actually drives jobs. `false` in this build: there is no
   * executor yet. A client that assumed a connected Runner means a running
   * strategy would be wrong in exactly the way ADR-0001 §6 warns about, so the
   * handshake says it rather than leaving it to a README.
   */
  readonly driving: boolean;
}

export interface RequestFrame {
  readonly v: number;
  readonly type: 'request';
  /** Correlates the response. Opaque to the daemon; the client owns uniqueness. */
  readonly id: string;
  readonly command: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ResponseErrorBody {
  readonly code: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type ResponseFrame =
  | { readonly v: number; readonly type: 'response'; readonly id: string; readonly ok: true; readonly result: unknown }
  | {
      readonly v: number;
      readonly type: 'response';
      readonly id: string;
      readonly ok: false;
      readonly error: ResponseErrorBody;
    };

export type ClientFrame = HelloFrame | RequestFrame;
export type ServerFrame = HelloOkFrame | ResponseFrame;

/**
 * The id on an error frame that is not a reply to any request — a rejected
 * handshake, a malformed frame, a frame that overran the bound. A client must
 * not correlate it with a pending request, because it does not mean that request
 * failed; it means the connection did.
 */
export const UNSOLICITED_FRAME_ID = '-';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const malformed = (why: string): RunnerIpcError =>
  new RunnerIpcError('MALFORMED_FRAME', `malformed IPC frame: ${why}`);

/**
 * Serializes a frame and terminates it.
 *
 * Throws rather than truncating when the result exceeds the frame bound: a
 * response too large to send is this process's bug, and half a JSON document on
 * the wire would desynchronize the peer's parser.
 */
export const encodeFrame = (frame: ServerFrame | ClientFrame): string => {
  const line = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    throw new RunnerIpcError('INTERNAL', 'IPC frame exceeds the maximum frame size');
  }
  return line;
};

const parseLine = (line: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw malformed('not JSON');
  }
  if (!isRecord(parsed)) throw malformed('not an object');
  return parsed;
};

/**
 * The version gate. Runs before any other field is trusted, and refuses rather
 * than downgrading: a daemon that quietly accepted an unknown version would be
 * guessing at the meaning of an order.
 */
const assertVersion = (frame: Record<string, unknown>): void => {
  const version = frame['v'];
  if (typeof version !== 'number') throw malformed('missing protocol version');
  if (version !== RUNNER_IPC_PROTOCOL_VERSION) {
    throw new RunnerIpcError(
      'PROTOCOL_VERSION',
      `IPC protocol version ${String(version)} is not supported; this Runner speaks ${String(RUNNER_IPC_PROTOCOL_VERSION)}`,
      { expected: RUNNER_IPC_PROTOCOL_VERSION, received: version },
    );
  }
};

export const decodeClientFrame = (line: string): ClientFrame => {
  const frame = parseLine(line);
  assertVersion(frame);
  const type = frame['type'];

  if (type === 'hello') {
    const token = frame['token'];
    if (typeof token !== 'string' || token.length === 0) {
      // Not a MALFORMED_FRAME: a hello with no usable token is an authentication
      // failure and must be indistinguishable from a wrong one.
      throw new RunnerIpcError('UNAUTHENTICATED', 'the handshake carried no token');
    }
    const client = frame['client'];
    return {
      v: RUNNER_IPC_PROTOCOL_VERSION,
      type: 'hello',
      token,
      ...(typeof client === 'string' ? { client } : {}),
    };
  }

  if (type === 'request') {
    const id = frame['id'];
    const command = frame['command'];
    const input = frame['input'];
    if (typeof id !== 'string' || id.length === 0) throw malformed('missing request id');
    if (typeof command !== 'string' || command.length === 0) throw malformed('missing command');
    if (input !== undefined && !isRecord(input)) throw malformed('input is not an object');
    return {
      v: RUNNER_IPC_PROTOCOL_VERSION,
      type: 'request',
      id,
      command,
      input: input ?? {},
    };
  }

  throw malformed(`unknown frame type ${JSON.stringify(type)}`);
};

export const decodeServerFrame = (line: string): ServerFrame => {
  const frame = parseLine(line);
  assertVersion(frame);
  const type = frame['type'];

  if (type === 'hello-ok') {
    const instanceId = frame['instanceId'];
    if (typeof instanceId !== 'string') throw malformed('hello-ok without an instance id');
    return {
      v: RUNNER_IPC_PROTOCOL_VERSION,
      type: 'hello-ok',
      instanceId,
      driving: frame['driving'] === true,
    };
  }

  if (type === 'response') {
    const id = frame['id'];
    if (typeof id !== 'string') throw malformed('response without an id');
    if (frame['ok'] === true) {
      return { v: RUNNER_IPC_PROTOCOL_VERSION, type: 'response', id, ok: true, result: frame['result'] };
    }
    const error = frame['error'];
    if (!isRecord(error) || typeof error['code'] !== 'string' || typeof error['message'] !== 'string') {
      throw malformed('error response without a code and message');
    }
    const detail = error['detail'];
    return {
      v: RUNNER_IPC_PROTOCOL_VERSION,
      type: 'response',
      id,
      ok: false,
      error: {
        code: error['code'],
        message: error['message'],
        ...(isRecord(detail) ? { detail } : {}),
      },
    };
  }

  throw malformed(`unknown frame type ${JSON.stringify(type)}`);
};

/**
 * Constant-time token comparison.
 *
 * Both sides are hashed first so the comparison is over two fixed-width digests.
 * `timingSafeEqual` throws on a length mismatch, and branching on that throw
 * would leak the token's length to a local peer that is guessing — hashing
 * removes the branch entirely.
 */
export const tokensMatch = (expected: string, presented: string): boolean => {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(presented));
};

/**
 * A line splitter with the frame bound applied to the *unterminated* remainder.
 *
 * The bound has to be checked on the accumulating buffer rather than on a
 * finished line, or a peer that never sends a newline is unbounded.
 */
export class FrameReader {
  private buffer = '';

  push(chunk: string): readonly string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) lines.push(line);
      index = this.buffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) {
      throw new RunnerIpcError(
        'FRAME_TOO_LARGE',
        `IPC frame exceeded ${String(MAX_FRAME_BYTES)} bytes without terminating`,
      );
    }
    return lines;
  }
}
