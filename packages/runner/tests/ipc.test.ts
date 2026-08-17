/**
 * The local IPC surface, from the frame up.
 *
 * The Runner is the process that will hold the signer, so the properties under
 * test here are the ones that decide who can reach it and what a misbehaving peer
 * can do to it: a version that is refused rather than negotiated, a frame that is
 * bounded before it is parsed, one authentication attempt per connection, an
 * error body that never quotes a token, and a runtime directory whose mode is
 * load-bearing rather than hygienic.
 *
 * Every socket here is an ephemeral path inside a temporary directory, and every
 * test closes what it opened. Nothing is spawned.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunnerIpcClient } from '../src/ipc/client.ts';
import { listRunnerIpcCommands, validateRunnerCommand } from '../src/ipc/commands.ts';
import { toErrorBody } from '../src/ipc/dispatch.ts';
import {
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  FrameReader,
  MAX_FRAME_BYTES,
  RUNNER_IPC_PROTOCOL_VERSION,
  RunnerIpcError,
  tokensMatch,
  UNSOLICITED_FRAME_ID,
  type ServerFrame,
} from '../src/ipc/protocol.ts';
import {
  assertPrivatePath,
  assertSocketPathLength,
  ensureRuntimeDir,
  MAX_SOCKET_PATH_BYTES,
  mintIpcToken,
  readIpcToken,
  writeIpcToken,
} from '../src/ipc/runtime-dir.ts';
import { RunnerIpcServer, type RunnerIpcServerOptions } from '../src/ipc/server.ts';
import { tempRuntimeDir, type TempRuntimeDir } from './harness.ts';

const TOKEN = 'a-token-that-is-not-in-any-error';

/** The refusal code, or a failure that names what was thrown instead. */
export const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') throw error;
  return code;
};

const throwsCode = (body: () => unknown): string => {
  try {
    body();
  } catch (error) {
    return codeOf(error);
  }
  throw new Error('expected a refusal');
};

const rejectsCode = async (body: Promise<unknown>): Promise<string> => {
  try {
    await body;
  } catch (error) {
    return codeOf(error);
  }
  throw new Error('expected a rejection');
};

const caught = (body: () => unknown): RunnerIpcError => {
  try {
    body();
  } catch (error) {
    return error as RunnerIpcError;
  }
  throw new Error('expected a refusal');
};

// --------------------------------------------------------------------- raw peer

interface RawSession {
  send(raw: string): void;
  next(): Promise<ServerFrame>;
  closed(): Promise<void>;
  destroy(): void;
}

/**
 * A peer that writes bytes rather than frames, so a test can send the things a
 * well-behaved client never would.
 */
const rawConnect = async (socketPath: string): Promise<RawSession> => {
  const socket = createConnection(socketPath);
  socket.setEncoding('utf8');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      resolve();
    });
    socket.once('error', reject);
  });

  const reader = new FrameReader();
  const frames: ServerFrame[] = [];
  const closeWaiters: (() => void)[] = [];
  let waiter: { resolve(frame: ServerFrame): void; reject(error: unknown): void } | undefined;
  let closed = false;

  socket.on('data', (chunk: string) => {
    for (const line of reader.push(chunk)) {
      const frame = decodeServerFrame(line);
      if (waiter === undefined) {
        frames.push(frame);
      } else {
        const pending = waiter;
        waiter = undefined;
        pending.resolve(frame);
      }
    }
  });
  socket.on('error', () => {
    /* a destroyed peer is the expected end of several of these tests */
  });
  socket.on('close', () => {
    closed = true;
    waiter?.reject(new RunnerIpcError('CONNECTION_CLOSED', 'closed before a frame arrived'));
    waiter = undefined;
    for (const resolve of closeWaiters.splice(0)) resolve();
  });

  return {
    send: (raw) => {
      socket.write(raw);
    },
    next: async () =>
      new Promise<ServerFrame>((resolve, reject) => {
        const queued = frames.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        if (closed) {
          reject(new RunnerIpcError('CONNECTION_CLOSED', 'closed before a frame arrived'));
          return;
        }
        waiter = { resolve, reject };
      }),
    closed: async () =>
      new Promise<void>((resolve) => {
        if (closed) resolve();
        else closeWaiters.push(resolve);
      }),
    destroy: () => {
      socket.destroy();
    },
  };
};

const hello = (token: string, v = RUNNER_IPC_PROTOCOL_VERSION): string =>
  `${JSON.stringify({ v, type: 'hello', token })}\n`;

const requestLine = (id: string, command: string, input?: unknown): string =>
  `${JSON.stringify({ v: RUNNER_IPC_PROTOCOL_VERSION, type: 'request', id, command, input })}\n`;

const errorOf = (frame: ServerFrame): { code: string; message: string } => {
  if (frame.type !== 'response' || frame.ok) {
    throw new Error(`expected an error frame, got ${frame.type}`);
  }
  return frame.error;
};

// -------------------------------------------------------------- the wire format

describe('the frame reader', () => {
  it('splits several frames out of one chunk and holds the partial one', () => {
    const reader = new FrameReader();
    expect(reader.push('{"a":1}\n{"b":2}\n{"c":')).toEqual(['{"a":1}', '{"b":2}']);
    expect(reader.push('3}\n')).toEqual(['{"c":3}']);
  });

  it('ignores blank lines rather than treating them as frames', () => {
    expect(new FrameReader().push('\n\n{"a":1}\n')).toEqual(['{"a":1}']);
  });

  it('refuses a peer that streams past the bound without terminating a frame', () => {
    // The bound is on the unterminated remainder. A peer that never sends a
    // newline must be disconnected, not buffered until the process holding the
    // signer runs out of memory.
    const reader = new FrameReader();
    expect(throwsCode(() => reader.push('x'.repeat(MAX_FRAME_BYTES + 1)))).toBe('FRAME_TOO_LARGE');
  });
});

describe('decoding', () => {
  it('checks the protocol version before any other field', () => {
    // The token is missing too, and the version still wins: a frame from another
    // version is not a frame this one may interpret at all.
    const error = caught(() => decodeClientFrame(JSON.stringify({ v: 99, type: 'hello' })));
    expect(error.code).toBe('PROTOCOL_VERSION');
    expect(error.detail).toEqual({ expected: RUNNER_IPC_PROTOCOL_VERSION, received: 99 });
  });

  it('never negotiates a version down', () => {
    expect(() => decodeClientFrame(JSON.stringify({ v: 0, type: 'hello', token: 't' }))).toThrow(
      /not supported/,
    );
  });

  it('treats a hello with no usable token as an authentication failure', () => {
    // Not MALFORMED_FRAME: it has to be indistinguishable from a wrong token.
    for (const token of [undefined, '', 42]) {
      const line = JSON.stringify({ v: RUNNER_IPC_PROTOCOL_VERSION, type: 'hello', token });
      expect(throwsCode(() => decodeClientFrame(line))).toBe('UNAUTHENTICATED');
    }
  });

  it('refuses a line that is not JSON, not an object, or not a known frame type', () => {
    for (const line of ['not json', '[1,2]', JSON.stringify({ v: 1, type: 'nope' })]) {
      expect(throwsCode(() => decodeClientFrame(line))).toBe('MALFORMED_FRAME');
    }
  });

  it('refuses a request without an id, a command, or an object input', () => {
    const base = { v: RUNNER_IPC_PROTOCOL_VERSION, type: 'request' };
    expect(() => decodeClientFrame(JSON.stringify({ ...base, command: 'runner.status' }))).toThrow(
      /missing request id/,
    );
    expect(() => decodeClientFrame(JSON.stringify({ ...base, id: '1' }))).toThrow(/missing command/);
    expect(() =>
      decodeClientFrame(JSON.stringify({ ...base, id: '1', command: 'x', input: 5 })),
    ).toThrow(/input is not an object/);
  });

  it('defaults a request with no input to an empty object', () => {
    expect(decodeClientFrame(requestLine('1', 'runner.status').trim())).toEqual({
      v: RUNNER_IPC_PROTOCOL_VERSION,
      type: 'request',
      id: '1',
      command: 'runner.status',
      input: {},
    });
  });

  it('refuses a server error frame that carries no code and message', () => {
    expect(() =>
      decodeServerFrame(
        JSON.stringify({
          v: RUNNER_IPC_PROTOCOL_VERSION,
          type: 'response',
          id: '1',
          ok: false,
          error: { code: 'X' },
        }),
      ),
    ).toThrow(/code and message/);
  });

  it('throws rather than putting half a frame on the wire', () => {
    expect(
      throwsCode(() =>
        encodeFrame({
          v: RUNNER_IPC_PROTOCOL_VERSION,
          type: 'response',
          id: '1',
          ok: true,
          result: { blob: 'x'.repeat(MAX_FRAME_BYTES) },
        }),
      ),
    ).toBe('INTERNAL');
  });
});

describe('token comparison', () => {
  it('accepts the same token and rejects a different one', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, `${TOKEN}x`)).toBe(false);
  });

  it('compares tokens of different lengths without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, and branching on that throw
    // would leak the token's length to whoever is guessing.
    expect(tokensMatch('short', 'a-considerably-longer-value')).toBe(false);
    expect(tokensMatch('', 'x')).toBe(false);
  });
});

// ------------------------------------------------------------- the runtime dir

describe('the runtime directory', () => {
  let dir: TempRuntimeDir;

  beforeEach(() => {
    dir = tempRuntimeDir();
  });
  afterEach(() => {
    dir.cleanup();
  });

  it('creates a missing runtime directory at 0700', () => {
    const nested = join(dir.dir, 'deep', 'runtime');
    ensureRuntimeDir(nested);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
    // Idempotent for a directory it already made private.
    expect(() => ensureRuntimeDir(nested)).not.toThrow();
  });

  it('refuses a directory that already existed with looser permissions', () => {
    const loose = join(dir.dir, 'loose');
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    // Silently chmod'ing it would hide that the socket and the token file were
    // reachable by another local account up to this moment.
    expect(throwsCode(() => ensureRuntimeDir(loose))).toBe('INSECURE_RUNTIME_DIR');
    expect(statSync(loose).mode & 0o777).toBe(0o755);
  });

  it('refuses a directory anyone else can reach', () => {
    const loose = join(dir.dir, 'loose');
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    const error = caught(() => assertPrivatePath(loose, 'directory'));
    expect(error.code).toBe('INSECURE_RUNTIME_DIR');
    expect(error.message).toContain('755');
  });

  it('refuses a path that is missing or is the wrong kind of thing', () => {
    expect(throwsCode(() => assertPrivatePath(join(dir.dir, 'absent'), 'directory'))).toBe(
      'INSECURE_RUNTIME_DIR',
    );
    expect(() => assertPrivatePath(dir.dir, 'file')).toThrow(/not a regular file/);
    const file = join(dir.dir, 'plain');
    writeFileSync(file, 'x', { mode: 0o600 });
    expect(() => assertPrivatePath(file, 'directory')).toThrow(/not a directory/);
  });

  it('round-trips the token through a 0600 file', () => {
    const path = join(dir.dir, 'runner.token');
    const token = mintIpcToken();
    writeIpcToken(path, token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readIpcToken(path)).toBe(token);
  });

  it('mints a distinct 256-bit token each time', () => {
    const tokens = [...new Set(Array.from({ length: 16 }, () => mintIpcToken()))];
    expect(tokens).toHaveLength(16);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses to read a token file anyone else can read', () => {
    const path = join(dir.dir, 'runner.token');
    writeIpcToken(path, mintIpcToken());
    chmodSync(path, 0o644);
    expect(throwsCode(() => readIpcToken(path))).toBe('INSECURE_RUNTIME_DIR');
  });

  it('refuses an empty token file rather than authenticating with nothing', () => {
    const path = join(dir.dir, 'runner.token');
    writeFileSync(path, '\n', { mode: 0o600 });
    expect(throwsCode(() => readIpcToken(path))).toBe('UNAUTHENTICATED');
  });

  it('refuses a socket path the platform would silently truncate', () => {
    expect(() => assertSocketPathLength('/tmp/'.padEnd(MAX_SOCKET_PATH_BYTES, 'a'))).not.toThrow();
    expect(throwsCode(() => assertSocketPathLength('/tmp/'.padEnd(MAX_SOCKET_PATH_BYTES + 1, 'a')))).toBe(
      'SOCKET_PATH_TOO_LONG',
    );
  });
});

// ------------------------------------------------------------- the command set

describe('what the IPC surface accepts as a command', () => {
  it('refuses a real agent command by naming the missing pieces', () => {
    // Not UNKNOWN_COMMAND — that reads as a typo — and certainly not a reply.
    const error = caught(() => validateRunnerCommand('order.execute', {}));
    expect(error.code).toBe('NOT_IMPLEMENTED');
    expect(error.detail?.['missing']).toEqual(['executor', 'signer', 'reconciler']);
  });

  it('refuses a name that is in neither set', () => {
    expect(throwsCode(() => validateRunnerCommand('runner.stauts', {}))).toBe('UNKNOWN_COMMAND');
  });

  it('validates input against the contract package rather than a second validator', () => {
    expect(throwsCode(() => validateRunnerCommand('runner.job', {}))).toBe('INVALID_INPUT');
    expect(throwsCode(() => validateRunnerCommand('runner.jobs', { state: 'NOPE' }))).toBe(
      'INVALID_INPUT',
    );
    expect(throwsCode(() => validateRunnerCommand('runner.status', { extra: 1 }))).toBe(
      'INVALID_INPUT',
    );
  });

  it('returns the input unchanged, coercing nothing', () => {
    const input = { jobId: 'job_1' };
    expect(validateRunnerCommand('runner.job', input)).toEqual(input);
    expect(validateRunnerCommand('runner.status', undefined)).toEqual({});
  });

  it('lists only the runner-local commands', () => {
    expect(listRunnerIpcCommands()).toEqual([
      'runner.cancel-job',
      'runner.job',
      'runner.jobs',
      'runner.shutdown',
      'runner.status',
    ]);
  });
});

// ------------------------------------------------------------------ the socket

describe('the server', () => {
  let dir: TempRuntimeDir;
  let server: RunnerIpcServer | undefined;
  let socketPath: string;
  const open: RawSession[] = [];
  const clients: RunnerIpcClient[] = [];

  const options = (): RunnerIpcServerOptions => ({
    socketPath,
    token: TOKEN,
    instanceId: 'run_test',
    driving: false,
    handle: async (command, input) => {
      if (command === 'boom') throw new Error('the handler failed');
      if (command === 'slow') {
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      return { command, input };
    },
    toErrorBody,
  });

  const start = async (authTimeoutMs?: number): Promise<RunnerIpcServer> => {
    const started = new RunnerIpcServer(
      authTimeoutMs === undefined ? options() : { ...options(), authTimeoutMs },
    );
    await started.start();
    return started;
  };

  const peer = async (): Promise<RawSession> => {
    const session = await rawConnect(socketPath);
    open.push(session);
    return session;
  };

  beforeEach(() => {
    dir = tempRuntimeDir();
    socketPath = join(dir.dir, 'runner.sock');
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const session of open.splice(0)) session.destroy();
    await server?.stop();
    server = undefined;
    dir.cleanup();
  });

  it('answers a handshake and then a request', async () => {
    server = await start();
    const session = await peer();
    session.send(hello(TOKEN));

    expect(await session.next()).toEqual({
      v: RUNNER_IPC_PROTOCOL_VERSION,
      type: 'hello-ok',
      instanceId: 'run_test',
      // The field a client has to read before believing a strategy is running.
      driving: false,
    });

    session.send(requestLine('1', 'runner.status'));
    expect(await session.next()).toMatchObject({ type: 'response', id: '1', ok: true });
  });

  it('binds the socket private to its owner', async () => {
    server = await start();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir.dir).mode & 0o777).toBe(0o700);
  });

  it('closes the connection on a wrong token without quoting either token', async () => {
    server = await start();
    const session = await peer();
    const guess = 'a-guess-that-must-not-be-echoed';
    session.send(hello(guess));

    const frame = await session.next();
    expect(frame).toMatchObject({ id: UNSOLICITED_FRAME_ID, ok: false });
    expect(errorOf(frame).code).toBe('UNAUTHENTICATED');
    const serialized = JSON.stringify(frame);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(guess);

    // One attempt per connection: a peer that could guess repeatedly down one
    // socket would make the second factor a formality.
    await session.closed();
  });

  it('gives the same code whether the token was wrong or absent', async () => {
    server = await start();
    const absent = await peer();
    absent.send(`${JSON.stringify({ v: RUNNER_IPC_PROTOCOL_VERSION, type: 'hello' })}\n`);
    const wrong = await peer();
    wrong.send(hello('nope'));

    expect(errorOf(await absent.next()).code).toBe('UNAUTHENTICATED');
    expect(errorOf(await wrong.next()).code).toBe('UNAUTHENTICATED');
  });

  it('refuses a request that arrives before the handshake', async () => {
    server = await start();
    const session = await peer();
    session.send(requestLine('1', 'runner.status'));

    expect(errorOf(await session.next()).code).toBe('UNAUTHENTICATED');
    await session.closed();
  });

  it('refuses a second handshake on an authenticated connection', async () => {
    server = await start();
    const session = await peer();
    session.send(hello(TOKEN));
    await session.next();

    session.send(hello(TOKEN));
    expect(errorOf(await session.next()).code).toBe('MALFORMED_FRAME');
    await session.closed();
  });

  it('disconnects a peer speaking another protocol version', async () => {
    server = await start();
    const session = await peer();
    session.send(hello(TOKEN, 99));

    expect(errorOf(await session.next()).code).toBe('PROTOCOL_VERSION');
    await session.closed();
  });

  it('disconnects rather than resynchronizing after a malformed frame', async () => {
    server = await start();
    const session = await peer();
    session.send('this is not a frame\n');

    expect(errorOf(await session.next()).code).toBe('MALFORMED_FRAME');
    // Guessing where the next frame starts is how a request gets executed under
    // the wrong id, and the requests on this socket move money.
    await session.closed();
  });

  it('disconnects a peer that streams past the frame bound', async () => {
    server = await start();
    const session = await peer();
    session.send('x'.repeat(MAX_FRAME_BYTES + 1));

    expect(errorOf(await session.next()).code).toBe('FRAME_TOO_LARGE');
    await session.closed();
  });

  it('disconnects a connection that never authenticates', async () => {
    server = await start(20);
    const session = await peer();

    expect(errorOf(await session.next()).code).toBe('UNAUTHENTICATED');
    await session.closed();
  });

  it('keeps the session alive when a command fails', async () => {
    server = await start();
    const session = await peer();
    session.send(hello(TOKEN));
    await session.next();

    session.send(requestLine('1', 'boom'));
    const failure = await session.next();
    expect(failure).toMatchObject({ id: '1', ok: false });
    expect(errorOf(failure).code).toBe('INTERNAL');
    // No stack on the wire: it would add paths and internals to whatever reads
    // the reply, and a local peer already knows where the Runner lives.
    expect(JSON.stringify(failure)).not.toContain('.ts:');

    session.send(requestLine('2', 'runner.status'));
    expect(await session.next()).toMatchObject({ id: '2', ok: true });
  });

  it('answers pipelined requests in the order they arrived', async () => {
    server = await start();
    const session = await peer();
    session.send(hello(TOKEN));
    await session.next();

    // Both in one write, the slower one first. A client that pipelined a cancel
    // behind a status has every right to expect it to be evaluated after it.
    session.send(requestLine('1', 'slow') + requestLine('2', 'runner.status'));

    expect(await session.next()).toMatchObject({ id: '1' });
    expect(await session.next()).toMatchObject({ id: '2' });
  });

  it('takes over a socket file a dead Runner left behind', async () => {
    // Nothing is listening on it, so removing it cannot disconnect anyone.
    writeFileSync(socketPath, '', { mode: 0o600 });
    server = await start();

    const client = await RunnerIpcClient.connect({ socketPath, token: TOKEN });
    clients.push(client);
    expect(client.instanceId).toBe('run_test');
  });

  it('refuses to start on a socket a live Runner is using', async () => {
    server = await start();
    const second = new RunnerIpcServer({ ...options(), instanceId: 'run_second' });
    expect(await rejectsCode(second.start())).toBe('ADDRESS_IN_USE');
    await second.stop();
  });

  it('refuses a socket path the platform would truncate', async () => {
    const deep = mkdtempSync(join(tmpdir(), 'wx-run-'));
    try {
      const doomed = new RunnerIpcServer({
        ...options(),
        socketPath: join(deep, 'x'.repeat(MAX_SOCKET_PATH_BYTES), 'runner.sock'),
      });
      expect(await rejectsCode(doomed.start())).toBe('SOCKET_PATH_TOO_LONG');
    } finally {
      rmSync(deep, { recursive: true, force: true });
    }
  });
});

describe('the client', () => {
  let dir: TempRuntimeDir;
  let server: RunnerIpcServer | undefined;
  let socketPath: string;
  const clients: RunnerIpcClient[] = [];

  beforeEach(async () => {
    dir = tempRuntimeDir();
    socketPath = join(dir.dir, 'runner.sock');
    server = new RunnerIpcServer({
      socketPath,
      token: TOKEN,
      instanceId: 'run_test',
      driving: false,
      handle: async (command, input) => {
        if (command === 'boom') throw new RunnerIpcError('INVALID_INPUT', 'no', { command });
        if (command === 'hang') {
          await new Promise((resolve) => {
            // Unref'd: the test stops the server out from under it, and this must
            // not hold the event loop open afterwards.
            setTimeout(resolve, 60_000).unref();
          });
        }
        return { command, input };
      },
      toErrorBody,
    });
    await server.start();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server?.stop();
    server = undefined;
    dir.cleanup();
  });

  const connect = async (token = TOKEN): Promise<RunnerIpcClient> => {
    const client = await RunnerIpcClient.connect({ socketPath, token, client: 'vitest' });
    clients.push(client);
    return client;
  };

  it('learns the instance and whether it drives anything from the handshake', async () => {
    const client = await connect();
    expect(client.instanceId).toBe('run_test');
    expect(client.driving).toBe(false);
  });

  it('correlates replies to the requests that asked for them', async () => {
    const client = await connect();
    const [first, second] = await Promise.all([
      client.request('one', { n: 1 }),
      client.request('two', { n: 2 }),
    ]);
    expect(first).toEqual({ command: 'one', input: { n: 1 } });
    expect(second).toEqual({ command: 'two', input: { n: 2 } });
  });

  it('rebuilds a refusal as an error carrying its code', async () => {
    // A LEASE_LOST or an ILLEGAL_TRANSITION must not arrive as an anonymous
    // failure; the caller has to be able to branch on it.
    const client = await connect();
    expect(await rejectsCode(client.request('boom'))).toBe('INVALID_INPUT');
  });

  it('fails the handshake when the token is not accepted', async () => {
    expect(await rejectsCode(RunnerIpcClient.connect({ socketPath, token: 'wrong' }))).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('refuses to send on a connection it has closed', async () => {
    const client = await connect();
    client.close();
    expect(await rejectsCode(client.request('runner.status'))).toBe('CONNECTION_CLOSED');
  });

  it('fails everything in flight when the Runner goes away', async () => {
    const client = await connect();
    const pending = client.request('hang');
    await server?.stop();
    server = undefined;
    // No reconnect, deliberately: a client that reconnected silently could
    // believe a strategy was monitored across a gap in which nothing was.
    expect(await rejectsCode(pending)).toBe('CONNECTION_CLOSED');
  });

  it('gives up on a socket that never answers the handshake', async () => {
    const quiet = join(dir.dir, 'quiet.sock');
    const accepted: Socket[] = [];
    const silent = createServer((socket) => {
      // Accept, and say nothing. Held so the test can hang up on it: this socket
      // is never resumed, so it would not notice its peer going away.
      accepted.push(socket);
    });
    await new Promise<void>((resolve) => {
      silent.listen(quiet, resolve);
    });
    try {
      expect(
        await rejectsCode(
          RunnerIpcClient.connect({ socketPath: quiet, token: TOKEN, timeoutMs: 30 }),
        ),
      ).toBe('TIMEOUT');
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => {
        silent.close(() => {
          resolve();
        });
      });
    }
  });
});
