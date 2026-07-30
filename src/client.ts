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
  type PredictAllowanceResponseBody,
  type PredictExecutionStatus,
  type PredictQuote,
  type SubmitExecutionResponseBody,
} from './contract.ts';
import { targetReached } from './decimal.ts';
import { PredictAgentApiError } from './errors.ts';
import { type AgentSigner, buildAuthMessage, signBase64 } from './signer.ts';
import { Transport, type TransportOptions } from './transport.ts';

/** Statuses from which nothing further will happen without a new request. */
const TERMINAL: ReadonlySet<PredictExecutionStatus> = new Set([
  'FILLED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
]);

export interface PredictAgentClientOptions extends TransportOptions {
  signer: AgentSigner;
  /** Reuse an existing session token instead of authenticating. */
  token?: string;
  /** Override how prices are observed. Defaults to polling `POST /quotes`. */
  priceWatcher?: PriceWatcher;
  /**
   * Push source for execution updates. Supplied, waits react to frames instead of
   * sleeping a fixed interval; omitted, they poll. Either way the terminal state
   * is confirmed over REST, so a gapped or dead stream degrades to the poll path
   * rather than hanging.
   */
  executionStream?: ExecutionStream;
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

export interface ExecuteMarketOrderOptions {
  /**
   * Wait for a terminal status instead of returning at SUBMITTED. The order is
   * already on-chain either way — this only decides when the promise settles.
   */
  waitFor?: 'SUBMITTED' | 'TERMINAL';
  /** Bound on the terminal wait. Exceeding it does NOT cancel the order. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface ExecuteMarketOrderResult {
  executionId: string;
  status: PredictExecutionStatus;
  transactionDigest: string | undefined;
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

/**
 * A push source for execution state (spec §16.2), so a wait costs one connection
 * instead of one request per second per execution.
 *
 * A SEAM for the same reason PriceWatcher is one: this SDK has no runtime
 * dependencies, and the server's stream is Socket.IO. Supplying an adapter is the
 * caller's choice; without one, waits poll exactly as before.
 *
 * Two properties any adapter MUST preserve, because the wait logic relies on them:
 *  - frames may be LOST. The server's ready frame carries `gap: true` when the
 *    replay cursor was too old, and a dropped connection loses frames silently.
 *    So a stream can only ever ACCELERATE a wait, never be its sole source of
 *    truth — `waitForTerminal` still confirms over REST before returning.
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
  private readonly executionStream: ExecutionStream | undefined;
  private token: string | undefined;

  constructor(options: PredictAgentClientOptions) {
    this.transport = new Transport(options);
    this.executionStream = options.executionStream;
    this.signer = options.signer;
    this.token = options.token;
    // Defaults to polling the quote endpoint — the only price source an agent can
    // reach today. See PriceWatcher for why this is a seam.
    this.watcher = options.priceWatcher ?? {
      currentPrice: async (request, signal) => (await this.getQuote(request, signal)).expectedPrice,
    };
  }

  /**
   * Open a session by signing the server's challenge. The timestamp is minted
   * here and embedded in the signed text, so the signature is bound to this
   * moment and this wallet.
   */
  async authenticate(): Promise<AgentAuthResponseBody> {
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
    const response = await this.transport.request<AgentAuthResponseBody>({
      method: 'POST',
      path: PREDICT_AGENT_API_ROUTES.auth,
      body: { walletAddress, signature, message, timestamp },
      idempotent: true,
    });
    this.token = response.token;
    return response;
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
      token: this.requireToken(),
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Create → sign → submit, as one call.
   *
   * The create is retried under a STABLE key, so a timeout mid-create resolves to
   * the original execution instead of a second order. The submit is retried
   * because the server makes a repeated signature submission a no-op.
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
      token: this.requireToken(),
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
      token: this.requireToken(),
      idempotent: true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    const settled =
      options.waitFor === 'TERMINAL'
        ? await this.waitForTerminal(created.executionId, options)
        : submitted;

    return {
      executionId: created.executionId,
      status: settled.status,
      transactionDigest: settled.transactionDigest ?? submitted.transactionDigest,
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
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  async getExecution(
    executionId: string,
    signal?: AbortSignal,
  ): Promise<SubmitExecutionResponseBody> {
    return await this.transport.request<SubmitExecutionResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.getExecution.replace(':executionId', executionId),
      token: this.requireToken(),
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
      token: this.requireToken(),
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async getPositions(
    accountId: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<ListPositionsResponseBody> {
    return await this.transport.request<ListPositionsResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.positions.replace(':accountId', accountId),
      query: { limit },
      token: this.requireToken(),
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async listExecutions(
    accountId: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<ListExecutionsResponseBody> {
    return await this.transport.request<ListExecutionsResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.listExecutions.replace(':accountId', accountId),
      query: { limit },
      token: this.requireToken(),
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /** This agent's confirmed fills on one account, newest first. */
  async getFills(
    accountId: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<ListFillsResponseBody> {
    return await this.transport.request<ListFillsResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.fills.replace(':accountId', accountId),
      query: { limit },
      token: this.requireToken(),
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
      // `tradeable` is stringified explicitly: the transport's query type takes
      // strings and numbers, and letting a boolean through as `undefined` would
      // silently drop `tradeable=false` — the filter most likely to be relied on.
      query: {
        ...query,
        ...(query.tradeable !== undefined ? { tradeable: String(query.tradeable) } : {}),
      },
      token: this.requireToken(),
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /** One market by its on-chain id. A closed market resolves; an unknown one 404s. */
  async getMarket(marketId: string, signal?: AbortSignal): Promise<GetMarketResponseBody> {
    return await this.transport.request<GetMarketResponseBody>({
      method: 'GET',
      path: PREDICT_AGENT_API_ROUTES.market.replace(':marketId', marketId),
      token: this.requireToken(),
      idempotent: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Wait until the execution stops moving.
   *
   * A timeout throws EXECUTION_TIMEOUT but does NOT cancel anything — the order
   * is on-chain and a keeper may still fill it. Callers must treat the timeout as
   * "stop waiting", never as "it did not happen", and re-read the execution later.
   */
  private async waitForTerminal(
    executionId: string,
    options: ExecuteMarketOrderOptions,
  ): Promise<SubmitExecutionResponseBody> {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const interval = options.pollIntervalMs ?? DEFAULT_POLL_MS;

    // A stream only ever decides WHEN to look; what the execution IS always comes
    // from the REST read below. Frames can be lost (the server says so with
    // `gap: true`) and a socket can die silently, so trusting a frame as the
    // answer would let a wait return a stale status or hang forever.
    const wake = this.subscribeToUpdates(executionId);
    try {
      for (;;) {
        const current = await this.getExecution(executionId, options.signal);
        if (TERMINAL.has(current.status)) return current;
        if (Date.now() >= deadline) {
          throw new PredictAgentApiError(504, {
            code: 'EXECUTION_TIMEOUT',
            message: `Execution ${executionId} was still ${current.status} when the wait expired; it may still fill`,
            retryable: false,
            executionId,
          });
        }
        // Whichever comes first: a pushed hint, or the poll interval. The
        // interval is retained as a FLOOR on liveness even when a stream is
        // supplied — that is what makes a dead stream degrade instead of hang.
        await wake.next(interval);
      }
    } finally {
      wake.stop();
    }
  }

  /**
   * Bridges the push seam to the wait loop.
   *
   * Frames that arrive while the loop is mid-request are not lost: they set a
   * pending flag, so the next `next()` returns immediately rather than sleeping
   * through an update that already happened.
   */
  private subscribeToUpdates(executionId: string): {
    next: (timeoutMs: number) => Promise<void>;
    stop: () => void;
  } {
    const stream = this.executionStream;
    if (stream === undefined) {
      return {
        next: async (timeoutMs) => {
          await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        },
        stop: () => undefined,
      };
    }

    let pending = false;
    let notify: (() => void) | undefined;
    const unsubscribe = stream.onExecutionUpdate(executionId, () => {
      pending = true;
      notify?.();
    });

    return {
      next: async (timeoutMs) => {
        if (pending) {
          pending = false;
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, timeoutMs);
          notify = finish;
          function finish(): void {
            clearTimeout(timer);
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

  private requireToken(): string {
    if (this.token === undefined) {
      throw new Error('Not authenticated — call authenticate() or pass a token');
    }
    return this.token;
  }
}
