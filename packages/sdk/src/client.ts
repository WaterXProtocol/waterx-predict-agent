/**
 * PredictAgentClient — the agent-facing surface.
 *
 * `executeMarketOrder` hides the API's two-call shape (create → sign → submit)
 * behind one await, per the design spec. Everything else is a thin typed read.
 *
 * THE IDEMPOTENCY RULE, because this is where a mistake places a second order:
 * the key is generated ONCE per logical intent and reused across every retry of
 * the create, including retries the transport does internally. A caller that
 * wants a retry to survive its own process restart passes `idempotencyKey`
 * explicitly — that is the only way the guarantee can outlive this object.
 */
import { randomUUID } from 'node:crypto';

import {
  type AgentAuthResponseBody,
  type PredictOrderSize,
  type PredictOutcomeId,
  type PredictSide,
  type PriceString,
  type CreateExecutionRequestBody,
  type CreateExecutionResponseBody,
  type CreateQuoteRequestBody,
  type GetMarketResponseBody,
  type ListExecutionsResponseBody,
  type ListFillsResponseBody,
  type ListMarketsQuery,
  type ListMarketsResponseBody,
  type ListPositionsResponseBody,
  PREDICT_AGENT_API_ROUTES,
  type PredictAgentListQuery,
  type PredictAgentPerformanceResponseBody,
  type PredictAllowanceResponseBody,
  type PredictEffectiveLimitsResponseBody,
  type PredictMarketResolution,
  type PredictQuote,
  type SubmitExecutionResponseBody,
} from './contract.ts';
import { targetReached } from './decimal.ts';
import { pageQuery } from './pagination.ts';
import { isStaleQuote, PredictAgentApiError } from './errors.ts';
import {
  type ExecutionStream,
  SocketExecutionStream,
  type StreamConnector,
} from './execution-stream.ts';
import {
  type ExecutionOutcome,
  isTerminalExecutionStatus,
  toExecutionOutcome,
} from './execution-facts.ts';
import {
  type PriceWatcher,
  type QuoteStream,
  type QuoteStreamConnector,
  QuoteStreamPriceWatcher,
  SocketQuoteStream,
} from './quote-stream.ts';
import { AuthSession } from './session.ts';
import { sleep } from './sleep.ts';
import { type AgentSigner, buildAuthMessage, signBase64 } from './signer.ts';
import { Transport, type TransportOptions } from './transport.ts';

export interface PredictAgentClientOptions extends TransportOptions {
  signer: AgentSigner;
  /**
   * Reuse an existing session token instead of authenticating. Its lifetime is
   * unknown to the client, so it is replaced only after the server rejects it.
   */
  token?: string;
  /**
   * Re-authenticate automatically when the server rejects the session token, and
   * roll a self-minted token over just before it expires. Default `true`.
   *
   * Bounded either way: one re-authentication per request, sharing a single mint
   * across concurrent requests, and the replayed request keeps its exact bytes
   * and its idempotency key — so a token dying mid-order cannot produce a second
   * one. Set `false` to surface `UNAUTHENTICATED` to the caller instead; opening
   * the first session is always explicit.
   */
  autoReauthenticate?: boolean;
  /**
   * Override how prices are observed. Takes precedence over `quoteStream`;
   * omitted with no quote stream either, price waits poll `POST /quotes`.
   */
  priceWatcher?: PriceWatcher;
  /**
   * Push source for indicative prices, used for the TRIGGER half of
   * {@link PredictAgentClient.waitForPriceAndExecute} only. A wait still mints a
   * fresh executable quote and re-checks the target before submitting, so the
   * stream changes what a wait COSTS — one quote mint per tick becomes one per
   * trigger — and never what it trades at.
   *
   * `'native'` opens the official Socket.IO quote stream against this client's
   * base URL and session; this client then owns the socket, so call
   * {@link PredictAgentClient.close} when you are done. It connects on the first
   * wait, disconnects when the last one ends, and falls back to `POST /quotes`
   * whenever it cannot prove the feed is live.
   */
  quoteStream?: QuoteStream | 'native';
  /**
   * Injectable socket transport for `quoteStream: 'native'`. Exists so this
   * package's tests never open a real connection; production callers leave it
   * unset and get `socket.io-client`.
   */
  quoteStreamConnector?: QuoteStreamConnector;
  /**
   * Push source for execution updates. Waits then react to frames instead of
   * sleeping out a fixed interval; omitted, they poll. Either way the terminal
   * state is confirmed over REST, so a gapped or dead stream degrades to the poll
   * path rather than hanging.
   *
   * `'native'` opens the official Socket.IO stream against this client's base URL
   * and session — zero configuration, and this client owns the socket, so call
   * {@link PredictAgentClient.close} when you are done with it. It connects on the
   * first wait and disconnects when the last one ends, and its cursor lives only
   * as long as the object: to make a RESTART replay the window it missed,
   * construct a {@link SocketExecutionStream} yourself with `cursor`/`onCursor`
   * and pass it here instead.
   */
  executionStream?: ExecutionStream | 'native';
  /**
   * Injectable socket transport for `executionStream: 'native'`. Exists so this
   * package's tests never open a real connection; production callers leave it
   * unset and get `socket.io-client`.
   */
  streamConnector?: StreamConnector;
}

/**
 * Whether a thrown value is a deadline or a cancellation rather than a refusal.
 *
 * The distinction decides whether an order that already exists is reported as
 * FAILED or as UNKNOWN, so it is made on the error's own identity — a
 * `TimeoutError`/`AbortError` `DOMException`, possibly wrapped by the transport —
 * and never on a message. It walks `cause` because that is where the transport
 * keeps the original.
 */
const isAbortLike = (error: unknown): boolean => {
  for (let value: unknown = error, depth = 0; value !== undefined && depth < 5; depth += 1) {
    const named = value as { name?: unknown; cause?: unknown };
    if (named.name === 'AbortError' || named.name === 'TimeoutError') return true;
    value = named.cause;
  }
  return false;
};

export interface ExecuteMarketOrderIntent
  extends Omit<CreateExecutionRequestBody, 'referenceQuoteId'> {
  /**
   * The quote this order is priced against, if the caller already minted one.
   *
   * **Optional, and usually better left out.** A quote lives seconds, and the one
   * instant at which it is certainly still alive is immediately before the create
   * — which, for a leg inside {@link PredictAgentClient.executeMany}, is a moment
   * only this client knows, because it falls after every earlier leg finished. A
   * caller that mints a whole batch's quotes up front cannot be right: the first
   * leg's create/sign/submit outlives the second leg's quote, and that leg fails
   * `QUOTE_EXPIRED` having sent nothing.
   *
   * Omit it and the quote is minted here, from this intent's own market, outcome,
   * side and size, at the moment the order is actually placed (plan §5.5).
   */
  referenceQuoteId?: string;
  /**
   * Supply this to make a retry idempotent ACROSS process restarts. Omitted, the
   * client generates one per call, which covers in-process retries only.
   */
  idempotencyKey?: string;
}

export interface WaitForExecutionOptions {
  /**
   * Bound on the wait. Exceeding it does NOT cancel the order: the result comes
   * back with `timedOut: true` and a non-terminal status.
   */
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface ExecuteMarketOrderOptions extends WaitForExecutionOptions {
  /**
   * Wait for a terminal status instead of returning at SUBMITTED. The order is
   * already on-chain either way — this only decides when the promise settles,
   * and only a terminal read carries fill, fee and remaining-allowance facts.
   */
  waitFor?: 'SUBMITTED' | 'TERMINAL';
}

export interface ExecuteMarketOrderResult extends ExecutionOutcome {
  /** The price the chain enforced — never looser than requested. */
  enforcedWorstPrice: string;
  /** Echoed so a caller can persist it and resume the same intent later. */
  idempotencyKey: string;
}

/**
 * Re-exported from where it now lives, because it grew a stream behind it: a
 * watcher may also bracket a wait's subscription and wake it early, and both of
 * those belong next to the quote stream rather than in the REST client.
 */
export type { PriceWatcher } from './quote-stream.ts';

export interface WaitForPriceIntent {
  accountId: string;
  marketId: string;
  outcomeId: PredictOutcomeId;
  side: PredictSide;
  size: PredictOrderSize;
  /** BUY: a price CEILING. SELL: a price FLOOR. */
  targetPrice: PriceString;
  /** Required for SELL. */
  positionId?: string;
  maxSlippageBps: number;
  worstAcceptablePrice?: PriceString;
  strategyId?: string;
  clientOrderId?: string;
  /**
   * Persist this and pass it back to make the whole wait resumable: a restart
   * mid-flight can never place a second order, because the server dedupes on it.
   */
  idempotencyKey?: string;
}

export interface WaitForPriceOptions extends ExecuteMarketOrderOptions {
  /** How often to sample the price. */
  pollIntervalMs?: number;
  /** Give up waiting after this long. Nothing is submitted on expiry. */
  waitTimeoutMs?: number;
}

export interface ExecuteManyOptions extends ExecuteMarketOrderOptions {
  concurrency?: number;
  /**
   * `STOP` stops LAUNCHING legs that have not started yet. It does not and cannot
   * cancel or roll back a leg already submitted or filled — external fills are
   * not atomic across legs.
   */
  failurePolicy?: 'STOP' | 'CONTINUE';
}

export type ExecuteManyResult =
  | { ok: true; index: number; result: ExecuteMarketOrderResult }
  | { ok: false; index: number; error: unknown }
  | { ok: false; index: number; skipped: true };

/**
 * How many times `executeMarketOrder` will mint a fresh quote after the server
 * says the previous one expired. Three: enough to ride out a slow round trip,
 * few enough that a market quoting faster than we can trade is reported rather
 * than spun on.
 */
const QUOTE_REFRESH_ATTEMPTS = 3;

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Default ceiling on a price wait. Long, because a target may be hours away. */
const DEFAULT_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;

export class PredictAgentClient {
  private readonly transport: Transport;
  private readonly signer: AgentSigner;
  private readonly watcher: PriceWatcher;
  private readonly baseUrl: string;
  private readonly streamOption: ExecutionStream | 'native' | undefined;
  private readonly streamConnector: StreamConnector | undefined;
  /** Only set for `executionStream: 'native'` — the socket this client must close. */
  private ownedStream: SocketExecutionStream | undefined;
  private readonly quoteStreamOption: QuoteStream | 'native' | undefined;
  private readonly quoteStreamConnector: QuoteStreamConnector | undefined;
  /** Only set for `quoteStream: 'native'` — the socket this client must close. */
  private ownedQuoteStream: SocketQuoteStream | undefined;
  private readonly session: AuthSession;

  constructor(options: PredictAgentClientOptions) {
    this.signer = options.signer;
    this.baseUrl = options.baseUrl;
    // The session is constructed first because the transport asks it for a token
    // on every authenticated attempt; `mint` closes over the transport lazily and
    // runs only once a request needs a session.
    this.session = new AuthSession({
      ...(options.token !== undefined ? { token: options.token } : {}),
      automatic: options.autoReauthenticate ?? true,
      mint: async () => await this.mintSession(),
    });
    this.transport = new Transport(options, this.session);
    this.streamOption = options.executionStream;
    this.streamConnector = options.streamConnector;
    this.quoteStreamOption = options.quoteStream;
    this.quoteStreamConnector = options.quoteStreamConnector;
    // Polling `POST /quotes` — the price source every agent can reach, and the
    // fallback underneath every other one.
    const poll = async (
      request: CreateQuoteRequestBody,
      signal?: AbortSignal,
    ): Promise<string | null> => (await this.getQuote(request, signal)).expectedPrice;
    this.watcher =
      options.priceWatcher ??
      (this.quoteStreamOption === undefined
        ? { currentPrice: poll }
        : new QuoteStreamPriceWatcher({
            // Indirected so the socket opens on the first watched topic rather
            // than at construction: building a client must cost no connection,
            // and the session has to exist to mint a handshake token.
            stream: {
              onQuote: (topic, listener) => this.requireQuoteStream().onQuote(topic, listener),
            },
            fallback: poll,
          }));
  }

  /**
   * Open a session by signing the server's challenge.
   *
   * Concurrent calls — including the automatic re-authentication a rejected token
   * triggers — join ONE handshake rather than racing to overwrite each other's
   * token.
   */
  async authenticate(): Promise<AgentAuthResponseBody> {
    return await this.session.authenticate();
  }

  /**
   * Whether a session token is held — the boolean, never the token.
   *
   * For a long-lived embedder that must open a session before its first call and
   * must not open a second one per tick: `authenticate()` joins a handshake
   * already in flight, but mints a *fresh* token when one already exists, so
   * "must I authenticate at all" has to be answerable without asking for the
   * credential itself.
   *
   * It says nothing about whether the server still accepts that token. An expired
   * or revoked one is discovered by using it, and `autoReauthenticate` replaces it
   * then — keeping the replayed request's exact bytes and idempotency key.
   */
  isAuthenticated(): boolean {
    return this.session.peek() !== undefined;
  }

  /**
   * The handshake itself. The timestamp is minted per attempt and embedded in the
   * signed text, so the signature is bound to this moment and this wallet — a
   * re-authentication must never replay an earlier challenge, which the server
   * rejects after five minutes anyway.
   */
  private async mintSession(): Promise<AgentAuthResponseBody> {
    const walletAddress = this.signer.toSuiAddress();
    const timestamp = Date.now();
    const message = buildAuthMessage(walletAddress, timestamp);
    // signPersonalMessage, NOT signTransaction: the server verifies this with
    // verifyPersonalMessageSignature, and Sui's intent prefixes differ between
    // the two. Signing it as a transaction yields a well-formed signature over
    // the wrong bytes, and authentication fails for every agent.
    const { signature } = await this.signer.signPersonalMessage(
      new TextEncoder().encode(message),
    );
    // Not `authenticated`: this is the route that mints the token, and letting it
    // re-authenticate on a 401 would recurse.
    return await this.transport.request<AgentAuthResponseBody>({
      method: 'POST',
      path: PREDICT_AGENT_API_ROUTES.auth,
      body: { walletAddress, signature, message, timestamp },
      idempotent: true,
    });
  }

  /**
   * Mint an executable quote. Lives ~3 seconds and is never extended, so obtain
   * it immediately before the order rather than caching it.
   */
  async getQuote(request: CreateQuoteRequestBody, signal?: AbortSignal): Promise<PredictQuote> {
    return await this.transport.request<PredictQuote>({
      method: 'POST',
      path: PREDICT_AGENT_API_ROUTES.quotes,
      body: request,
      authenticated: true,
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Create an execution and get back the bytes to sign. Half of a market order.
   *
   * Exposed separately from {@link PredictAgentClient.executeMarketOrder} for one
   * caller: a durable Runner, which must write the execution id to disk between
   * the create and the submit so a crash in between is resolvable by reading the
   * execution back rather than by sending a second one. A caller that does not
   * need that boundary should use `executeMarketOrder` and never see it.
   *
   * `idempotencyKey` is required here rather than defaulted. A key this method
   * minted would live only as long as the call, which is precisely the guarantee
   * a caller reaching for the two-step form is trying not to have.
   */
  async createExecution(
    request: CreateExecutionRequestBody,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<CreateExecutionResponseBody> {
    return await this.transport.request<CreateExecutionResponseBody>({
      method: 'POST',
      path: PREDICT_AGENT_API_ROUTES.executions,
      body: request,
      authenticated: true,
      idempotencyKey: options.idempotencyKey,
      idempotent: true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * Submit the signature for an execution this client already created.
   *
   * Retried on the caller's behalf because the server makes a repeated signature
   * submission a no-op; the execution id, not a fresh key, is what makes that
   * safe.
   */
  async submitExecution(
    executionId: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<SubmitExecutionResponseBody> {
    return await this.transport.request<SubmitExecutionResponseBody>({
      method: 'POST',
      path: PREDICT_AGENT_API_ROUTES.submitExecution.replace(':executionId', executionId),
      body: { signature },
      authenticated: true,
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Create → sign → submit, as one call.
   *
   * The create is retried under a STABLE key, so a timeout mid-create resolves to
   * the original execution instead of a second order. The submit is retried
   * because the server makes a repeated signature submission a no-op. A session
   * token expiring anywhere in here is recovered by the transport and changes
   * neither the key nor the bytes.
   *
   * `waitFor: 'TERMINAL'` is what turns the result into settlement facts — fill,
   * fee availability and remaining allowance only exist on a terminal read. A
   * wait that runs out of time returns `timedOut: true` with the execution id
   * intact; it is a decision to stop watching, never a failed order.
   */
  async executeMarketOrder(
    intent: ExecuteMarketOrderIntent,
    options: ExecuteMarketOrderOptions = {},
  ): Promise<ExecuteMarketOrderResult> {
    const idempotencyKey = intent.idempotencyKey ?? randomUUID();
    const { idempotencyKey: _ignored, referenceQuoteId, ...rest } = intent;

    // Minted HERE when the caller left it out, so the quote is as young as it can
    // be. Doing this per leg is the entire reason the field is optional; see it.
    //
    // And re-minted if it goes stale anyway. An executable quote lives about
    // three seconds, so a slow round trip or a paused event loop is enough to
    // lose the race; resending the same body cannot win it, because the quote it
    // names is already gone. Only a quote this method minted is replaced — one
    // the CALLER chose is honoured as given, because it may encode a decision
    // this method cannot see (waitForPriceAndExecute passes a quote it has
    // already checked against a target price, and silently swapping it would fire
    // the order at a price that does not qualify).
    //
    // The Idempotency-Key does NOT change across these attempts. It is what makes
    // the retry safe: if an earlier attempt reached the server after all, the key
    // resolves to that execution instead of opening a second one.
    const mintedHere = referenceQuoteId === undefined;
    let created: CreateExecutionResponseBody | undefined;
    for (let attempt = 1; created === undefined; attempt += 1) {
      const quoteId =
        referenceQuoteId ??
        (
          await this.getQuote(
            {
              marketId: rest.marketId,
              outcomeId: rest.outcomeId,
              side: rest.side,
              size: rest.size,
            },
            options.signal,
          )
        ).quoteId;
      try {
        created = await this.createExecution(
          { ...rest, referenceQuoteId: quoteId },
          {
            idempotencyKey,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          },
        );
      } catch (error: unknown) {
        // Bounded: a market whose quotes expire faster than we can use them is a
        // condition to report, not one to spin on.
        if (!mintedHere || !isStaleQuote(error) || attempt >= QUOTE_REFRESH_ATTEMPTS) throw error;
      }
    }

    // Past this line the execution EXISTS. A caller's deadline expiring from here
    // on is not "nothing happened" — it is "this process stopped being able to
    // watch", and the order may already be filled. Throwing here would report a
    // live order as a failure, and a caller that believes a failure retries: that
    // is the duplicate this whole design exists to prevent (plan §9:
    // EXECUTION_TIMEOUT and UNKNOWN_PENDING must never map to a failed trade).
    //
    // So an ABORT after the create resolves the same way a wait that ran out of
    // time already does: `timedOut: true`, with the execution id intact, which is
    // the handle `order reconcile` needs. Anything that is NOT an abort still
    // throws — a rejected submit is a real refusal and must stay one.
    try {
      const signature = await signBase64(this.signer, created.sponsoredTransactionBytes);
      const submitted = await this.submitExecution(
        created.executionId,
        signature,
        options.signal,
      );

      const outcome =
        options.waitFor === 'TERMINAL'
          ? await this.waitForExecution(created.executionId, options)
          : toExecutionOutcome(submitted, false);

      return {
        ...outcome,
      // The submit's digest is kept as a fallback: a later read may not carry one
      // yet, and losing it would cost the caller the only on-chain handle it has.
        transactionDigest: outcome.transactionDigest ?? submitted.transactionDigest,
        enforcedWorstPrice: created.enforcedWorstPrice,
        idempotencyKey,
      };
    } catch (error: unknown) {
      if (!isAbortLike(error)) throw error;
      return {
        executionId: created.executionId,
        // The last status anybody observed. Reported as-is rather than guessed
        // forward: the order may have moved since, which is exactly the point.
        status: created.status,
        terminal: false,
        timedOut: true,
        transactionDigest: undefined,
        fill: undefined,
        // Nothing was observed, which is not the same as no fee. The reason says so.
        fee: { available: false, reason: 'NO_FILL_OBSERVED' },
        remainingAllowance: undefined,
        enforcedWorstPrice: created.enforcedWorstPrice,
        idempotencyKey,
      };
    }
  }

  /**
   * Run several intents. Each leg is fully independent: its own execution, key,
   * quote and protection — there is no atomicity across legs and none is implied.
   */
  async executeMany(
    intents: readonly ExecuteMarketOrderIntent[],
    options: ExecuteManyOptions = {},
  ): Promise<ExecuteManyResult[]> {
    const concurrency = Math.max(1, options.concurrency ?? 1);
    const stopOnFailure = (options.failurePolicy ?? 'STOP') === 'STOP';
    const results: ExecuteManyResult[] = new Array<ExecuteManyResult>(intents.length);
    let next = 0;
    let halted = false;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= intents.length) return;
        const intent = intents[index];
        if (intent === undefined) return;
        if (halted) {
          // Not launched. Reported distinctly from a failure so a caller can
          // resubmit exactly these.
          results[index] = { ok: false, index, skipped: true };
          continue;
        }
        try {
          results[index] = { ok: true, index, result: await this.executeMarketOrder(intent, options) };
        } catch (error: unknown) {
          results[index] = { ok: false, index, error };
          if (stopOnFailure) halted = true;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, intents.length) }, worker));
    return results;
  }

  /**
   * Watch the price and fire ONE protected order the moment the target is met.
   *
   * The synthetic limit order. It is SDK-side on purpose (spec §4, §24.11): the
   * server stores no target and no conditional order, so nothing here creates
   * backend state that could fire without the strategy running.
   *
   * The sequence that matters:
   *   1. sample the price until the target is reached for this SIDE;
   *   2. take a FRESH quote — the sampled price is up to one interval old and is
   *      not the thing an order may be priced against;
   *   3. RE-VERIFY the target against that fresh quote. If the market moved back,
   *      keep waiting instead of firing on a price that no longer qualifies;
   *   4. submit exactly once.
   *
   * Step 3 is the one people leave out, and skipping it means the order is priced
   * off a stale sample. Step 4 is guaranteed twice over: an in-process latch, plus
   * one idempotency key minted BEFORE the loop, so even a caller who re-enters
   * this method with the same key cannot produce a second order.
   */
  async waitForPriceAndExecute(
    intent: WaitForPriceIntent,
    options: WaitForPriceOptions = {},
  ): Promise<ExecuteMarketOrderResult> {
    // Minted once, outside the loop. This is the whole "never submits twice after
    // reconnect or timeout ambiguity" guarantee — every attempt carries it.
    const idempotencyKey = intent.idempotencyKey ?? randomUUID();
    const interval = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    const deadline = Date.now() + (options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    const quoteRequest: CreateQuoteRequestBody = {
      marketId: intent.marketId,
      outcomeId: intent.outcomeId,
      side: intent.side,
      size: intent.size,
    };
    let submitted = false;
    // Brackets the subscription to this wait exactly: a watcher that pushes needs
    // to know when to start and, more importantly, when to stop. The `finally`
    // below releases it however the wait ends — target hit, timeout, abort, or a
    // throw out of the middle of an order.
    const release = this.watcher.watch?.(quoteRequest);

    try {
      for (;;) {
        options.signal?.throwIfAborted();

        const observed = await this.watcher.currentPrice(quoteRequest, options.signal);
        if (observed !== null && targetReached(intent.side, observed, intent.targetPrice)) {
          // Fresh quote: the observation above is a trigger, never the price the
          // order is built on. This holds whether the trigger came from a poll or
          // from a streamed frame — a streamed price is indicative by protocol and
          // is not executable at all.
          const quote = await this.getQuote(quoteRequest, options.signal);
          if (targetReached(intent.side, quote.expectedPrice, intent.targetPrice)) {
            if (submitted) {
              throw new Error('waitForPriceAndExecute attempted a second submission');
            }
            submitted = true;
            return await this.executeMarketOrder(
              {
                accountId: intent.accountId,
                marketId: intent.marketId,
                outcomeId: intent.outcomeId,
                side: intent.side,
                size: intent.size,
                referenceQuoteId: quote.quoteId,
                maxSlippageBps: intent.maxSlippageBps,
                idempotencyKey,
                ...(intent.positionId !== undefined ? { positionId: intent.positionId } : {}),
                ...(intent.worstAcceptablePrice !== undefined
                  ? { worstAcceptablePrice: intent.worstAcceptablePrice }
                  : {}),
                ...(intent.strategyId !== undefined ? { strategyId: intent.strategyId } : {}),
                ...(intent.clientOrderId !== undefined
                  ? { clientOrderId: intent.clientOrderId }
                  : {}),
              },
              options,
            );
          }
          // The market moved back between the sample and the fresh quote. Keep
          // waiting — firing here would trade at a price that does not qualify.
        }

        if (Date.now() >= deadline) {
          throw new PredictAgentApiError(504, {
            code: 'EXECUTION_TIMEOUT',
            message: `Target ${intent.targetPrice} was not reached before the wait expired; nothing was submitted`,
            retryable: false,
          });
        }
        // Clamped to the deadline and cut short by an abort. A price wait defaults
        // to an hour, so sleeping past either one strands a cancelled strategy for
        // a full interval and reports the timeout late.
        //
        // With a pushing watcher the interval becomes a CEILING rather than a
        // period: `waitForChange` returns as soon as a frame says the price may
        // have moved. It is still bounded by the same sleep, so a stream that goes
        // quiet or dies leaves the wait polling exactly as it always did.
        const idleMs = Math.max(0, Math.min(interval, deadline - Date.now()));
        if (this.watcher.waitForChange !== undefined) {
          await this.watcher.waitForChange(quoteRequest, idleMs, options.signal);
        } else {
          await sleep(idleMs, options.signal);
        }
      }
    } finally {
      // An adapter that throws on release must not turn a completed order into a
      // failed call.
      try {
        release?.();
      } catch {
        /* ignore */
      }
    }
  }

  async getExecution(
    executionId: string,
    signal?: AbortSignal,
  ): Promise<SubmitExecutionResponseBody> {
    return await this.transport.request<SubmitExecutionResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.getExecution.replace(':executionId', executionId),
      authenticated: true,
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async getAllowance(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<PredictAllowanceResponseBody> {
    return await this.transport.request<PredictAllowanceResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.allowance.replace(':accountId', accountId),
      authenticated: true,
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * The mandate, the allowance, the window already used, the delegation behind
   * it, and the reasons a write would be refused — all stamped with one `asOf`.
   *
   * Prefer this over `getAllowance` when sizing: assembling the same picture from
   * separate calls gives separate instants, and the gap is where an order gets
   * sized against headroom that is already gone.
   *
   * An empty `blockers` is NOT a promise of a fill. It says only that the limits
   * published here do not currently refuse an order — the market must still be
   * tradeable, the quote executable, and the chain decides last.
   */
  async getEffectiveLimits(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<PredictEffectiveLimitsResponseBody> {
    return await this.transport.request<PredictEffectiveLimitsResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.effectiveLimits.replace(':accountId', accountId),
      authenticated: true,
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Positions this agent opened on one account, newest first.
   *
   * Pass `{ cursor }` from the previous response's `nextCursor` to continue.
   * `nextCursor: null` is the end of the history; an ABSENT `nextCursor` means
   * the server did not answer the question and the walk is incomplete — see
   * {@link isExhausted}.
   */
  async getPositions(
    accountId: string,
    page?: PredictAgentListQuery,
    signal?: AbortSignal,
  ): Promise<ListPositionsResponseBody> {
    return await this.transport.request<ListPositionsResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.positions.replace(':accountId', accountId),
      query: pageQuery(page),
      authenticated: true,
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /** This agent's order history on one account, newest first. Paged like {@link getPositions}. */
  async listExecutions(
    accountId: string,
    page?: PredictAgentListQuery,
    signal?: AbortSignal,
  ): Promise<ListExecutionsResponseBody> {
    return await this.transport.request<ListExecutionsResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.listExecutions.replace(':accountId', accountId),
      query: pageQuery(page),
      authenticated: true,
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /** This agent's confirmed fills on one account, newest first. Paged like {@link getPositions}. */
  async getFills(
    accountId: string,
    page?: PredictAgentListQuery,
    signal?: AbortSignal,
  ): Promise<ListFillsResponseBody> {
    return await this.transport.request<ListFillsResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.fills.replace(':accountId', accountId),
      query: pageQuery(page),
      authenticated: true,
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Order-outcome rates and realized PnL for this agent, over the orders THIS API
   * executed and nothing else.
   *
   * `attributionScope` is `API_ATTRIBUTED_ONLY` and there is no other mode. The
   * same delegated key can trade these markets directly on chain; that activity
   * is not represented here at any confidence, and `excluded` counts what was
   * left out — positions that were CLAIMED rather than sold never pass through
   * this API at all, so they bias `winRate` downward by the most.
   *
   * Every rate is `null`, not `"0"`, when its denominator is zero. A strategy
   * that sizes off a win rate must branch on that: `"0"` reads as "everything
   * lost", and `null` means "nothing has closed yet".
   *
   * Lifetime-to-date, with no time window — the exclusions have no recorded
   * instant, so a windowed total would silently disagree with them.
   */
  async getPerformance(
    accountId: string,
    strategyId?: string,
    signal?: AbortSignal,
  ): Promise<PredictAgentPerformanceResponseBody> {
    return await this.transport.request<PredictAgentPerformanceResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.performance.replace(':accountId', accountId),
      ...(strategyId !== undefined ? { query: { strategyId } } : {}),
      authenticated: true,
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * The tradeable catalog.
   *
   * The prices on an outcome are INDICATIVE — top-of-book, no depth, not
   * committable. Call `getQuote` before acting on one; a strategy that trades off
   * `indicativeAsk` is trading off a number nothing will honour.
   *
   * Filtering on `status` or `tradeable` narrows AFTER the server assembles the
   * page, so a filtered result can be shorter than `limit` without the catalog
   * being exhausted — ask for more than you need when using them.
   */
  async getMarkets(
    query: ListMarketsQuery = {},
    signal?: AbortSignal,
  ): Promise<ListMarketsResponseBody> {
    return await this.transport.request<ListMarketsResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.markets,
      query: toMarketQuery(query),
      authenticated: true,
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Free text → a market identity, resolved BY THE SERVER.
   *
   * `getMarkets` with `search` set, given its own name and its own return type
   * because the guarantee is different: this one always comes back with a
   * `resolution`, and a caller can branch on it without checking whether the
   * field is there.
   *
   * `resolution.marketId` is non-null ONLY when exactly one market matched.
   * AMBIGUOUS is a real answer — the candidates are in `markets` — and choosing
   * one of them here would be this SDK resolving an identity the server refused
   * to resolve, which is precisely the failure the whole search endpoint exists
   * to prevent. `matchCount` is counted over the full filtered catalog before
   * `limit` truncates the page, so a one-row page is not a unique match.
   */
  async searchMarkets(
    query: ListMarketsQuery & { search: string },
    signal?: AbortSignal,
  ): Promise<ListMarketsResponseBody & { resolution: PredictMarketResolution }> {
    const response = await this.getMarkets(query, signal);
    if (response.resolution !== undefined) {
      return { ...response, resolution: response.resolution };
    }
    // A server that answered a search without a resolution is older than this
    // client. Reporting NOT_FOUND is the only safe reading: it withholds an id
    // rather than inferring one from a page that was never scored.
    return {
      ...response,
      resolution: {
        status: 'NOT_FOUND',
        normalizedQuery: '',
        marketId: null,
        matchCount: response.markets.length,
      },
    };
  }

  /** One market by its on-chain id. A closed market resolves; an unknown one 404s. */
  async getMarket(marketId: string, signal?: AbortSignal): Promise<GetMarketResponseBody> {
    return await this.transport.request<GetMarketResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.market.replace(':marketId', marketId),
      authenticated: true,
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Wait until the execution stops moving, then report what it settled as.
   *
   * Also the reconciliation entry point: a wait that timed out earlier, or a
   * process that restarted holding only an execution id, resumes by calling this.
   *
   * Running out of time is NOT an error here and does not cancel anything — the
   * order is on-chain and a keeper may still fill it. The result comes back with
   * `timedOut: true`, the last observed status, and the execution id, which is
   * exactly what a caller needs to reconcile. Throwing instead would push callers
   * into a catch block to recover facts that are not failures, and the ones who
   * skip it would resubmit an order that is still live.
   */
  async waitForExecution(
    executionId: string,
    options: WaitForExecutionOptions = {},
  ): Promise<ExecutionOutcome> {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const interval = options.pollIntervalMs ?? DEFAULT_POLL_MS;

    // A stream only ever decides WHEN to look; what the execution IS always comes
    // from the REST read below. Frames can be lost (the server says so with
    // `gap: true`) and a socket can die silently, so trusting a frame as the
    // answer would let a wait return a stale status or hang forever.
    const wake = this.subscribeToUpdates(executionId);
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const current = await this.getExecution(executionId, options.signal);
        if (isTerminalExecutionStatus(current.status)) return toExecutionOutcome(current, false);
        if (Date.now() >= deadline) return toExecutionOutcome(current, true);
        // Whichever comes FIRST: a pushed hint, an abort, the poll interval, or
        // the deadline. The interval is retained as a floor on liveness even when
        // a stream is supplied — that is what makes a dead stream degrade instead
        // of hang. Clamping to the deadline is what stops a 30 s interval from
        // overshooting a 5 s timeout by 25 s.
        await wake.next(Math.max(0, Math.min(interval, deadline - Date.now())), options.signal);
      }
    } finally {
      wake.stop();
    }
  }

  /**
   * Release the sockets opened for `executionStream: 'native'` and
   * `quoteStream: 'native'`.
   *
   * Only needed for those options — a caller-supplied stream is the caller's to
   * close, and a client with no stream holds nothing. Safe to call repeatedly; a
   * later wait simply opens a new socket.
   */
  close(): void {
    this.ownedStream?.close();
    this.ownedStream = undefined;
    this.ownedQuoteStream?.close();
    this.ownedQuoteStream = undefined;
  }

  /**
   * The quote stream this client is configured with, or `undefined` for none.
   *
   * For an embedder that wants indicative prices for something other than
   * `waitForPriceAndExecute` — the Runner puts its own `PriceObserver` over this
   * one — and it exists so that embedder does not have to build a second socket
   * with a second handshake and a second copy of the session. With
   * `quoteStream: 'native'` the socket is opened on first call and is still this
   * client's to close, so {@link close} releases it either way.
   *
   * It hands over the stream and never the session: nothing here exposes the
   * bearer token, which is what a caller building its own `SocketQuoteStream`
   * would otherwise need from this object.
   *
   * The returned stream's `seq` is per (connection, topic) and means nothing off
   * the connection that issued it, so there is no cursor here to persist and
   * none to resume from — a resumed subscription's snapshot IS the recovery.
   */
  quoteStream(): QuoteStream | undefined {
    return this.quoteStreamOption === undefined ? undefined : this.requireQuoteStream();
  }

  /**
   * The quote stream backing a price wait, opening the native one on first use.
   *
   * Reached only through the watcher built in the constructor, so it is called
   * only when `quoteStream` was actually configured — hence `require`: there is
   * no undefined case left to handle here.
   */
  private requireQuoteStream(): QuoteStream {
    const option = this.quoteStreamOption;
    if (option === undefined) {
      throw new Error('quote stream requested without configuring one');
    }
    if (option !== 'native') return option;
    this.ownedQuoteStream ??= new SocketQuoteStream({
      baseUrl: this.baseUrl,
      // The same session as the REST calls, so a token rolled over mid-wait is
      // the one the next reconnect presents.
      token: async () => await this.session.require(),
      refreshToken: async (rejected) => await this.session.refresh(rejected),
      ...(this.quoteStreamConnector !== undefined ? { connect: this.quoteStreamConnector } : {}),
    });
    return this.ownedQuoteStream;
  }

  /**
   * The stream backing a wait, opening the native one on first use.
   *
   * Constructed lazily rather than in the constructor so that building a client
   * costs nothing, and so the session exists to mint a handshake token by the
   * time one is asked for.
   */
  private resolveStream(): ExecutionStream | undefined {
    const option = this.streamOption;
    if (option === undefined) return undefined;
    if (option !== 'native') return option;
    this.ownedStream ??= new SocketExecutionStream({
      baseUrl: this.baseUrl,
      // The socket authenticates with the SAME session as the REST calls, so a
      // token rolled over mid-wait is the one the next reconnect presents.
      token: async () => await this.session.require(),
      refreshToken: async (rejected) => await this.session.refresh(rejected),
      ...(this.streamConnector !== undefined ? { connect: this.streamConnector } : {}),
    });
    return this.ownedStream;
  }

  /**
   * Bridges the push seam to the wait loop.
   *
   * Frames that arrive while the loop is mid-request are not lost: they set a
   * pending flag, so the next `next()` returns immediately rather than sleeping
   * through an update that already happened.
   */
  private subscribeToUpdates(executionId: string): {
    next: (timeoutMs: number, signal?: AbortSignal) => Promise<void>;
    stop: () => void;
  } {
    const stream = this.resolveStream();
    if (stream === undefined) {
      return { next: sleep, stop: () => undefined };
    }

    let pending = false;
    let notify: (() => void) | undefined;
    // A stream whose subscribe throws is a stream that does not exist. The wait
    // still has its poll interval, so it degrades rather than failing a trade.
    let unsubscribe: () => void;
    try {
      unsubscribe = stream.onExecutionUpdate(executionId, () => {
        pending = true;
        notify?.();
      });
    } catch {
      return { next: sleep, stop: () => undefined };
    }

    return {
      next: async (timeoutMs, signal) => {
        if (pending) {
          pending = false;
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, timeoutMs);
          // An abort must not wait out the interval: with a 30 s poll a cancelled
          // strategy would otherwise stay resident half a minute after it was
          // told to stop. Removed again below, so a signal reused across many
          // waits does not accumulate listeners.
          signal?.addEventListener('abort', finish, { once: true });
          notify = finish;
          function finish(): void {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            notify = undefined;
            resolve();
          }
        });
        pending = false;
      },
      stop: () => {
        notify = undefined;
        // An adapter that throws on unsubscribe must not fail the caller's trade,
        // which by this point has already completed.
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
      },
    };
  }
}

/**
 * Serializes the catalog filters for the query string.
 *
 * `tradeable` is stringified explicitly rather than spread through: the
 * transport takes strings and numbers, and a raw boolean would be dropped — the
 * value that goes missing being `false`, the filter most likely to be relied on.
 */
function toMarketQuery(query: ListMarketsQuery): Record<string, string | number | undefined> {
  const { tradeable, ...rest } = query;
  return {
    ...rest,
    ...(tradeable !== undefined ? { tradeable: String(tradeable) } : {}),
  };
}
