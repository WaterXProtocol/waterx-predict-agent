/**
 * The other end of the socket.
 *
 * This is what the CLI will use for `runner status` and what the tests use to
 * prove the server's rules. It is deliberately small: it does not retry, does not
 * reconnect, and does not queue across a disconnect. A Runner that went away is a
 * fact the caller has to see — reconnecting silently would let a client believe a
 * strategy is monitored across a gap in which nothing was.
 */
import { createConnection, type Socket } from 'node:net';

import {
  decodeServerFrame,
  encodeFrame,
  FrameReader,
  RUNNER_IPC_PROTOCOL_VERSION,
  RunnerIpcError,
  UNSOLICITED_FRAME_ID,
  type ResponseErrorBody,
} from './protocol.ts';

export interface RunnerIpcClientOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly client?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export class RunnerIpcClient {
  private readonly pending = new Map<string, Pending>();
  private readonly reader = new FrameReader();
  private nextId = 1;
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    readonly instanceId: string,
    readonly driving: boolean,
  ) {}

  static async connect(options: RunnerIpcClientOptions): Promise<RunnerIpcClient> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const socket = createConnection(options.socketPath);
    socket.setEncoding('utf8');

    const handshake = new Promise<{ instanceId: string; driving: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new RunnerIpcError('TIMEOUT', `no handshake from ${options.socketPath} in time`));
      }, timeoutMs);
      timer.unref();

      const reader = new FrameReader();
      const onData = (chunk: string): void => {
        let lines: readonly string[];
        try {
          lines = reader.push(chunk);
        } catch (error) {
          clearTimeout(timer);
          socket.destroy();
          reject(error);
          return;
        }
        const line = lines[0];
        if (line === undefined) return;
        clearTimeout(timer);
        socket.removeListener('data', onData);
        // Paused before resolving: a stream left flowing with no `data` listener
        // discards what arrives, and the frames after the handshake are replies
        // this client is about to be asked for.
        socket.pause();
        try {
          const frame = decodeServerFrame(line);
          if (frame.type === 'hello-ok') {
            resolve({ instanceId: frame.instanceId, driving: frame.driving });
            return;
          }
          reject(toError(frame.ok ? { code: 'INTERNAL', message: 'unexpected frame' } : frame.error));
        } catch (error) {
          reject(error);
        }
        socket.destroy();
      };

      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('data', onData);
      socket.on('connect', () => {
        socket.write(
          encodeFrame({
            v: RUNNER_IPC_PROTOCOL_VERSION,
            type: 'hello',
            token: options.token,
            ...(options.client === undefined ? {} : { client: options.client }),
          }),
        );
      });
    });

    const { instanceId, driving } = await handshake;
    const client = new RunnerIpcClient(socket, instanceId, driving);
    client.listen();
    return client;
  }

  async request(
    command: string,
    input: Readonly<Record<string, unknown>> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed) throw new RunnerIpcError('CONNECTION_CLOSED', 'the IPC connection is closed');
    const id = String(this.nextId++);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RunnerIpcError('TIMEOUT', `no reply to ${command} in time`, { command }));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.write(
        encodeFrame({ v: RUNNER_IPC_PROTOCOL_VERSION, type: 'request', id, command, input }),
      );
    });
  }

  close(): void {
    this.closed = true;
    this.rejectAll(new RunnerIpcError('CONNECTION_CLOSED', 'the IPC connection was closed locally'));
    this.socket.destroy();
  }

  private listen(): void {
    this.socket.on('data', (chunk: string) => {
      let lines: readonly string[];
      try {
        lines = this.reader.push(chunk);
      } catch (error) {
        this.rejectAll(error);
        this.socket.destroy();
        return;
      }
      for (const line of lines) {
        let frame;
        try {
          frame = decodeServerFrame(line);
        } catch (error) {
          this.rejectAll(error);
          this.socket.destroy();
          return;
        }
        if (frame.type !== 'response') continue;
        if (frame.id === UNSOLICITED_FRAME_ID) {
          // The connection failed, not one request. Everything in flight is now
          // unanswerable, and pretending otherwise would strand a caller.
          this.rejectAll(frame.ok ? new Error('unexpected frame') : toError(frame.error));
          this.socket.destroy();
          return;
        }
        const pending = this.pending.get(frame.id);
        if (pending === undefined) continue;
        this.pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(toError(frame.error));
      }
    });

    this.socket.on('close', () => {
      this.closed = true;
      this.rejectAll(new RunnerIpcError('CONNECTION_CLOSED', 'the Runner closed the connection'));
    });
    this.socket.on('error', (error) => {
      this.rejectAll(error);
    });
    this.socket.resume();
  }

  private rejectAll(error: unknown): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

/**
 * Rebuilds the server's refusal as an error the caller can branch on. The code
 * survives the wire — a `LEASE_LOST` or an `ILLEGAL_TRANSITION` must not arrive
 * as an anonymous failure.
 */
const toError = (body: ResponseErrorBody): RunnerIpcError =>
  new RunnerIpcError(
    body.code as RunnerIpcError['code'],
    body.message,
    body.detail === undefined ? undefined : body.detail,
  );
