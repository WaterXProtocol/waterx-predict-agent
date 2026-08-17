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
  type PredictAllowanceResponseBody,
  type PredictEffectiveLimitsResponseBody,
  type PredictMarketResolution,
  type PredictQuote,
  type SubmitExecutionResponseBody,
} from './contract.ts';
import { targetReached } from './decimal.ts';
import { pageQuery } from './pagination.ts';
import { PredictAgentApiError } from './errors.ts';
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
import { AuthSession } from './session.ts';
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
  /** Override how prices are observed. Defaults to polling `POST /quotes`. */
  priceWatcher?: PriceWatcher;
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

export interface ExecuteMarketOrderIntent
  extends Omit<CreateExecutionRequestBody, 'referenceQuoteId'> {
  referenceQuoteId: string;
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
 * How `waitForPriceAndExecute` observes prices.
 *
 * A SEAM, not an abstraction for its own sake. Today the only price source an
 * agent can reach is `POST /quotes`, so the default polls it. Spec §16.1 wants a
 * sequenced quote stream with gap detection instead — but §21.3 says the feed
 * behind it is a ~2 s poll that "cannot reliably satisfy the WS P95", and fixing
 * that lives outside this SDK. When it lands, a WS watcher drops in here and the
 * trigger logic below is untouched.
 */
export interface PriceWatcher {
  /** The current side-appropriate price, or null when there is none right now. */
  currentPrice(request: CreateQuoteRequestBody, signal?: AbortSignal): Promise<string | null>;
}

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
    // Defaults to polling the quote endpoint — the only price source an agent can
    // reach today. See PriceWatcher for why this is a seam.
    this.watcher = options.priceWatcher ?? {
      currentPrice: async (request, signal) => (await this.getQuote(request, signal)).expectedPrice,
    };
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
    const { idempotencyKey: _ignored, ...body } = intent;

    const created = await this.transport.request<CreateExecutionResponseBody>({
      method: 'POST',
      path: PREDICT_AGENT_API_ROUTES.executions,
      body,
      authenticated: true,
      idempotencyKey,
      idempotent: true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    const signature = await signBase64(this.signer, created.sponsoredTransactionBytes);
    const submitted = await this.transport.request<SubmitExecutionResponseBody>({
      method: 'POST',
      path: PREDICT_AGENT_API_ROUTES.submitExecution.replace(
        ':executionId',
        created.executionId,
      ),
      body: { signature },
      authenticated: true,
      idempotent: true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

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

    for (;;) {
      options.signal?.throwIfAborted();

      const observed = await this.watcher.currentPrice(quoteRequest, options.signal);
      if (observed !== null && targetReached(intent.side, observed, intent.targetPrice)) {
        // Fresh quote: the observation above is a trigger, never the price the
        // order is built on.
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
              ...(intent.clientOrderId !== undefined ? { clientOrderId: intent.clientOrderId } : {}),
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
      await sleep(Math.max(0, Math.min(interval, deadline - Date.now())), options.signal);
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
   * Release the socket opened for `executionStream: 'native'`.
   *
   * Only needed for that option — a caller-supplied stream is the caller's to
   * close, and a client with no stream holds nothing. Safe to call repeatedly; a
   * later wait simply opens a new socket.
   */
  close(): void {
    this.ownedStream?.close();
    this.ownedStream = undefined;
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
 * An abortable sleep that RESOLVES on abort rather than rejecting — the callers
 * here re-check their own abort condition at the top of the loop, and rejecting
 * from a timer would bypass the cleanup that runs around it.
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
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
