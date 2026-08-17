/**
 * The Unix domain socket the CLI and adapters call the Runner on.
 *
 * The reason this exists at all is custody: the plan (§6.4) keeps the signer and
 * the long-lived job state inside one process so that every agent subprocess does
 * *not* need a private key. That only holds if reaching this socket is as hard as
 * being the owner, so authentication is two independent facts:
 *
 * 1. The socket lives in a `0700` directory owned by this uid (`runtime-dir.ts`).
 *    Node exposes no peer credentials, so this — not a check on the connection —
 *    is what keeps another local account out.
 * 2. Every connection must present the bearer token minted at start, compared in
 *    constant time. One authentication failure closes the connection: a peer that
 *    could guess repeatedly down one socket would turn the second factor into a
 *    formality.
 *
 * A connection that misbehaves is disconnected rather than corrected. Resyncing a
 * stream after a malformed frame means guessing where the next one starts, and
 * the requests on this socket move money.
 */
import { chmodSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

import {
  decodeClientFrame,
  encodeFrame,
  FrameReader,
  isRunnerIpcError,
  RUNNER_IPC_PROTOCOL_VERSION,
  RunnerIpcError,
  tokensMatch,
  UNSOLICITED_FRAME_ID,
  type ResponseErrorBody,
  type ServerFrame,
} from './protocol.ts';
import { assertSocketPathLength, assertUnixPlatform, SECRET_FILE_MODE } from './runtime-dir.ts';

export interface RunnerIpcServerOptions {
  readonly socketPath: string;
  /** Minted by the daemon. Never logged and never included in an error body. */
  readonly token: string;
  readonly instanceId: string;
  readonly driving: boolean;
  readonly handle: (command: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** Maps a thrown value onto the wire error body. */
  readonly toErrorBody: (error: unknown) => ResponseErrorBody;
  /** How long an unauthenticated connection may stay open. */
  readonly authTimeoutMs?: number;
  readonly maxConnections?: number;
  readonly onError?: (error: unknown, context: string) => void;
}

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 32;

/** Probes an existing socket file: is something actually listening on it? */
const isSocketLive = async (socketPath: string): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const probe = createConnection(socketPath);
    const settle = (live: boolean): void => {
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => {
      settle(true);
    });
    probe.once('error', () => {
      // ECONNREFUSED on a socket file means the process that bound it is gone.
      settle(false);
    });
    probe.setTimeout(500, () => {
      // Cannot tell. Assume live: unlinking a socket a running Runner is using
      // would silently disconnect it from every client, which is worse than
      // refusing to start.
      settle(true);
    });
  });

export class RunnerIpcServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private closing = false;

  constructor(private readonly options: RunnerIpcServerOptions) {}

  get socketPath(): string {
    return this.options.socketPath;
  }

  async start(): Promise<void> {
    assertUnixPlatform();
    assertSocketPathLength(this.options.socketPath);

    const server = createServer({ allowHalfOpen: false }, (socket) => {
      this.accept(socket);
    });
    server.maxConnections = this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.server = server;

    try {
      await this.listen(server);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      if (await isSocketLive(this.options.socketPath)) {
        throw new RunnerIpcError(
          'ADDRESS_IN_USE',
          `another Runner is already listening on ${this.options.socketPath}`,
          { socketPath: this.options.socketPath },
        );
      }
      // A socket file left behind by a Runner that died. Nothing is listening, so
      // removing it cannot disconnect anyone.
      unlinkSync(this.options.socketPath);
      await this.listen(server);
    }

    // Defence in depth. The `0700` parent directory is what actually keeps other
    // uids out — `listen` creates the socket under the process umask, so there is
    // a window before this chmod in which the file itself is group-readable, and
    // the directory is what closes that window.
    chmodSync(this.options.socketPath, SECRET_FILE_MODE);
  }

  async stop(): Promise<void> {
    this.closing = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      // Node unlinks the socket path itself on close; doing it here as well could
      // remove a socket a newly started Runner had just bound.
      server.close(() => {
        resolve();
      });
    });
  }

  private async listen(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.socketPath);
    });
  }

  private accept(socket: Socket): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setEncoding('utf8');

    const reader = new FrameReader();
    let authenticated = false;
    // Requests are answered in the order they arrived on this connection. The
    // store's guarantees are per-transaction, not per-connection, and a client
    // that pipelined a cancel behind a status has every right to expect the
    // cancel to be evaluated after it.
    let queue: Promise<void> = Promise.resolve();

    const authTimer = setTimeout(() => {
      fail(
        new RunnerIpcError('UNAUTHENTICATED', 'the connection did not authenticate in time'),
      );
    }, this.options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
    authTimer.unref();

    const send = (frame: ServerFrame): void => {
      if (socket.destroyed) return;
      try {
        socket.write(encodeFrame(frame));
      } catch (error) {
        this.options.onError?.(error, 'ipc write');
        socket.destroy();
      }
    };

    const fail = (error: unknown): void => {
      send({
        v: RUNNER_IPC_PROTOCOL_VERSION,
        type: 'response',
        id: UNSOLICITED_FRAME_ID,
        ok: false,
        error: this.options.toErrorBody(error),
      });
      socket.destroy();
    };

    const cleanup = (): void => {
      clearTimeout(authTimer);
      this.sockets.delete(socket);
    };

    socket.on('error', (error) => {
      this.options.onError?.(error, 'ipc socket');
      cleanup();
      socket.destroy();
    });
    socket.on('close', cleanup);

    socket.on('data', (chunk: string) => {
      let lines: readonly string[];
      try {
        lines = reader.push(chunk);
      } catch (error) {
        fail(error);
        return;
      }

      for (const line of lines) {
        queue = queue.then(async () => {
          if (socket.destroyed) return;
          let frame;
          try {
            frame = decodeClientFrame(line);
          } catch (error) {
            fail(error);
            return;
          }

          if (frame.type === 'hello') {
            if (authenticated) {
              fail(new RunnerIpcError('MALFORMED_FRAME', 'the connection is already authenticated'));
              return;
            }
            if (!tokensMatch(this.options.token, frame.token)) {
              // One code, one attempt, one connection. The message never repeats
              // the presented token: an error that quoted it would write a
              // credential into whatever log read the reply.
              fail(new RunnerIpcError('UNAUTHENTICATED', 'the handshake token was not accepted'));
              return;
            }
            authenticated = true;
            clearTimeout(authTimer);
            send({
              v: RUNNER_IPC_PROTOCOL_VERSION,
              type: 'hello-ok',
              instanceId: this.options.instanceId,
              driving: this.options.driving,
            });
            return;
          }

          if (!authenticated) {
            fail(new RunnerIpcError('UNAUTHENTICATED', 'a request arrived before the handshake'));
            return;
          }

          try {
            const result = await this.options.handle(frame.command, frame.input);
            send({
              v: RUNNER_IPC_PROTOCOL_VERSION,
              type: 'response',
              id: frame.id,
              ok: true,
              result,
            });
          } catch (error) {
            if (!isRunnerIpcError(error)) this.options.onError?.(error, `command ${frame.command}`);
            // A failed command is not a failed connection: the client keeps its
            // session and can ask something else.
            send({
              v: RUNNER_IPC_PROTOCOL_VERSION,
              type: 'response',
              id: frame.id,
              ok: false,
              error: this.options.toErrorBody(error),
            });
          }
        });
      }
    });
  }
}
