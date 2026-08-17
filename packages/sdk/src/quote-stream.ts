/**
 * Where prices come from: the `PriceWatcher` seam, the native quote stream, and
 * the watcher that puts one behind the other.
 *
 * WHAT THIS FEED IS. The server publishes indicative top-of-book prices on the
 * same authenticated agent namespace as the execution stream, as a STATE feed:
 * a SNAPSHOT on every subscribe, an UPDATE only when a price actually moved, and
 * a 15 s heartbeat carrying each topic's sequence and staleness. Nothing durable
 * is written per tick, so — unlike the execution stream — there is NO replay. The
 * snapshot IS the recovery, which is why a resumed subscription answers with
 * `gap: true` rather than a catch-up that cannot exist.
 *
 * WHAT IT BUYS, precisely: REQUESTS, not milliseconds. WaterX receives no upstream
 * push; a publisher writes into a cache on its own cadence and the server re-reads
 * that cache every `freshness.pollIntervalMs` (~2 s). A streamed price can
 * therefore be older than a fresh `POST /quotes` would be. What it replaces is one
 * quote mint per tick per watched market — and a quote is a priced, executable
 * artifact, so minting one every second merely to look at a number is the wasteful
 * thing this removes.
 *
 * WHAT IT IS NEVER: an order price. Every frame carries `INDICATIVE_ONLY`, and
 * {@link QuoteStreamPriceWatcher} feeds only the TRIGGER half of
 * `waitForPriceAndExecute`. The fresh executable quote and the re-check against
 * the target still happen before anything is submitted — see `client.ts`.
 *
 * THE FOUR THINGS THAT MAKE THE CLIENT CORRECT rather than merely connected:
 *  - SEQUENCE. `seq` is monotonic per (connection, topic) from 1. A break in it
 *    means frames were dropped on a live connection, and it is reported. It is
 *    NOT an address into history and is never persisted — on another connection
 *    it means nothing at all.
 *  - RECONNECT. A new connection restarts every sequence, so every held topic is
 *    re-subscribed with `resume: true` and the answering snapshot is treated as
 *    the whole recovery. Cached prices are invalidated first: we were away, and
 *    this feed cannot say what moved while we were.
 *  - HEARTBEAT. A quiet market and a dead socket look identical without one. Two
 *    missed heartbeats invalidate every cached price and rebuild the connection;
 *    a bounded number of silent windows in a row gives up to REST polling.
 *  - GIVING UP. A server that refuses the handshake keeps refusing it. After a
 *    bounded number of refusals the socket closes for good and the price wait
 *    falls back to `POST /quotes`, because a login loop is worse than polling.
 */
import {
  PREDICT_AGENT_STREAM_NAMESPACE,
  PREDICT_QUOTE_HEARTBEAT,
  PREDICT_QUOTE_STREAM,
  PREDICT_QUOTE_STREAM_HEARTBEAT_MS,
  PREDICT_QUOTE_SUBSCRIBE,
  PREDICT_QUOTE_SUBSCRIPTION,
  PREDICT_QUOTE_UNSUBSCRIBE,
  PREDICT_STREAM_READY,
  type CreateQuoteRequestBody,
  type PredictOutcomeId,
  type PredictQuoteRejectionReason,
  type PredictQuoteStreamFrame,
  type PredictQuoteSubscribeMessage,
  type PredictQuoteTopic,
  type PredictSide,
} from './contract.ts';
import { sleep } from './sleep.ts';
import type { StreamConnectOptions, StreamHandshake } from './execution-stream.ts';

/* ── The price-observation seam ───────────────────────────────────────────── */

/**
 * How `waitForPriceAndExecute` observes prices.
 *
 * Only `currentPrice` is required, and the default implementation polls
 * `POST /quotes` — the price source every agent can reach. The two optional
 * members exist so a PUSH source can replace the sampling loop's sleep without
 * the trigger logic knowing what a socket is:
 *
 *  - `watch` brackets one wait, so a subscription's lifetime is the wait's
 *    lifetime and nothing is left registered after it returns or throws;
 *  - `waitForChange` resolves early when the price may have moved, turning the
 *    caller's poll interval from a period into a CEILING.
 *
 * Two properties any implementation MUST preserve, because the trigger relies on
 * them:
 *  - `currentPrice` returns `null` for "no price right now", never a stale one.
 *    A cached push value must be invalidated the moment its source can no longer
 *    prove the feed is live — that is what {@link SocketQuoteStream}'s heartbeat
 *    watchdog is for.
 *  - whatever it returns is a TRIGGER. It is never the price an order is built
 *    on; the caller re-quotes and re-checks before submitting.
 */
export interface PriceWatcher {
  /** The current side-appropriate price, or null when there is none right now. */
  currentPrice(request: CreateQuoteRequestBody, signal?: AbortSignal): Promise<string | null>;
  /**
   * Begin observing one topic. Returns a release function the caller invokes
   * exactly once when the wait ends, however it ends. Optional: a watcher that
   * only polls needs no lifetime.
   */
  watch?(request: CreateQuoteRequestBody): () => void;
  /**
   * Resolve as soon as the price may have moved, or after `timeoutMs`, or on
   * abort — whichever comes first. Optional: without it the caller sleeps out its
   * full poll interval.
   */
  waitForChange?(
    request: CreateQuoteRequestBody,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void>;
}

/* ── The quote-stream seam ────────────────────────────────────────────────── */

/**
 * Why a cached price stopped being usable.
 *
 * The six `PredictQuoteRejectionReason` values are the server's per-topic
 * refusals; the three below are this client's own findings. `MARKET_CLOSED` is
 * terminal for the round and `NOT_QUOTABLE` is temporary — a strategy pauses on
 * the second and stops on the first, never the other way round.
 */
export type QuoteUnavailableReason =
  | PredictQuoteRejectionReason
  /** Frames were dropped. The next frame is current state, but a move was missed. */
  | 'GAP'
  /** The connection was lost or went silent. Nothing cached survives it. */
  | 'DISCONNECTED'
  /** The stream gave up. Prices now come from REST for the rest of this process. */
  | 'DEGRADED';

export type QuoteStreamEvent =
  | { type: 'FRAME'; frame: PredictQuoteStreamFrame }
  | { type: 'UNAVAILABLE'; reason: QuoteUnavailableReason };

export type QuoteListener = (event: QuoteStreamEvent) => void;

/**
 * A push source for indicative prices (spec §16.1).
 *
 * A SEAM as well as a shipped implementation: {@link SocketQuoteStream} is the
 * official one, and a caller with its own transport can supply anything
 * satisfying this interface.
 *
 * The obligation an adapter takes on, and the one that matters: emit
 * `UNAVAILABLE` whenever it can no longer prove the feed is live. This is a
 * change-only feed, so a quiet market is indistinguishable from a dead socket by
 * frame arrival alone — a consumer therefore trusts the last frame until told
 * otherwise, and an adapter that never says otherwise will have a strategy
 * trading off a price from an hour ago.
 */
export interface QuoteStream {
  /** Observe one topic. Returns an unsubscribe function; safe to call twice. */
  onQuote(topic: PredictQuoteTopic, listener: QuoteListener): () => void;
}

/**
 * The side-appropriate trigger price on a frame, or null when there is none.
 *
 * A BUY fires against the ASK (what it would pay) and a SELL against the BID
 * (what it would receive) — the same two sides `POST /quotes` prices, so the
 * trigger and the executable quote read the same book and an order can never be
 * triggered by a book it is not priced against.
 *
 * A stale frame carries null prices by protocol; returning null rather than a
 * remembered last price is the whole point of the flag.
 */
export function streamTriggerPrice(
  side: PredictSide,
  frame: PredictQuoteStreamFrame,
): string | null {
  if (frame.freshness.stale) return null;
  return (side === 'BUY' ? frame.indicativeAsk : frame.indicativeBid) ?? null;
}

/* ── The shipped Socket.IO client ─────────────────────────────────────────── */

/**
 * The slice of a Socket.IO socket this client uses. Wider than the execution
 * stream's by exactly one method: quote topics are CLIENT-named, so there is a
 * subscribe message to send.
 */
export interface QuoteSocket {
  on(event: string, listener: (payload: unknown) => void): void;
  /** Client → server. Only ever a subscribe or unsubscribe message. */
  emit(event: string, payload: unknown): void;
  disconnect(): void;
}

export type QuoteStreamConnector = (
  options: StreamConnectOptions,
) => QuoteSocket | Promise<QuoteSocket>;

export interface SocketQuoteStreamOptions {
  /** The same base URL the REST client uses; the namespace path is appended. */
  baseUrl: string;
  /** The bearer token for the handshake, re-read on every reconnect. */
  token: () => Promise<string>;
  /**
   * Replace a token the server refused at the handshake. Returning `undefined`
   * means this session may not re-authenticate, and the last token is tried once
   * more before the failure budget runs out.
   */
  refreshToken?: (rejected: string) => Promise<string | undefined>;
  /**
   * Called once when the stream stops trying, with the reason. Price waits are
   * unaffected — they fall back to `POST /quotes` — but a long-lived strategy
   * deserves to know it lost the accelerator rather than quietly paying for
   * quote mints forever.
   */
  onDegraded?: (reason: string) => void;
  /** Consecutive handshake refusals tolerated before giving up. Default 3. */
  maxHandshakeFailures?: number;
  /** Consecutive silent heartbeat windows tolerated before giving up. Default 3. */
  maxSilentWindows?: number;
  /**
   * How long to leave a topic the server temporarily refused before asking again.
   * Default 60 s. Terminal refusals (`UNKNOWN_MARKET`, `MARKET_CLOSED`,
   * `INVALID_REQUEST`) are never retried — asking again cannot change the answer,
   * and the server's 60-messages-per-minute budget is not spent on it.
   */
  retryRejectedMs?: number;
  /**
   * Hold the socket open this long after the last topic is released. Default 0 —
   * disconnect immediately, because a connected socket keeps the event loop alive
   * and a one-shot CLI is worth more than a saved handshake.
   */
  idleDisconnectMs?: number;
  /** Injectable transport. Defaults to the official `socket.io-client`. */
  connect?: QuoteStreamConnector;
}

const DEFAULT_MAX_HANDSHAKE_FAILURES = 3;
const DEFAULT_MAX_SILENT_WINDOWS = 3;
const DEFAULT_RETRY_REJECTED_MS = 60_000;

/**
 * How long silence counts as dead. Two heartbeats is the contract's own signal to
 * reconnect; the slack absorbs a late tick without declaring a healthy socket
 * dead and rebuilding it for nothing.
 */
const HEARTBEAT_SLACK_MS = 5_000;
const SILENCE_MS = 2 * PREDICT_QUOTE_STREAM_HEARTBEAT_MS + HEARTBEAT_SLACK_MS;

/** Handshake refusals the gateway sends before disconnecting. */
const TOKEN_REFUSALS = new Set(['invalid_token', 'missing_token']);

/** Refusals that re-asking cannot change within this round. */
const TERMINAL_REJECTIONS = new Set<PredictQuoteRejectionReason>([
  'UNKNOWN_MARKET',
  'MARKET_CLOSED',
  'INVALID_REQUEST',
]);

/** What one held topic needs sent for it on the next flush. */
type Pending = 'FRESH' | 'RESUME' | undefined;

interface Registration {
  topic: PredictQuoteTopic;
  listeners: Set<QuoteListener>;
  /**
   * Last sequence seen ON THIS CONNECTION. Reset by every reconnect and never
   * persisted — it addresses no history and means nothing on another socket.
   */
  seq: bigint | undefined;
  pending: Pending;
  /** Terminal refusal: never re-subscribed, on this or any later connection. */
  refused: boolean;
  /** Temporarily refused; retried once the retry timer fires. */
  waitingRetry: boolean;
}

export class SocketQuoteStream implements QuoteStream {
  private readonly url: string;
  private readonly getToken: () => Promise<string>;
  private readonly refreshToken: ((rejected: string) => Promise<string | undefined>) | undefined;
  private readonly onDegraded: ((reason: string) => void) | undefined;
  private readonly maxHandshakeFailures: number;
  private readonly maxSilentWindows: number;
  private readonly retryRejectedMs: number;
  private readonly idleDisconnectMs: number;
  private readonly connector: QuoteStreamConnector;

  private readonly topics = new Map<string, Registration>();
  private readonly pendingUnsubscribe: PredictQuoteTopic[] = [];
  private socket: QuoteSocket | undefined;
  private opening: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;

  private issuedToken: string | undefined;
  private refreshBeforeNextHandshake = false;
  private handshakeFailures = 0;
  private silentWindows = 0;
  /** Whether a ready frame has EVER arrived — a second one means a reconnect. */
  private everReady = false;
  /** Whether the CURRENT socket is authenticated and may be sent messages. */
  private live = false;
  private degraded = false;
  private closed = false;

  constructor(options: SocketQuoteStreamOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, '')}${PREDICT_AGENT_STREAM_NAMESPACE}`;
    this.getToken = options.token;
    this.refreshToken = options.refreshToken;
    this.onDegraded = options.onDegraded;
    this.maxHandshakeFailures = options.maxHandshakeFailures ?? DEFAULT_MAX_HANDSHAKE_FAILURES;
    this.maxSilentWindows = options.maxSilentWindows ?? DEFAULT_MAX_SILENT_WINDOWS;
    this.retryRejectedMs = options.retryRejectedMs ?? DEFAULT_RETRY_REJECTED_MS;
    this.idleDisconnectMs = options.idleDisconnectMs ?? 0;
    this.connector = options.connect ?? nativeQuoteConnector;
  }

  /** True once the stream has stopped trying. Price waits still work; they poll. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  onQuote(topic: PredictQuoteTopic, listener: QuoteListener): () => void {
    if (this.closed || this.degraded) {
      // Told immediately rather than left waiting for a frame that will never
      // come: a watcher that believes a dead stream is merely quiet will keep
      // returning its last price forever.
      invoke(listener, { type: 'UNAVAILABLE', reason: 'DEGRADED' });
      return () => undefined;
    }
    this.clearIdleTimer();
    const key = topicKey(topic);
    let registration = this.topics.get(key);
    if (registration === undefined) {
      registration = {
        topic: { marketId: topic.marketId, outcomeId: topic.outcomeId },
        listeners: new Set(),
        seq: undefined,
        // A first subscribe, not a resume: nothing was held, so nothing was
        // missed, and claiming a gap here would invalidate a snapshot needlessly.
        pending: 'FRESH',
        refused: false,
        waitingRetry: false,
      };
      this.topics.set(key, registration);
      this.scheduleFlush();
    }
    registration.listeners.add(listener);
    this.ensureConnected();

    let active = true;
    return () => {
      // Idempotent: a watcher that releases twice must not evict a listener some
      // later wait registered for the same topic.
      if (!active) return;
      active = false;
      const current = this.topics.get(key);
      if (current === undefined) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      this.topics.delete(key);
      // Told to the server so its per-tick cost stops; it is idempotent there, so
      // a message lost to a disconnect costs nothing — the connection dropping
      // releases the topic anyway.
      this.pendingUnsubscribe.push(current.topic);
      this.scheduleFlush();
      if (this.topics.size === 0) this.scheduleIdleDisconnect();
    };
  }

  /**
   * Release the socket and forget every topic. Safe to call more than once, and
   * safe while a connection attempt is still in flight — the socket that attempt
   * produces is disconnected on arrival rather than leaked.
   */
  close(): void {
    this.closed = true;
    this.clearIdleTimer();
    this.clearFlushTimer();
    this.clearRetryTimer();
    this.clearSilenceTimer();
    this.topics.clear();
    this.pendingUnsubscribe.length = 0;
    this.disconnectSocket();
  }

  private ensureConnected(): void {
    if (this.closed || this.degraded) return;
    if (this.socket !== undefined || this.opening !== undefined) return;
    // A connection that cannot be established is not a failed wait: the watcher
    // falls back to POST /quotes, so this degrades to REST rather than rejecting
    // into a strategy.
    this.opening = this.open()
      .catch((error: unknown) => {
        this.giveUp(`quote stream transport unavailable: ${describe(error)}`);
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
    // The connector takes at least a tick (the native one loads a module). If
    // every topic was released, or the stream was closed, in that window, this
    // socket has no owner and must not be kept.
    if (this.closed || this.topics.size === 0) {
      disconnectQuietly(socket);
      return;
    }
    this.socket = socket;
    // The ready frame is the execution stream's, and it is what proves this
    // handshake was ACCEPTED. Subscribing before it would send topics into a
    // socket the gateway is about to disconnect.
    socket.on(PREDICT_STREAM_READY, () => {
      this.handleReady();
    });
    socket.on(PREDICT_QUOTE_STREAM, (payload) => {
      this.handleQuoteFrame(payload);
    });
    socket.on(PREDICT_QUOTE_SUBSCRIPTION, (payload) => {
      this.handleSubscription(payload);
    });
    socket.on(PREDICT_QUOTE_HEARTBEAT, (payload) => {
      this.handleHeartbeat(payload);
    });
    // The gateway emits this and then disconnects when it refuses a handshake.
    // Transport-level failures arrive as `connect_error` and are left to
    // socket.io's own backoff — a network blip must not burn the failure budget
    // reserved for credentials the server has actually rejected.
    socket.on('error', (payload) => {
      this.handleServerError(payload);
    });
    // Armed before anything has been received, so a connection that never becomes
    // ready — a transport that opens and then says nothing — still counts as a
    // silent window. Without this the client would sit connected and mute, and
    // the give-up budget it is supposed to spend would never be touched.
    this.armSilenceTimer();
  }

  /**
   * No cursor is ever sent. This feed has no log to replay from, and asking the
   * execution replay on the shared namespace for a window this socket does not
   * consume would cost a burst of frames nobody reads.
   */
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
    return { token };
  }

  private handleReady(): void {
    // A completed handshake proves the credential works; the budget is for
    // consecutive refusals, not a lifetime total.
    this.handshakeFailures = 0;
    const reconnected = this.everReady;
    this.everReady = true;
    this.live = true;
    this.armSilenceTimer();
    // A new connection holds no topics, so anything queued to be dropped from the
    // old one has already been released by the disconnect itself.
    this.pendingUnsubscribe.length = 0;
    for (const registration of this.topics.values()) {
      // Every sequence restarts on a new connection. Keeping the old one would
      // make the very first frame look like a gap, or worse, hide a real one.
      registration.seq = undefined;
      registration.waitingRetry = false;
      if (!registration.refused) registration.pending = reconnected ? 'RESUME' : 'FRESH';
    }
    // A reconnect loses frames without announcing it, and this feed cannot say
    // what moved while we were away. Every cached price is invalidated here and
    // rebuilt by the snapshot the resume is about to produce; between the two,
    // a wait prices off REST, which is the only authority there has ever been.
    if (reconnected) this.notifyAll('DISCONNECTED');
    this.flush();
  }

  private handleQuoteFrame(payload: unknown): void {
    // Any frame proves the socket is alive, heartbeat or not.
    this.observeLiveness();
    const topic = readTopic(payload);
    if (topic === undefined) return;
    const registration = this.topics.get(topicKey(topic));
    if (registration === undefined) return; // a topic released since it was asked for
    const frame = asQuoteFrame(payload);
    if (frame === undefined) {
      // Unreadable, and it may have carried a move. Reported rather than dropped
      // silently: a consumer must invalidate rather than keep trusting a price
      // that a frame it could not parse might have replaced.
      this.emitTo(registration, { type: 'UNAVAILABLE', reason: 'GAP' });
      return;
    }
    registration.refused = false;
    registration.waitingRetry = false;
    const seq = parseSeq(frame.seq);
    const missed =
      frame.kind === 'SNAPSHOT'
        ? // The server sets this only on a resumed snapshot: you were away, and
          // this snapshot is the whole recovery.
          frame.gap
        : registration.seq !== undefined && (seq === undefined || seq !== registration.seq + 1n);
    registration.seq = seq;
    // Reported BEFORE the frame, so a consumer that caches on FRAME invalidates
    // first. The frame itself is complete current state — this is a state feed,
    // so what a gap costs is intermediate values, i.e. triggers, not correctness
    // of the value now.
    if (missed) this.emitTo(registration, { type: 'UNAVAILABLE', reason: 'GAP' });
    this.emitTo(registration, { type: 'FRAME', frame });
  }

  private handleSubscription(payload: unknown): void {
    this.observeLiveness();
    const rejected = readRejections(payload);
    let retryNeeded = false;
    for (const rejection of rejected) {
      // A null echo is the server refusing a request it could not attribute to a
      // topic — a rate-limited empty list. There is nothing to mark.
      if (rejection.marketId === null || rejection.outcomeId === null) continue;
      const registration = this.topics.get(
        topicKey({ marketId: rejection.marketId, outcomeId: rejection.outcomeId }),
      );
      if (registration === undefined) continue;
      if (TERMINAL_REJECTIONS.has(rejection.reason)) {
        registration.refused = true;
        registration.pending = undefined;
      } else {
        // Temporary: no live book, over the topic cap, or throttled. Re-asking
        // immediately would spend the message budget that a retry needs.
        registration.waitingRetry = true;
        registration.pending = undefined;
        retryNeeded = true;
      }
      this.emitTo(registration, { type: 'UNAVAILABLE', reason: rejection.reason });
    }
    if (retryNeeded) this.scheduleRetry();
  }

  private handleHeartbeat(payload: unknown): void {
    this.observeLiveness();
    // The heartbeat is the only gap signal a QUIET market has: updates are sent
    // only when a price moved, so a dropped frame in a slow market would
    // otherwise go unnoticed until the next move.
    for (const entry of readHeartbeatTopics(payload)) {
      const registration = this.topics.get(topicKey(entry));
      if (registration === undefined) continue;
      const seq = parseSeq(entry.seq);
      if (seq === undefined || registration.seq === undefined) continue;
      if (seq <= registration.seq) continue;
      registration.seq = seq;
      this.emitTo(registration, { type: 'UNAVAILABLE', reason: 'GAP' });
    }
  }

  private handleServerError(payload: unknown): void {
    const reason = readReason(payload);
    if (TOKEN_REFUSALS.has(reason)) this.refreshBeforeNextHandshake = true;
    this.live = false;
    this.handshakeFailures += 1;
    if (this.handshakeFailures >= this.maxHandshakeFailures) {
      this.giveUp(`quote stream handshake refused ${String(this.handshakeFailures)}x: ${reason}`);
    }
  }

  /* ── Sending ───────────────────────────────────────────────────────────── */

  /**
   * Batch a tick's worth of registrations into one message.
   *
   * The server allows 60 subscribe/unsubscribe messages per rolling minute, so a
   * strategy opening twenty topics in a loop must cost ONE message, not twenty.
   */
  private scheduleFlush(): void {
    if (this.flushTimer !== undefined || this.closed) return;
    const timer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 0);
    timer.unref?.();
    this.flushTimer = timer;
  }

  private flush(): void {
    this.clearFlushTimer();
    const socket = this.socket;
    if (socket === undefined || !this.live) return;
    const fresh: PredictQuoteTopic[] = [];
    const resumed: PredictQuoteTopic[] = [];
    for (const registration of this.topics.values()) {
      if (registration.pending === undefined) continue;
      (registration.pending === 'RESUME' ? resumed : fresh).push(registration.topic);
      registration.pending = undefined;
    }
    const dropped = this.pendingUnsubscribe.splice(0);
    if (fresh.length > 0) this.send(PREDICT_QUOTE_SUBSCRIBE, { topics: fresh });
    // A separate message because `resume` is a property of the MESSAGE: folding a
    // newly requested topic into it would flag its snapshot as a gap it never had.
    if (resumed.length > 0) this.send(PREDICT_QUOTE_SUBSCRIBE, { topics: resumed, resume: true });
    if (dropped.length > 0) this.send(PREDICT_QUOTE_UNSUBSCRIBE, { topics: dropped });
  }

  private send(event: string, message: PredictQuoteSubscribeMessage): void {
    try {
      this.socket?.emit(event, message);
    } catch {
      // A socket that died between the check and the write is a reconnect, not a
      // failure: the next ready frame re-subscribes everything anyway.
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== undefined || this.closed) return;
    const timer = setTimeout(() => {
      this.retryTimer = undefined;
      let due = false;
      for (const registration of this.topics.values()) {
        if (!registration.waitingRetry) continue;
        registration.waitingRetry = false;
        // FRESH, not RESUME: the subscription was refused, so nothing is held and
        // there is no window to declare a gap over.
        registration.pending = 'FRESH';
        due = true;
      }
      if (due) this.flush();
    }, this.retryRejectedMs);
    timer.unref?.();
    this.retryTimer = timer;
  }

  /* ── Liveness ──────────────────────────────────────────────────────────── */

  private observeLiveness(): void {
    this.silentWindows = 0;
    this.armSilenceTimer();
  }

  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    if (this.closed || this.degraded || this.topics.size === 0) return;
    const timer = setTimeout(() => {
      this.silenceTimer = undefined;
      this.handleSilence();
    }, SILENCE_MS);
    timer.unref?.();
    this.silenceTimer = timer;
  }

  /**
   * Two heartbeats missed. The contract's own instruction is to reconnect, and
   * the reason it is not left to socket.io is that a half-open TCP connection
   * looks perfectly healthy from the client side while delivering nothing.
   */
  private handleSilence(): void {
    this.silentWindows += 1;
    this.live = false;
    // Said first and unconditionally: whatever happens next, the cached prices
    // are no longer backed by a feed anyone can prove is alive.
    this.notifyAll('DISCONNECTED');
    if (this.silentWindows >= this.maxSilentWindows) {
      this.giveUp(
        `quote stream silent for ${String(this.silentWindows)} heartbeat windows`,
      );
      return;
    }
    this.disconnectSocket();
    this.ensureConnected();
  }

  /* ── Teardown ──────────────────────────────────────────────────────────── */

  private giveUp(reason: string): void {
    if (this.degraded) return;
    this.degraded = true;
    this.clearFlushTimer();
    this.clearRetryTimer();
    this.clearSilenceTimer();
    this.notifyAll('DEGRADED');
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
      // Closing the connection releases every topic on the server, so a queued
      // unsubscribe would spend one of the 60 messages a minute to say what the
      // disconnect is about to say anyway. Nothing is held, so nothing else is
      // waiting on that flush.
      this.pendingUnsubscribe.length = 0;
      this.clearFlushTimer();
      this.disconnectSocket();
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.topics.size === 0) this.disconnectSocket();
    }, this.idleDisconnectMs);
    // Never hold the process open for a socket nobody is watching prices on.
    timer.unref?.();
    this.idleTimer = timer;
  }

  private disconnectSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.live = false;
    this.clearSilenceTimer();
    // `everReady` is NOT reset: the next ready frame is a reconnect, and a
    // reconnect must resume and reconcile.
    if (socket !== undefined) disconnectQuietly(socket);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer === undefined) return;
    clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  private emitTo(registration: Registration, event: QuoteStreamEvent): void {
    for (const listener of registration.listeners) invoke(listener, event);
  }

  private notifyAll(reason: QuoteUnavailableReason): void {
    for (const registration of this.topics.values()) {
      this.emitTo(registration, { type: 'UNAVAILABLE', reason });
    }
  }
}

/**
 * The shipped transport.
 *
 * Loaded on demand, exactly like the execution stream's: importing
 * `socket.io-client` costs a caller who only places market orders nothing, and a
 * runtime that pruned the dependency gets a degraded stream instead of a
 * module-load crash.
 *
 * This opens its OWN connection to the agent namespace rather than sharing the
 * execution stream's. The two have unrelated lifetimes — a price watch outlives
 * the order it eventually places — and the server scopes quote topics per
 * connection, so a second socket is a supported client shape rather than a
 * workaround. It costs one extra handshake per streaming strategy.
 */
const nativeQuoteConnector: QuoteStreamConnector = async ({ url, handshake }) => {
  const { io } = await import('socket.io-client');
  const socket = io(url, {
    // MANDATORY, not a tuning knob. `io()` multiplexes by default: a second call
    // for the same namespace hands back the SAME Socket the execution stream is
    // already using, so this stream's `disconnect()` would kill that one's feed
    // and both would share one set of handlers. The quote and execution streams
    // have unrelated lifetimes and must be separate connections.
    forceNew: true,
    // WebSocket only, for the same reason as the execution stream: no Socket.IO
    // Redis adapter, so an HTTP long-polling upgrade without sticky sessions can
    // land on a different pod from the one holding this connection's topics.
    transports: ['websocket'],
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
  // socket.io types `on`/`emit` as generics over its reserved-event map, which
  // cannot be checked structurally against plain string signatures. The cast is
  // confined to this line, which is why QuoteSocket is as small as it is.
  return socket as unknown as QuoteSocket;
};

/* ── The watcher that puts the stream in front of REST ─────────────────────── */

export interface QuoteStreamPriceWatcherOptions {
  stream: QuoteStream;
  /**
   * Where a price comes from when the stream has none — in practice
   * `POST /quotes`. This is the bounded polling fallback: a dead, gapped,
   * degraded or not-yet-connected stream costs requests, never a hang.
   */
  fallback: (request: CreateQuoteRequestBody, signal?: AbortSignal) => Promise<string | null>;
}

interface TopicEntry {
  refs: number;
  release: () => void;
  frame: PredictQuoteStreamFrame | undefined;
  /** A frame that arrived while the reader was mid-request; see `waitForChange`. */
  unread: boolean;
  waiters: Set<() => void>;
}

/**
 * A {@link PriceWatcher} that reads the stream and falls back to REST.
 *
 * The fallback is not a corner case, it is the design: the stream supplies a
 * price only while it can prove the feed is live, and every other moment —
 * before the first snapshot, across a gap, after a rejection, once degraded —
 * resolves to `POST /quotes`. The strategy above it cannot tell the difference,
 * which is what makes a dead stream cost requests rather than correctness.
 *
 * What it never does is turn a streamed price into an order price. It answers
 * `currentPrice`, which is the TRIGGER half of `waitForPriceAndExecute`; the
 * fresh executable quote and the re-check against the target happen afterwards
 * regardless of where the trigger came from.
 */
export class QuoteStreamPriceWatcher implements PriceWatcher {
  private readonly stream: QuoteStream;
  private readonly fallback: QuoteStreamPriceWatcherOptions['fallback'];
  private readonly entries = new Map<string, TopicEntry>();

  constructor(options: QuoteStreamPriceWatcherOptions) {
    this.stream = options.stream;
    this.fallback = options.fallback;
  }

  /**
   * Subscribe for the lifetime of one wait. Reference-counted, so two strategies
   * watching the same market share one subscription and the second release is the
   * one that ends it.
   */
  watch(request: CreateQuoteRequestBody): () => void {
    const key = topicKey(request);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      const created: TopicEntry = {
        refs: 0,
        release: () => undefined,
        frame: undefined,
        unread: false,
        waiters: new Set(),
      };
      this.entries.set(key, created);
      created.release = this.stream.onQuote(
        { marketId: request.marketId, outcomeId: request.outcomeId },
        (event) => {
          this.apply(created, event);
        },
      );
      entry = created;
    }
    const held = entry;
    held.refs += 1;

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      held.refs -= 1;
      if (held.refs > 0) return;
      this.entries.delete(key);
      held.waiters.clear();
      held.frame = undefined;
      try {
        held.release();
      } catch {
        // An adapter that throws on unsubscribe must not fail the caller's trade,
        // which by this point has already completed.
      }
    };
  }

  async currentPrice(
    request: CreateQuoteRequestBody,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const entry = this.entries.get(topicKey(request));
    const frame = entry?.frame;
    if (entry !== undefined) entry.unread = false;
    if (frame !== undefined) {
      const price = streamTriggerPrice(request.side, frame);
      // A price the server vouches for, so no quote is minted to learn it again.
      if (price !== null) return price;
      // Stale, or no side to read. NOT reported as "no price": what went stale is
      // the cache this feed polls, and `POST /quotes` mints from the executable
      // path, which may be perfectly healthy. Answering null here would wedge a
      // strategy for as long as the publisher stayed quiet, so the wait pays a
      // quote per interval instead — exactly what it would cost with no stream
      // at all.
    }
    return await this.fallback(request, signal);
  }

  async waitForChange(
    request: CreateQuoteRequestBody,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const entry = this.entries.get(topicKey(request));
    if (entry === undefined) {
      await sleep(timeoutMs, signal);
      return;
    }
    // A frame that landed while the caller was awaiting its last read must not be
    // slept through: it is the move the whole wait exists to catch. CONSUMED
    // here, or the next call returns instantly on the same frame and the wait
    // spins through its quote budget.
    if (entry.unread) {
      entry.unread = false;
      return;
    }
    const held = entry;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener('abort', finish, { once: true });
      held.waiters.add(finish);
      function finish(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        held.waiters.delete(finish);
        resolve();
      }
    });
  }

  private apply(entry: TopicEntry, event: QuoteStreamEvent): void {
    if (event.type === 'FRAME') {
      entry.frame = event.frame;
      entry.unread = true;
      // Copied first: a waiter that re-registers from inside its own callback
      // would otherwise be woken again by this same loop.
      for (const wake of [...entry.waiters]) invokeWake(wake);
      return;
    }
    // Anything else means the cached price is no longer backed by a live feed.
    // Dropped rather than aged: the next read falls through to REST, which is the
    // authority, and no waiter is woken because nothing has been observed to move.
    entry.frame = undefined;
    entry.unread = false;
  }
}

/* ── Parsing ──────────────────────────────────────────────────────────────── */

function topicKey(topic: { marketId: string; outcomeId: string }): string {
  return `${topic.marketId} ${topic.outcomeId}`;
}

/** `undefined` for anything that is not a sequence, so a gap check cannot misread it. */
function parseSeq(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}

function readTopic(payload: unknown): PredictQuoteTopic | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const raw = payload as { marketId?: unknown; outcomeId?: unknown };
  if (typeof raw.marketId !== 'string' || raw.marketId === '') return undefined;
  if (raw.outcomeId !== 'YES' && raw.outcomeId !== 'NO') return undefined;
  return { marketId: raw.marketId, outcomeId: raw.outcomeId };
}

/**
 * A frame is usable only if every field the trigger keys on is the right shape.
 *
 * Nothing is defaulted or repaired. A frame with an unreadable `freshness` could
 * be a stale value whose flag did not survive serialization, and defaulting that
 * to "fresh" is how a strategy trades off a price the server had already
 * withdrawn. The caller reports the unreadable frame as a gap instead.
 */
function asQuoteFrame(payload: unknown): PredictQuoteStreamFrame | undefined {
  const raw = payload as Partial<PredictQuoteStreamFrame> | null;
  if (raw === null) return undefined;
  if (raw.kind !== 'SNAPSHOT' && raw.kind !== 'UPDATE') return undefined;
  if (typeof raw.seq !== 'string' || typeof raw.gap !== 'boolean') return undefined;
  if (!isPriceOrNull(raw.indicativeBid) || !isPriceOrNull(raw.indicativeAsk)) return undefined;
  const freshness = raw.freshness;
  if (typeof freshness !== 'object' || freshness === null) return undefined;
  if (typeof freshness.stale !== 'boolean') return undefined;
  // Passed through unchanged, open sets and unknown fields included: a newer
  // server's quality flag is not this client's to reject.
  return payload as PredictQuoteStreamFrame;
}

function isPriceOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

interface ParsedRejection {
  marketId: string | null;
  outcomeId: PredictOutcomeId | null;
  reason: PredictQuoteRejectionReason;
}

function readRejections(payload: unknown): ParsedRejection[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const raw = (payload as { rejected?: unknown }).rejected;
  if (!Array.isArray(raw)) return [];
  const rejections: ParsedRejection[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { marketId?: unknown; outcomeId?: unknown; reason?: unknown };
    if (typeof record.reason !== 'string') continue;
    rejections.push({
      marketId: typeof record.marketId === 'string' ? record.marketId : null,
      outcomeId:
        record.outcomeId === 'YES' || record.outcomeId === 'NO' ? record.outcomeId : null,
      reason: record.reason as PredictQuoteRejectionReason,
    });
  }
  return rejections;
}

function readHeartbeatTopics(payload: unknown): (PredictQuoteTopic & { seq: unknown })[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const raw = (payload as { topics?: unknown }).topics;
  if (!Array.isArray(raw)) return [];
  const entries: (PredictQuoteTopic & { seq: unknown })[] = [];
  for (const item of raw) {
    const topic = readTopic(item);
    if (topic === undefined) continue;
    entries.push({ ...topic, seq: (item as { seq?: unknown }).seq });
  }
  return entries;
}

function readReason(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return 'unknown';
  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason !== '' ? reason : 'unknown';
}

function invoke(listener: QuoteListener, event: QuoteStreamEvent): void {
  try {
    listener(event);
  } catch {
    // Documented on QuoteStream: one listener throwing must not strand the waits
    // behind it, and must not kill the socket.
  }
}

function invokeWake(wake: () => void): void {
  try {
    wake();
  } catch {
    /* as above */
  }
}

function disconnectQuietly(socket: QuoteSocket): void {
  try {
    socket.disconnect();
  } catch {
    // Tearing down a socket that is already gone is not a failure worth raising
    // into a caller whose trade has already settled.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
