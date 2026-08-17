/**
 * The native execution stream: the official Socket.IO client wired to the
 * server's private agent namespace.
 *
 * WHY A DEPENDENCY AT ALL. This package had none, and that was worth keeping
 * right up to the point where it cost a core feature. The server's stream is
 * Socket.IO — a framed protocol over an engine.io transport with its own
 * handshake, upgrade and reconnect semantics — and a hand-rolled `ws` client
 * would be a second, worse implementation of a protocol that already has a
 * maintained official one. `socket.io-client` is that client, published by the
 * same project as the server library the backend runs. It is loaded LAZILY
 * (`await import`) so a caller that never streams never pays for it, and it is
 * reached only through {@link StreamConnector}, so every test in this package
 * still runs without a socket.
 *
 * WHAT A STREAM IS FOR HERE, precisely: it saves REQUESTS, not milliseconds.
 * The server publishes frames from a transactional outbox on a ~5 s dispatcher
 * tick, so a frame can arrive later than a 1 s REST poll would have. That is why
 * the wait loop keeps its poll interval as a floor and confirms every terminal
 * state over REST. Nothing here is ever the answer.
 *
 * THE THREE THINGS THAT MAKE IT CORRECT rather than merely connected:
 *  - CURSOR. Every frame carries a per-agent monotonic cursor. The last one seen
 *    is sent back in the next handshake, and the server replays exactly what was
 *    missed. The cursor only ever moves forward, so a replayed older frame can
 *    never rewind the resume point.
 *  - GAP. When the missed window is longer than the server's replay bound it
 *    says `gap: true` and serves NOTHING, rather than catching us up silently.
 *    A gap — and a plain reconnect, which loses frames just as quietly — wakes
 *    every waiter so it re-reads over REST.
 *  - GIVING UP. A server that refuses the handshake will keep refusing it.
 *    After a bounded number of refusals the socket is closed for good and the
 *    caller's REST poll carries the wait, because a login loop against a server
 *    that has already answered is worse than polling.
 */
import {
  PREDICT_AGENT_STREAM_NAMESPACE,
  PREDICT_EXECUTION_STREAM,
  PREDICT_STREAM_READY,
} from './contract.ts';

/**
 * A push source for execution state (spec §16.2), so a wait costs one connection
 * instead of one request per second per execution.
 *
 * A SEAM as well as a shipped implementation: {@link SocketExecutionStream} is
 * the official one, and a caller with its own transport can still supply
 * anything satisfying this interface. Without either, waits poll.
 *
 * Two properties any adapter MUST preserve, because the wait logic relies on them:
 *  - frames may be LOST. The server's ready frame carries `gap: true` when the
 *    replay cursor was too old, and a dropped connection loses frames silently.
 *    So a stream can only ever ACCELERATE a wait, never be its sole source of
 *    truth — `waitForExecution` still confirms over REST before returning.
 *  - `onExecutionUpdate` must not throw; a listener error must not strand a wait.
 */
export interface ExecutionStream {
  /**
   * Invoke `listener` whenever this execution may have moved. The payload is a
   * hint, not a value: an adapter that knows only "something changed" may call
   * with no argument. Returns an unsubscribe function.
   */
  onExecutionUpdate(executionId: string, listener: () => void): () => void;
}

/** What the handshake tells the server. Both fields are read per connection. */
export interface StreamHandshake {
  token: string;
  /** Last processed cursor. Omitted on a fresh session, which starts from now. */
  cursor?: string;
}

/**
 * The slice of a Socket.IO socket this client uses. Deliberately tiny: it is
 * what makes the stream testable without a server, and what keeps the dependency
 * behind one seam.
 */
export interface StreamSocket {
  on(event: string, listener: (payload: unknown) => void): void;
  disconnect(): void;
}

export interface StreamConnectOptions {
  /** Absolute URL, namespace path included. */
  url: string;
  /**
   * Builds the handshake. Called before EVERY connection attempt, including
   * every reconnect — that is how a token minted since the socket dropped, and a
   * cursor advanced since it connected, actually reach the server.
   */
  handshake: () => Promise<StreamHandshake>;
}

export type StreamConnector = (
  options: StreamConnectOptions,
) => StreamSocket | Promise<StreamSocket>;

export interface SocketExecutionStreamOptions {
  /** The same base URL the REST client uses; the namespace path is appended. */
  baseUrl: string;
  /** The bearer token for the handshake. See {@link StreamConnectOptions.handshake}. */
  token: () => Promise<string>;
  /**
   * Replace a token the server refused at the handshake. Returning `undefined`
   * means this session may not re-authenticate, and the last token is tried once
   * more before the failure budget runs out.
   */
  refreshToken?: (rejected: string) => Promise<string | undefined>;
  /** Resume from a persisted cursor instead of starting at "now". */
  cursor?: string;
  /**
   * Called each time the cursor advances. Persist it to make a restart replay
   * exactly the window it missed; without it the cursor lives and dies with this
   * object, and a restart starts from now.
   */
  onCursor?: (cursor: string) => void;
  /**
   * Called once when the stream stops trying, with the reason. The wait itself is
   * unaffected — it polls — but a long-lived caller deserves to know it lost the
   * accelerator rather than quietly paying for polling forever.
   */
  onDegraded?: (reason: string) => void;
  /** Consecutive handshake refusals tolerated before giving up. Default 3. */
  maxHandshakeFailures?: number;
  /**
   * Hold the socket open this long after the last listener unsubscribes, so
   * back-to-back waits reuse one connection.
   *
   * Default 0 — disconnect immediately. A connected socket keeps the event loop
   * alive, and a one-shot CLI that exits the moment its trade settles is worth
   * more than a saved handshake. Raise it in a long-lived strategy.
   */
  idleDisconnectMs?: number;
  /** Injectable transport. Defaults to the official `socket.io-client`. */
  connect?: StreamConnector;
}

const DEFAULT_MAX_HANDSHAKE_FAILURES = 3;

/** Handshake refusals the gateway sends before disconnecting. */
const TOKEN_REFUSALS = new Set(['invalid_token', 'missing_token']);

export class SocketExecutionStream implements ExecutionStream {
  private readonly url: string;
  private readonly getToken: () => Promise<string>;
  private readonly refreshToken: ((rejected: string) => Promise<string | undefined>) | undefined;
  private readonly onCursor: ((cursor: string) => void) | undefined;
  private readonly onDegraded: ((reason: string) => void) | undefined;
  private readonly maxHandshakeFailures: number;
  private readonly idleDisconnectMs: number;
  private readonly connector: StreamConnector;

  private readonly listeners = new Map<string, Set<() => void>>();
  private socket: StreamSocket | undefined;
  private opening: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  private cursorValue: string | undefined;
  private issuedToken: string | undefined;
  private refreshBeforeNextHandshake = false;
  private handshakeFailures = 0;
  /** Whether a ready frame has EVER arrived — a second one means a reconnect. */
  private everReady = false;
  private degraded = false;
  private closed = false;

  constructor(options: SocketExecutionStreamOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, '')}${PREDICT_AGENT_STREAM_NAMESPACE}`;
    this.getToken = options.token;
    this.refreshToken = options.refreshToken;
    this.cursorValue = options.cursor;
    this.onCursor = options.onCursor;
    this.onDegraded = options.onDegraded;
    this.maxHandshakeFailures = options.maxHandshakeFailures ?? DEFAULT_MAX_HANDSHAKE_FAILURES;
    this.idleDisconnectMs = options.idleDisconnectMs ?? 0;
    this.connector = options.connect ?? nativeConnector;
  }

  /**
   * The last cursor processed, for a caller that checkpoints on its own schedule.
   * `undefined` means nothing has been seen yet and a reconnect would start from
   * now rather than replaying.
   */
  get cursor(): string | undefined {
    return this.cursorValue;
  }

  /** True once the stream has stopped trying. The wait still works; it polls. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  onExecutionUpdate(executionId: string, listener: () => void): () => void {
    if (this.closed) return () => undefined;
    this.clearIdleTimer();
    let group = this.listeners.get(executionId);
    if (group === undefined) {
      group = new Set();
      this.listeners.set(executionId, group);
    }
    group.add(listener);
    this.ensureConnected();

    let active = true;
    return () => {
      // Idempotent: a wait that unsubscribes twice must not evict a listener some
      // later wait registered for the same execution.
      if (!active) return;
      active = false;
      const current = this.listeners.get(executionId);
      current?.delete(listener);
      if (current !== undefined && current.size === 0) this.listeners.delete(executionId);
      if (this.listeners.size === 0) this.scheduleIdleDisconnect();
    };
  }

  /**
   * Release the socket and forget every listener. Safe to call more than once,
   * and safe to call while a connection attempt is still in flight — the socket
   * that attempt produces is disconnected on arrival rather than leaked.
   */
  close(): void {
    this.closed = true;
    this.clearIdleTimer();
    this.listeners.clear();
    this.disconnectSocket();
  }

  private ensureConnected(): void {
    if (this.closed || this.degraded) return;
    if (this.socket !== undefined || this.opening !== undefined) return;
    // A connection that cannot be established is not a failed wait: the caller's
    // poll interval is still a floor on liveness, so this degrades to REST rather
    // than rejecting into a trade.
    this.opening = this.open()
      .catch((error: unknown) => {
        this.giveUp(`stream transport unavailable: ${describe(error)}`);
      })
      .finally(() => {
        this.opening = undefined;
      });
  }

  private async open(): Promise<void> {
    const socket = await this.connector({
      url: this.url,
      handshake: async () => await this.buildHandshake(),
    });
    // The connector takes at least a tick (the native one loads a module). If the
    // last waiter left, or the stream was closed, in that window, this socket has
    // no owner and must not be kept.
    if (this.closed || this.listeners.size === 0) {
      disconnectQuietly(socket);
      return;
    }
    this.socket = socket;
    socket.on(PREDICT_STREAM_READY, (payload) => {
      this.handleReady(payload);
    });
    socket.on(PREDICT_EXECUTION_STREAM, (payload) => {
      this.handleFrame(payload);
    });
    // The gateway emits this and then disconnects when it refuses a handshake.
    // Transport-level failures arrive as `connect_error` instead and are left to
    // socket.io's own backoff — a network blip must not burn the failure budget
    // reserved for credentials the server has actually rejected.
    socket.on('error', (payload) => {
      this.handleServerError(payload);
    });
  }

  private async buildHandshake(): Promise<StreamHandshake> {
    let token: string | undefined;
    if (this.refreshBeforeNextHandshake) {
      this.refreshBeforeNextHandshake = false;
      // Replace the credential BEFORE reconnecting. Reconnecting with the token
      // the server just refused would spend the failure budget on a guaranteed no.
      token = await this.refreshToken?.(this.issuedToken ?? '');
    }
    token ??= await this.getToken();
    this.issuedToken = token;
    return {
      token,
      ...(this.cursorValue !== undefined ? { cursor: this.cursorValue } : {}),
    };
  }

  private handleReady(payload: unknown): void {
    const frame = asReadyFrame(payload);
    // A completed handshake proves the credential works; the budget is for
    // consecutive refusals, not for a lifetime total.
    this.handshakeFailures = 0;
    const reconnected = this.everReady;
    this.everReady = true;
    // On a gap the server echoes the cursor we sent (it served nothing), so this
    // is a no-op there and the stale cursor is deliberately kept: forgetting it
    // would turn an unreconciled gap into a silent one if this process died next.
    this.advanceCursor(frame.cursor);
    // A gap says outright that frames were dropped. A reconnect says nothing, but
    // loses them just as easily. Both are answered by waking every waiter, which
    // re-reads over REST — the only authority there has ever been.
    if (frame.gap || reconnected) this.notifyAll();
  }

  private handleFrame(payload: unknown): void {
    const frame = asExecutionFrame(payload);
    if (frame === undefined) return;
    // Checkpoint before notifying: a listener that throws must not cost us the
    // resume point for a frame that did arrive.
    this.advanceCursor(frame.cursor);
    this.notify(frame.executionId);
  }

  private handleServerError(payload: unknown): void {
    const reason = readReason(payload);
    if (TOKEN_REFUSALS.has(reason)) this.refreshBeforeNextHandshake = true;
    this.handshakeFailures += 1;
    if (this.handshakeFailures >= this.maxHandshakeFailures) {
      this.giveUp(`stream handshake refused ${String(this.handshakeFailures)}x: ${reason}`);
    }
  }

  /**
   * Move the resume point forward, never back. A replay overlaps by design and a
   * malformed cursor is not a cursor — either one becoming the resume point would
   * make the next reconnect ask for a window that does not exist.
   */
  private advanceCursor(next: string): void {
    if (!/^\d+$/.test(next)) return;
    if (this.cursorValue !== undefined && BigInt(next) <= BigInt(this.cursorValue)) return;
    this.cursorValue = next;
    try {
      this.onCursor?.(next);
    } catch {
      // A caller's persistence failing must not tear down the socket mid-trade.
      // The in-memory cursor still advanced, so this session stays correct; only
      // a restart loses the checkpoint.
    }
  }

  private notify(executionId: string): void {
    for (const listener of this.listeners.get(executionId) ?? []) {
      invoke(listener);
    }
  }

  private notifyAll(): void {
    for (const group of this.listeners.values()) {
      for (const listener of group) invoke(listener);
    }
  }

  private giveUp(reason: string): void {
    if (this.degraded) return;
    this.degraded = true;
    this.disconnectSocket();
    try {
      this.onDegraded?.(reason);
    } catch {
      /* an observer's failure is not the stream's */
    }
  }

  private scheduleIdleDisconnect(): void {
    this.clearIdleTimer();
    if (this.socket === undefined && this.opening === undefined) return;
    if (this.idleDisconnectMs <= 0) {
      this.disconnectSocket();
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.listeners.size === 0) this.disconnectSocket();
    }, this.idleDisconnectMs);
    // Never hold the process open for a socket nobody is waiting on.
    timer.unref?.();
    this.idleTimer = timer;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private disconnectSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    // `everReady` is NOT reset: the next ready frame is a reconnect, and a
    // reconnect must reconcile.
    if (socket !== undefined) disconnectQuietly(socket);
  }
}

/**
 * The shipped transport.
 *
 * Loaded on demand: importing `socket.io-client` costs a caller who only ever
 * places market orders nothing, and a runtime that pruned the dependency gets a
 * degraded stream instead of a module-load crash.
 */
const nativeConnector: StreamConnector = async ({ url, handshake }) => {
  const { io } = await import('socket.io-client');
  const socket = io(url, {
    // WebSocket only. The server fans out per-pod with no Socket.IO Redis
    // adapter, so HTTP long-polling without sticky sessions would land the
    // upgrade on a different pod from the one holding the room.
    transports: ['websocket'],
    // Everything the server needs is in the handshake — it names the room from
    // the verified JWT and there is no subscribe message to send. socket.io calls
    // this function again on every reconnect, which is exactly when a refreshed
    // token and an advanced cursor need to be re-read.
    auth: (callback: (data: Record<string, unknown>) => void) => {
      void handshake().then(
        (data) => {
          callback({ ...data });
        },
        () => {
          // Sent empty on purpose: the server refuses it with a reason this
          // client counts, rather than the socket silently never connecting.
          callback({});
        },
      );
    },
  });
  // socket.io types `on` as a generic over its reserved-event map, which cannot
  // be checked structurally against a plain `(event: string, …)` signature. The
  // cast is confined to this line, which is why StreamSocket is as small as it is.
  return socket as unknown as StreamSocket;
};

function invoke(listener: () => void): void {
  try {
    listener();
  } catch {
    // Documented on ExecutionStream: one listener throwing must not strand the
    // waits behind it, and must not kill the socket.
  }
}

function disconnectQuietly(socket: StreamSocket): void {
  try {
    socket.disconnect();
  } catch {
    // Tearing down a socket that is already gone is not a failure worth raising
    // into a caller whose trade has already settled.
  }
}

/** A frame is only usable if the fields the wait keys on are actually strings. */
function asExecutionFrame(payload: unknown): { cursor: string; executionId: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const frame = payload as { cursor?: unknown; executionId?: unknown };
  if (typeof frame.cursor !== 'string' || typeof frame.executionId !== 'string') return undefined;
  if (frame.executionId === '') return undefined;
  return { cursor: frame.cursor, executionId: frame.executionId };
}

/**
 * Any ready event counts as a handshake completing — that is what the event name
 * means, and dropping an unparseable one would lose the reconnect that produced
 * it. Only the fields are read defensively, and `gap` defaults to TRUE when the
 * server did not say: an unreadable ready frame is not evidence of being caught
 * up, and the cost of a wrong "no gap" is a strategy acting on state it never
 * received.
 */
function asReadyFrame(payload: unknown): { cursor: string; gap: boolean } {
  const frame = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    cursor?: unknown;
    gap?: unknown;
  };
  return {
    // Not a cursor, so `advanceCursor` rejects it and the resume point stands.
    cursor: typeof frame.cursor === 'string' ? frame.cursor : '',
    gap: frame.gap !== false,
  };
}

function readReason(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return 'unknown';
  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason !== '' ? reason : 'unknown';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
