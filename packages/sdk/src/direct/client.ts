/**
 * `PredictDirectClient` — trade WaterX Predict the way the perp agent does
 * (ADR-0013): public routes, the agent as `delegateSender`, sponsored bytes
 * checked before they are signed, and `/sponsor/execute`.
 *
 * It answers the same questions `PredictAgentClient` does, in the same types, so
 * every surface above keeps one vocabulary. Where a question has no public
 * source it throws `DirectCapabilityUnavailable` rather than approximating one.
 *
 * WHAT MOVED FROM THE SERVER TO HERE, and how each is kept:
 *
 * - **Price protection.** The web app sends no cap; this client always derives
 *   one from a fresh quote and the stated bounds (`protection.ts`), and the chain
 *   enforces it.
 * - **Not placing an order twice.** The intent store reserves a key per intent,
 *   and the sponsored digest is attached to it BEFORE `/sponsor/execute` is
 *   called. A retry of the same intent reads that digest back — from the chain
 *   and the activity feed — instead of building a second order. Only a digest
 *   the chain has not seen after the sponsor session could have expired is
 *   treated as never sent.
 * - **Knowing how it ended.** The activity feed ties the submission digest to
 *   the order ids it opened, and the same order ids to the fill or the
 *   cancellation. Silence there is `SUBMITTED` / `PENDING_FILL`, never a guess.
 * - **Authority.** The on-chain delegation, pre-checked by the backend and
 *   enforced by the contract. There is NO server-side amount limit in this
 *   mode; the ceiling is the caller's execution policy.
 */
import { createHash, randomUUID } from 'node:crypto';

import type {
  GetMarketResponseBody,
  ListAgentAccountsResponseBody,
  ListMarketsQuery,
  ListMarketsResponseBody,
  ListPositionsResponseBody,
  PredictAgentAccountSummary,
  PredictAgentListQuery,
  PredictAgentMarket,
  PredictExecutionFill,
  PredictExecutionStatus,
  PredictExecutionSummary,
  PredictDelegationFacts,
  CreateExecutionRequestBody,
  CreateExecutionResponseBody,
  PredictMarketResolution,
  PredictMarketStatus,
  PredictPositionSummary,
  PredictQuote,
  CreateQuoteRequestBody,
  SubmitExecutionResponseBody,
} from '../contract.ts';
import { PredictAgentApiError, PredictAgentTransportError } from '../errors.ts';
import type { ExecutionOutcome } from '../execution-facts.ts';
import type { IntentStore } from '../intent-store.ts';
import { signBase64, type AgentSigner } from '../signer.ts';
import { sleep } from '../sleep.ts';
import { suiTransactionDigest } from '../sui-digest.ts';
import { normalizeSuiAddress } from '../sui-tx.ts';
import { SuiGraphqlChainReader, type ChainReader } from './chain.ts';
import {
  DirectDeploymentError,
  FetchedDeployment,
  type DeploymentSource,
  type DirectDeployment,
  type DirectNetwork,
} from './deployment.ts';
import { decodeMarketHandle, encodeMarketHandle, type MarketHandle } from './handle.ts';
import { DirectHttp } from './http.ts';
import {
  assertSlippage,
  buyGuards,
  centsToPrice,
  enforcedSellPrice,
  formatPrice,
  formatScaled,
  MONEY_DECIMALS,
  PRICE_ONE,
  parseScaled,
  sellFloor,
  worstAcceptable,
} from './protection.ts';
import { findAbiMismatches, type AbiMismatch } from './abi.ts';
import { DirectVerificationError, verifyDirectTransaction, type DirectExpectation } from './verify.ts';
import {
  PREDICTION_PERMISSIONS,
  PUBLIC_ROUTES as R,
  type PlaceBetBody,
  type PublicActivityEntry,
  type PublicActivityResponse,
  type PublicBet,
  type PublicBetsResponse,
  type PublicBrowseResponse,
  type PublicCatalogMarket,
  type PublicDelegatedResponse,
  type PublicAccount,
  type PublicQuoteBoard,
  type PublicRound,
  type PublicTxResponse,
  type SellBetBody,
} from './wire.ts';

/** Thrown for a question this mode has no public source for. */
export class DirectCapabilityUnavailable extends Error {
  override readonly name = 'DirectCapabilityUnavailable';
  readonly capability: string;

  constructor(capability: string, reason: string) {
    super(`${capability} is not available in direct mode: ${reason}`);
    this.capability = capability;
  }
}

export const isDirectCapabilityUnavailable = (value: unknown): value is DirectCapabilityUnavailable =>
  value instanceof DirectCapabilityUnavailable;

/** What the catalog said about a market, kept for the reads that cannot ask again. */
export interface CatalogEntry {
  readonly marketId: string;
  readonly title: string;
  readonly category: string;
  readonly status: PredictMarketStatus;
  readonly closesAt: string | null;
  readonly eventId: string | null;
  readonly slug: string;
}

export interface MarketCatalog {
  get(marketId: string): CatalogEntry | undefined;
  put(entries: readonly CatalogEntry[]): void;
}

export class InMemoryMarketCatalog implements MarketCatalog {
  private readonly entries = new Map<string, CatalogEntry>();

  get(marketId: string): CatalogEntry | undefined {
    return this.entries.get(marketId);
  }

  put(entries: readonly CatalogEntry[]): void {
    for (const entry of entries) this.entries.set(entry.marketId, entry);
  }
}

export interface PredictDirectClientOptions {
  readonly baseUrl: string;
  readonly network: DirectNetwork;
  readonly signer: AgentSigner;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly intentStore?: IntentStore;
  readonly deployment?: DeploymentSource;
  /** Where the deployment document is read, when not the network's own (a private deployment). */
  readonly deploymentUrl?: string;
  readonly chain?: ChainReader;
  /** Which Sui GraphQL the default chain reader asks, when not the network's public one. */
  readonly suiGraphqlUrl?: string;
  readonly catalog?: MarketCatalog;
  readonly now?: () => number;
  /** How long a submitted order may wait for a fill. Default 60 s, as the web app. */
  readonly orderExpiryMs?: number;
  /** How long a quote from this client may be relied on. Default 5 s. */
  readonly quoteTtlMs?: number;
  /**
   * Refuse to place an order without a durable intent store. A one-shot process
   * (the CLI) sets this: without a record that outlives it, a retry after a lost
   * answer cannot tell an order that executed from one never sent.
   */
  readonly requireIntentStore?: boolean;
  /**
   * Accounts the operator named. Each is verified against the chain and listed
   * beside what the backend's delegation index returns, so a grant the index
   * has not caught up with is still found. Naming one grants nothing: an
   * account whose on-chain delegate table does not hold this wallet is dropped.
   */
  readonly accountHints?: readonly string[];
}

export interface DirectExecuteIntent {
  accountId: string;
  marketId: string;
  outcomeId: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  size: { buyAmount?: string; sellShares?: string };
  positionId?: string;
  maxSlippageBps: number;
  worstAcceptablePrice?: string;
  referenceQuoteId?: string;
  idempotencyKey?: string;
  clientOrderId?: string;
  strategyId?: string;
}

export interface DirectExecuteOptions {
  waitFor?: 'SUBMITTED' | 'TERMINAL';
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  intentStore?: IntentStore;
}

export interface DirectExecuteResult extends ExecutionOutcome {
  enforcedWorstPrice: string;
  idempotencyKey: string;
  idempotencyKeyReplayed: boolean;
}

export type DirectExecuteManyResult =
  | { ok: true; index: number; result: DirectExecuteResult }
  | { ok: false; index: number; error: unknown }
  | { ok: false; index: number; skipped: true };

/* ── Ids this mode composes ─────────────────────────────────────────────── */

const EXECUTION_PREFIX = 'dx1';
const QUOTE_PREFIX = 'dq1';

interface ExecutionRef {
  readonly digest: string;
  readonly owner: string;
  readonly side: 'BUY' | 'SELL';
  readonly positionId: string | undefined;
}

const b64u = (hex: string): string => Buffer.from(hex.replace(/^0x/u, ''), 'hex').toString('base64url');
const unb64u = (value: string): string => `0x${Buffer.from(value, 'base64url').toString('hex')}`;

export function encodeExecutionId(ref: ExecutionRef): string {
  return [EXECUTION_PREFIX, ref.digest, b64u(normalizeSuiAddress(ref.owner)), ref.side === 'BUY' ? 'b' : 's', ref.positionId ?? '-'].join('.');
}

export function decodeExecutionId(value: string): ExecutionRef {
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== EXECUTION_PREFIX || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(parts[1]!)) {
    throw new PredictAgentApiError(0, {
      code: 'INVALID_REQUEST',
      message: `\`${value}\` is not a direct-mode execution id`,
      retryable: false,
    });
  }
  const owner = unb64u(parts[2]!);
  if (owner.length !== 66) {
    throw new PredictAgentApiError(0, { code: 'INVALID_REQUEST', message: 'the execution id names no owner', retryable: false });
  }
  return {
    digest: parts[1]!,
    owner,
    side: parts[3] === 's' ? 'SELL' : 'BUY',
    positionId: parts[4] === '-' ? undefined : parts[4],
  };
}

interface QuoteRef {
  readonly price: bigint;
  readonly expiresAt: number;
  readonly binding: string;
}

const quoteBinding = (marketId: string, outcomeId: string, side: string): string =>
  createHash('sha256').update(`${marketId}|${outcomeId}|${side}`).digest('base64url').slice(0, 12);

const encodeQuoteId = (ref: QuoteRef): string =>
  [QUOTE_PREFIX, ref.price.toString(), String(ref.expiresAt), ref.binding].join('.');

function decodeQuoteId(value: string): QuoteRef | undefined {
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== QUOTE_PREFIX || !/^\d+$/u.test(parts[1]!) || !/^\d+$/u.test(parts[2]!)) {
    return undefined;
  }
  return { price: BigInt(parts[1]!), expiresAt: Number(parts[2]), binding: parts[3]! };
}

/* ── Small helpers ──────────────────────────────────────────────────────── */

const apiError = (
  code: ConstructorParameters<typeof PredictAgentApiError>[1]['code'],
  message: string,
  details?: Record<string, unknown>,
): PredictAgentApiError =>
  new PredictAgentApiError(0, { code, message, retryable: false, ...(details === undefined ? {} : { details }) });

const PHASE_STATUS: Readonly<Record<string, PredictMarketStatus>> = {
  scheduled: 'PREGAME',
  open: 'PREGAME',
  live: 'IN_PLAY',
  ended: 'CLOSED',
};

const iso = (seconds: number | null | undefined): string | null =>
  typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;

const priceText = (cents: number | null | undefined): string | null => {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0 || cents >= 100) return null;
  return formatPrice(centsToPrice(cents));
};

const CARD_ROUTES: Readonly<Record<string, string>> = {
  crypto: 'crypto',
  sport: 'sport',
  'sport-line': 'sport',
  'sport-award': 'sport',
  politics: 'politics',
};
const DETAIL_CATEGORIES = ['prediction', 'politics', 'crypto', 'sport'] as const;

const TERMINAL: ReadonlySet<PredictExecutionStatus> = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED']);

const NO_FILL = { available: false, reason: 'NO_FILL_OBSERVED' } as const;

/**
 * How long after an order's expiry the keeper may still report a fill
 * (`waterx_prediction::KEEPER_FILL_GRACE_MS`, a compile-time constant there).
 * Past it the order cannot fill, and its escrow waits for a cancel.
 */
const KEEPER_FILL_GRACE_MS = 300_000;

/** How long before an order's own expiry its bytes stop being worth signing. */
const SIGN_MARGIN_MS = 10_000;

/** An order's outcome, plus what direct mode can say about one still open. */
export interface DirectExecutionOutcome extends ExecutionOutcome {
  /**
   * Present while the order is still open in the registry. On an `EXPIRED`
   * order the escrow is still held: it is refunded only by a cancel, which the
   * owner (or a delegate holding the cancel permission) may send from
   * `cancellableAfter`.
   */
  openOrder?: {
    readonly orderId: string;
    readonly expiresAt: string;
    readonly fillableUntil: string;
    readonly cancellableAfter: string;
    readonly escrow: string;
  };
}
const EMBEDDED = { available: false, reason: 'EMBEDDED_IN_PRICE' } as const;

/** One on-chain market of a round, with the side that prices each leg. */
interface Leg {
  readonly handle: MarketHandle;
  readonly marketId: string;
}

function legsOf(round: PublicRound): Leg[] {
  const byMarket = new Map<string, { yes?: string; no?: string }>();
  for (const side of round.sides) {
    const trade = side.trade;
    if (trade === undefined) continue;
    const key = normalizeSuiAddress(trade.marketId);
    const entry = byMarket.get(key) ?? {};
    if (trade.selection === 'YES') entry.yes ??= side.key;
    else entry.no ??= side.key;
    byMarket.set(key, entry);
  }
  const legs: Leg[] = [];
  for (const [onchainMarketId, sides] of byMarket) {
    if (sides.yes === undefined) continue;
    const handle: MarketHandle = { roundId: round.id, onchainMarketId, yesSide: sides.yes, noSide: sides.no };
    try {
      legs.push({ handle, marketId: encodeMarketHandle(handle) });
    } catch {
      // A round this client cannot address is left out rather than half-served.
    }
  }
  return legs;
}

/* ── The client ─────────────────────────────────────────────────────────── */

export class PredictDirectClient {
  private readonly http: DirectHttp;
  private readonly signer: AgentSigner;
  private readonly network: DirectNetwork;
  private readonly deployment: DeploymentSource;
  private readonly chain: ChainReader;
  private readonly catalog: MarketCatalog;
  private readonly intentStore: IntentStore | undefined;
  private readonly now: () => number;
  private readonly orderExpiryMs: number;
  private readonly quoteTtlMs: number;
  private readonly requireIntentStore: boolean;
  private delegated: Promise<PublicDelegatedResponse> | undefined;
  private readonly accountHints: readonly string[];
  /** One ABI verdict per set of current packages, for the life of the client. */
  private readonly abiVerdicts = new Map<string, Promise<AbiMismatch[]>>();

  constructor(options: PredictDirectClientOptions) {
    this.http = new DirectHttp({
      baseUrl: options.baseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    this.signer = options.signer;
    this.network = options.network;
    this.deployment =
      options.deployment ??
      new FetchedDeployment({
        network: options.network,
        ...(options.deploymentUrl === undefined ? {} : { url: options.deploymentUrl }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    this.chain =
      options.chain ??
      new SuiGraphqlChainReader({
        network: options.network,
        ...(options.suiGraphqlUrl === undefined ? {} : { url: options.suiGraphqlUrl }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    this.catalog = options.catalog ?? new InMemoryMarketCatalog();
    this.intentStore = options.intentStore;
    this.now = options.now ?? Date.now;
    this.orderExpiryMs = options.orderExpiryMs ?? 60_000;
    this.quoteTtlMs = options.quoteTtlMs ?? 5_000;
    this.requireIntentStore = options.requireIntentStore ?? false;
    this.accountHints = [
      ...new Set(
        (options.accountHints ?? []).filter((id) => /^0x[0-9a-fA-F]{1,64}$/u.test(id)).map((id) => normalizeSuiAddress(id)),
      ),
    ];
  }

  /** Direct mode has no session. Present so a caller need not branch. */
  isAuthenticated(): boolean {
    return true;
  }

  get agentWallet(): string {
    return normalizeSuiAddress(this.signer.toSuiAddress());
  }

  get mode(): 'direct' {
    return 'direct';
  }

  close(): void {
    // Nothing is held open.
  }

  /**
   * The deployment config every transaction is checked against, fetched now.
   * For diagnostics: a direct-mode runtime that cannot read it can place nothing.
   */
  async loadDeployment(signal?: AbortSignal): Promise<DirectDeployment> {
    return await this.deployment.load(signal);
  }

  /* ── The Runner's two-step write ───────────────────────────────────────── */

  /**
   * Build and verify an order, and hand back the bytes to sign — the first half
   * of the Runner's create/submit split (ADR-0016).
   *
   * The Runner persists the execution id between the two halves; in direct mode
   * that id already names the digest, so a submit after a restart needs nothing
   * else. A second create for the same key builds a fresh transaction: the
   * earlier one was never signed, so it can never execute.
   */
  async createExecution(
    request: CreateExecutionRequestBody,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<CreateExecutionResponseBody> {
    const { referenceQuoteId, ...rest } = request;
    const intent: Omit<DirectExecuteIntent, 'idempotencyKey' | 'referenceQuoteId'> = {
      accountId: rest.accountId,
      marketId: rest.marketId,
      outcomeId: rest.outcomeId,
      side: rest.side,
      size: rest.size as DirectExecuteIntent['size'],
      maxSlippageBps: rest.maxSlippageBps,
      ...(rest.positionId === undefined ? {} : { positionId: rest.positionId }),
      ...(rest.worstAcceptablePrice === undefined ? {} : { worstAcceptablePrice: rest.worstAcceptablePrice }),
      ...(rest.clientOrderId === undefined ? {} : { clientOrderId: rest.clientOrderId }),
      ...(rest.strategyId === undefined ? {} : { strategyId: rest.strategyId }),
    };
    assertSlippage(intent.maxSlippageBps);
    const handle = this.decode(intent.marketId);
    if (intent.side === 'SELL' && (intent.positionId === undefined || !/^\d+$/u.test(intent.positionId))) {
      throw apiError('INVALID_REQUEST', 'A SELL names the numeric on-chain position it closes.');
    }
    const verified = await this.buildVerified(intent, handle, referenceQuoteId, options.signal);
    return {
      executionId: verified.executionId,
      status: 'AWAITING_SIGNATURE',
      sponsoredTransactionBytes: verified.built.txBytes,
      sponsoredDigest: verified.built.digest,
      // Signed after this, the order would expire on arrival.
      signatureExpiresAt: new Date(this.now() + Math.max(0, this.orderExpiryMs - SIGN_MARGIN_MS)).toISOString(),
      referenceQuoteId,
      submissionQuoteId: referenceQuoteId,
      enforcedWorstPrice: verified.enforcedWorstPrice,
    };
  }

  /**
   * Hand a signature to the sponsor — the second half. A definitive refusal
   * throws the server's error; anything else that may have executed throws a
   * transport error, and the caller reads the execution back by its id.
   */
  async submitExecution(executionId: string, signature: string, signal?: AbortSignal): Promise<SubmitExecutionResponseBody> {
    const { digest } = decodeExecutionId(executionId);
    let executed: { digest: string };
    try {
      executed = await this.http.post<{ digest: string }>(
        R.sponsorExecute,
        { digest, signature, source: 'agent/waterx-predict-runner' },
        signal,
      );
    } catch (error: unknown) {
      if (error instanceof PredictAgentApiError && error.httpStatus >= 400 && error.httpStatus < 500 && error.code !== 'RATE_LIMITED') {
        throw error;
      }
      throw new PredictAgentTransportError('the sponsored submission did not answer; read the execution back', error);
    }
    if (executed.digest !== digest) {
      throw new PredictAgentTransportError('the sponsor answered for a different transaction; read the execution back', executed.digest);
    }
    return { executionId, status: 'SUBMITTED', transactionDigest: digest };
  }

  /**
   * This wallet's prediction permissions on an account, as the chain holds them
   * now. `false` for a grant that is absent or expired; `null` when the read
   * failed — which is not a refusal.
   */
  async getDelegation(accountId: string, signal?: AbortSignal): Promise<PredictDelegationFacts> {
    const checkedAt = new Date(this.now()).toISOString();
    let row: PublicDelegatedResponse['accounts'][number] | undefined;
    try {
      const wanted = normalizeSuiAddress(accountId);
      row =
        this.chain.account !== undefined
          ? await this.chainDelegation(wanted, signal)
          : (await this.delegatedAccounts(signal, true)).accounts.find(
              (entry) => normalizeSuiAddress(entry.accountId) === wanted,
            );
    } catch {
      return { mayPlaceOrder: null, mayRequestClose: null, checkedAt };
    }
    const mask = row?.delegate.predictPermissions ?? 0;
    return {
      mayPlaceOrder: (mask & PREDICTION_PERMISSIONS.PLACE_ORDER) !== 0,
      mayRequestClose: (mask & PREDICTION_PERMISSIONS.REQUEST_CLOSE) !== 0,
      checkedAt,
    };
  }

  /* ── Contract shapes ──────────────────────────────────────────────────── */

  /**
   * Whether the deployment's current packages still have the call shapes the
   * verifier binds by position (ADR-0015). `undefined` when this client's chain
   * reader cannot read functions — a reader the caller chose, whose absence of
   * an answer is reported rather than guessed.
   */
  async checkAbi(signal?: AbortSignal): Promise<AbiMismatch[] | undefined> {
    const deployment = await this.deployment.load(signal);
    return await this.abiVerdict(deployment, signal);
  }

  private abiVerdict(deployment: DirectDeployment, signal?: AbortSignal): Promise<AbiMismatch[]> | undefined {
    const chain = this.chain;
    if (chain.functionShape === undefined) return undefined;
    const reader = { functionShape: chain.functionShape.bind(chain) };
    const key = JSON.stringify(deployment.callable);
    let verdict = this.abiVerdicts.get(key);
    if (verdict === undefined) {
      verdict = findAbiMismatches(deployment, reader, signal);
      // A failed read is not a verdict: the next order asks again.
      verdict.catch(() => this.abiVerdicts.delete(key));
      this.abiVerdicts.set(key, verdict);
    }
    return verdict;
  }

  /** Refuse to sign against packages whose shapes the verifier does not describe. */
  private async assertAbi(deployment: DirectDeployment, signal?: AbortSignal): Promise<void> {
    let mismatches: AbiMismatch[] | undefined;
    try {
      mismatches = await this.abiVerdict(deployment, signal);
    } catch {
      throw new DirectDeploymentError(
        'the deployment’s contract shapes could not be read from the chain, so nothing was signed; try again',
      );
    }
    if (mismatches !== undefined && mismatches.length > 0) {
      throw new DirectVerificationError(
        'ABI',
        `the deployment’s packages no longer have the call shapes this build checks (${mismatches.map((m) => m.function).join(', ')}); this build needs updating before it can trade`,
      );
    }
  }

  /* ── Accounts ─────────────────────────────────────────────────────────── */

  /**
   * The delegation listing. Order paths share one read; the listing itself
   * always reads afresh (`fresh`), because a caller polling it is waiting for
   * an owner's grant to appear, and a cached answer would never show it.
   */
  private delegatedAccounts(signal?: AbortSignal, fresh = false): Promise<PublicDelegatedResponse> {
    if (fresh) this.delegated = undefined;
    this.delegated ??= this.http
      .get<PublicDelegatedResponse>(R.delegated, { delegate: this.agentWallet }, signal)
      .catch((error: unknown) => {
        this.delegated = undefined;
        throw error;
      });
    return this.delegated;
  }

  /**
   * The accounts whose owner delegated to this wallet, in the Agent API's shape.
   *
   * `mayPlaceOrder` is the EFFECTIVE predict mask (0 once expired). There is no
   * mandate in this mode, so `policyVersion` is 0 and `isSuspended` false — the
   * delegation is the whole grant.
   */
  async listAuthorizedAccounts(signal?: AbortSignal): Promise<ListAgentAccountsResponseBody> {
    // The index is the discovery path; a named account is read from the chain
    // as well, so it is found even while the index lags. When the index read is
    // refused (rate limited, down) and a named account answers, that answer
    // stands; with nothing named, the refusal is the answer.
    let indexed: PublicDelegatedResponse['accounts'] = [];
    let indexError: unknown;
    try {
      indexed = (await this.delegatedAccounts(signal, true)).accounts;
    } catch (error: unknown) {
      if (this.chain.account === undefined) throw error;
      indexError = error;
    }
    const rows = [...indexed];
    const known = (id: string): boolean => rows.some((row) => normalizeSuiAddress(row.accountId) === normalizeSuiAddress(id));
    for (const hint of this.accountHints) {
      if (known(hint)) continue;
      const row = await this.chainDelegation(hint, signal);
      if (row !== undefined) rows.push(row);
    }
    // The index is built from the same events the chain holds, and it can lag
    // (a grant 75 minutes old was missing on testnet) or fail. When it offers
    // nothing, the chain's own recent grant events are the candidates — each
    // re-read from its account object before it counts.
    if (indexed.length === 0 && this.chain.delegationCandidates !== undefined) {
      try {
        const deployment = await this.deployment.load(signal);
        const candidates = await this.chain.delegationCandidates(deployment.originals.account, this.agentWallet, signal);
        for (const candidate of candidates) {
          if (known(candidate)) continue;
          const row = await this.chainDelegation(normalizeSuiAddress(candidate), signal);
          if (row !== undefined) rows.push(row);
        }
      } catch (error: unknown) {
        // With the index refused too there is nothing to answer with.
        if (rows.length === 0 && indexError !== undefined) throw indexError;
        if (rows.length === 0) throw error;
      }
    }
    if (rows.length === 0 && indexError !== undefined) throw indexError;
    const checkedAt = new Date(this.now()).toISOString();
    const accounts: PredictAgentAccountSummary[] = [];
    for (const row of rows) {
      if (row.ownerAddress === null) continue;
      const mask = row.delegate.predictPermissions ?? 0;
      accounts.push({
        accountId: normalizeSuiAddress(row.accountId),
        ownerAddress: normalizeSuiAddress(row.ownerAddress),
        isSuspended: false,
        policyVersion: 0,
        delegation: {
          mayPlaceOrder: (mask & PREDICTION_PERMISSIONS.PLACE_ORDER) !== 0,
          mayRequestClose: (mask & PREDICTION_PERMISSIONS.REQUEST_CLOSE) !== 0,
          checkedAt,
        },
        grantedAt: checkedAt,
        updatedAt: checkedAt,
      });
    }
    return { accounts };
  }

  /**
   * This wallet's delegation on one account, read from the chain itself.
   *
   * The object must be the deployment's `account::Account` type, and the
   * prediction mask is the one keyed by the deployment's own
   * `account_data::WaterXPrediction` type — a same-named type from any other
   * package is not it. An expired entry reads as mask 0. `undefined` when the
   * reader cannot answer, the object is no account, or this wallet is not a
   * delegate; a failed read throws.
   */
  private async chainDelegation(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<PublicDelegatedResponse['accounts'][number] | undefined> {
    if (this.chain.account === undefined) return undefined;
    const [deployment, account] = await Promise.all([
      this.deployment.load(signal),
      this.chain.account(accountId, signal),
    ]);
    if (account === undefined) return undefined;
    const typeOf = (repr: string): { address: string; rest: string } | undefined => {
      const at = repr.indexOf('::');
      if (at <= 0) return undefined;
      const head = repr.slice(0, at);
      const address = head.startsWith('0x') ? head : `0x${head}`;
      if (!/^0x[0-9a-fA-F]{1,64}$/u.test(address)) return undefined;
      return { address: normalizeSuiAddress(address), rest: repr.slice(at) };
    };
    const accountType = typeOf(account.type);
    if (accountType?.address !== deployment.originals.account || accountType.rest !== '::account::Account') {
      return undefined;
    }
    const agent = this.agentWallet;
    const entry = account.delegates.find((row) => normalizeSuiAddress(row.address) === agent);
    if (entry === undefined) return undefined;
    const key = entry.protocolPermissions.find((permission) => {
      const parsed = typeOf(permission.keyType);
      return parsed?.address === deployment.originals.prediction && parsed.rest === '::account_data::WaterXPrediction';
    });
    const expired = entry.expiresAtMs !== null && entry.expiresAtMs <= this.now();
    return {
      accountId: normalizeSuiAddress(accountId),
      ownerAddress: normalizeSuiAddress(account.owner),
      delegate: {
        delegateAddress: agent,
        predictPermissions: expired ? 0 : (key?.mask ?? 0),
        expiresAtMs: entry.expiresAtMs,
        ...(expired ? { expired: true as const } : {}),
      },
    };
  }

  private async ownerOf(accountId: string, permission: number, signal?: AbortSignal): Promise<string> {
    const wanted = normalizeSuiAddress(accountId);
    // The chain first: it is the authority, it answers for exactly this account
    // in one read, and it does not lag. The index is the fallback for a reader
    // that cannot read accounts.
    const row =
      this.chain.account !== undefined
        ? await this.chainDelegation(wanted, signal)
        : (await this.delegatedAccounts(signal)).accounts.find(
            (entry) => normalizeSuiAddress(entry.accountId) === wanted,
          );
    if (row === undefined || row.ownerAddress === null) {
      throw apiError(
        'DELEGATION_PERMISSION_DENIED',
        `This agent holds no verified delegation on account ${wanted}. The owner grants one at the console.`,
        { accountId: wanted },
      );
    }
    if (permission !== 0 && ((row.delegate.predictPermissions ?? 0) & permission) === 0) {
      throw apiError(
        'DELEGATION_PERMISSION_DENIED',
        `The delegation on account ${wanted} does not include the predict permission this order needs${row.delegate.expired === true ? ' (it has expired)' : ''}.`,
        { accountId: wanted, predictPermissions: row.delegate.predictPermissions, permission },
      );
    }
    return normalizeSuiAddress(row.ownerAddress);
  }

  /* ── Markets and quotes ───────────────────────────────────────────────── */

  private async boards(roundIds: readonly string[], signal?: AbortSignal): Promise<{
    ask: PublicQuoteBoard;
    bid: PublicQuoteBoard;
    no: PublicQuoteBoard;
  }> {
    if (roundIds.length === 0) return { ask: {}, bid: {}, no: {} };
    const rounds = [...new Set(roundIds)].slice(0, 100).join(',');
    const read = (path: string): Promise<PublicQuoteBoard> =>
      this.http.get<PublicQuoteBoard>(path, { rounds }, signal).catch(() => ({}));
    const [ask, bid, no] = await Promise.all([read(R.quotes), read(R.quotesBid), read(R.quotesNo)]);
    return { ask, bid, no };
  }

  private project(
    market: PublicCatalogMarket,
    round: PublicRound,
    boards: Awaited<ReturnType<PredictDirectClient['boards']>>,
  ): PredictAgentMarket[] {
    const status = PHASE_STATUS[round.phase] ?? 'PREGAME';
    const updatedAt = new Date(this.now()).toISOString();
    const out: PredictAgentMarket[] = [];
    const legs = legsOf(round);
    for (const leg of legs) {
      const { yesSide, noSide } = leg.handle;
      const ask = boards.ask[round.id] ?? {};
      const bid = boards.bid[round.id] ?? {};
      const yesAsk = priceText(ask[yesSide]);
      const noAsk = priceText(noSide === undefined ? boards.no[round.id]?.[yesSide] : ask[noSide]);
      const tradeable = status !== 'CLOSED' && yesAsk !== null;
      const base = market.title ?? market.display?.question ?? market.slug;
      const title = legs.length > 1 ? `${base} — ${yesSide}` : base;
      out.push({
        marketId: leg.marketId,
        title,
        category: market.category,
        status,
        tradeable,
        ...(tradeable ? {} : { tradeabilityReason: status === 'CLOSED' ? 'ROUND_ENDED' : 'NO_LIVE_QUOTE' }),
        event: { eventId: market.eventId ?? null, ...(round.startsAt === null ? {} : { startsAt: iso(round.startsAt)! }) },
        outcomes: [
          {
            outcomeId: 'YES',
            name: yesSide,
            impliedProbability: null,
            indicativeBid: priceText(bid[yesSide]),
            indicativeAsk: yesAsk,
          },
          {
            outcomeId: 'NO',
            name: noSide ?? `not ${yesSide}`,
            impliedProbability: null,
            indicativeBid: noSide === undefined ? null : priceText(bid[noSide]),
            indicativeAsk: noAsk,
          },
        ],
        aliases: [market.slug],
        closesAt: iso(round.endsAt),
        updatedAt,
      });
    }
    this.catalog.put(
      out.map((entry) => ({
        marketId: entry.marketId,
        title: entry.title,
        category: entry.category,
        status: entry.status,
        closesAt: entry.closesAt,
        eventId: market.eventId ?? null,
        slug: market.slug,
      })),
    );
    return out;
  }

  /**
   * The catalog, from `/predict/browse`, one market per on-chain market of each
   * listed round. `search` is matched by the SERVER (`q`); the resolution says
   * RESOLVED only when exactly one market came back AND the server said there
   * are no more pages — a page of one is not a unique answer.
   */
  async getMarkets(query: ListMarketsQuery = {}, signal?: AbortSignal): Promise<ListMarketsResponseBody> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 50);
    const page = await this.http.get<PublicBrowseResponse>(
      R.browse,
      { limit, ...(query.search === undefined ? {} : { q: query.search }) },
      signal,
    );
    const rounds = page.items.flatMap((item) => (item.nextRound?.id === undefined ? [] : [item.nextRound.id]));
    const boards = await this.boards(rounds, signal);
    let markets = page.items.flatMap((item) =>
      item.market === undefined || item.nextRound === undefined || item.nextRound === null
        ? []
        : this.project(item.market, item.nextRound, boards),
    );
    if (query.category !== undefined) {
      const wanted = query.category.toLowerCase();
      markets = markets.filter((market) => market.category.toLowerCase() === wanted);
    }
    if (query.status !== undefined) markets = markets.filter((market) => market.status === query.status);
    if (query.tradeable !== undefined) markets = markets.filter((market) => market.tradeable === query.tradeable);
    if (query.search === undefined) return { markets };

    const more = page.nextCursor !== null && page.nextCursor !== undefined;
    const resolution: PredictMarketResolution = {
      status: markets.length === 0 ? (more ? 'AMBIGUOUS' : 'NOT_FOUND') : markets.length === 1 && !more ? 'RESOLVED' : 'AMBIGUOUS',
      normalizedQuery: query.search.trim().toLowerCase(),
      marketId: markets.length === 1 && !more ? markets[0]!.marketId : null,
      matchCount: markets.length,
    };
    return { markets, resolution };
  }

  async searchMarkets(
    query: ListMarketsQuery & { search: string },
    signal?: AbortSignal,
  ): Promise<ListMarketsResponseBody & { resolution: PredictMarketResolution }> {
    const response = await this.getMarkets(query, signal);
    return { ...response, resolution: response.resolution! };
  }

  private decode(marketId: string): MarketHandle {
    try {
      return decodeMarketHandle(marketId);
    } catch (error: unknown) {
      throw apiError('INVALID_REQUEST', error instanceof Error ? error.message : 'not a market id', { marketId });
    }
  }

  /**
   * One market by id. Prices are live; the title and schedule come from the
   * catalog as this process last saw it, and say so when it has not seen it.
   */
  async getMarket(marketId: string, signal?: AbortSignal): Promise<GetMarketResponseBody> {
    const handle = this.decode(marketId);
    const known = this.catalog.get(marketId);
    const [boards, live] = await Promise.all([
      this.boards([handle.roundId], signal),
      known === undefined ? Promise.resolve(undefined) : this.liveRound(known, handle.roundId, signal),
    ]);
    const round: PublicRound = {
      id: handle.roundId,
      marketId: '',
      // Live when the market's page answers: a round that is no longer the
      // market's current one has ended. Otherwise the phase last listed.
      phase:
        live !== undefined
          ? live.phase
          : known?.status === 'CLOSED'
            ? 'ended'
            : known?.status === 'IN_PLAY'
              ? 'live'
              : 'open',
      startsAt: null,
      endsAt:
        live?.endsAt !== undefined && live.endsAt !== null
          ? live.endsAt
          : known?.closesAt === null || known?.closesAt === undefined
            ? null
            : Date.parse(known.closesAt) / 1000,
      sides: [
        { key: handle.yesSide, oddsCents: null, trade: { marketId: handle.onchainMarketId, selection: 'YES' } },
        ...(handle.noSide === undefined
          ? []
          : [{ key: handle.noSide, oddsCents: null, trade: { marketId: handle.onchainMarketId, selection: 'NO' as const } }]),
      ],
    };
    const [market] = this.project(
      {
        id: '',
        slug: known?.slug ?? '',
        title: known?.title ?? `Round ${handle.roundId} (title not cached: resolve it with market search)`,
        category: known?.category ?? 'UNKNOWN',
        eventId: known?.eventId ?? null,
      },
      round,
      boards,
    );
    if (market === undefined) throw apiError('POSITION_NOT_FOUND', 'Unknown market', { marketId });
    return { market: { ...market, marketId } };
  }

  /**
   * The round's phase from the market's own page, or undefined when the page
   * cannot be read. The page shows the market's CURRENT round: if that is not
   * the round this id trades, the round has ended.
   */
  private async liveRound(
    known: CatalogEntry,
    roundId: string,
    signal?: AbortSignal,
  ): Promise<{ phase: string; endsAt: number | null } | undefined> {
    if (known.slug === '') return undefined;
    const preferred = DETAIL_CATEGORIES.find((category) => category === known.category);
    const categories = preferred === undefined ? DETAIL_CATEGORIES : [preferred, ...DETAIL_CATEGORIES.filter((c) => c !== preferred)];
    for (const category of categories) {
      let detail: { detail?: { round?: PublicRound } };
      try {
        detail = await this.http.get(`predict/markets/${category}/${encodeURIComponent(known.slug)}`, undefined, signal);
      } catch (error: unknown) {
        // Not under this category: try the next. Anything else — the network,
        // a rate limit — is not going to be different under another name.
        if (error instanceof PredictAgentApiError && error.httpStatus === 404) continue;
        return undefined;
      }
      const current = detail.detail?.round;
      if (current === undefined) continue;
      return current.id === roundId
        ? { phase: current.phase, endsAt: current.endsAt ?? null }
        : { phase: 'ended', endsAt: null };
    }
    return undefined;
  }

  private async legPrice(
    handle: MarketHandle,
    outcomeId: 'YES' | 'NO',
    side: 'BUY' | 'SELL',
    signal?: AbortSignal,
  ): Promise<bigint> {
    const boards = await this.boards([handle.roundId], signal);
    const round = handle.roundId;
    let cents: number | null | undefined;
    if (side === 'BUY') {
      cents =
        outcomeId === 'YES'
          ? boards.ask[round]?.[handle.yesSide]
          : handle.noSide === undefined
            ? boards.no[round]?.[handle.yesSide]
            : boards.ask[round]?.[handle.noSide];
    } else {
      cents =
        outcomeId === 'YES'
          ? boards.bid[round]?.[handle.yesSide]
          : handle.noSide === undefined
            ? undefined
            : boards.bid[round]?.[handle.noSide];
    }
    if (typeof cents !== 'number') {
      throw new PredictAgentApiError(0, {
        code: 'QUOTE_UNAVAILABLE',
        message: `There is no live ${side === 'BUY' ? 'ask' : 'bid'} for ${outcomeId} on this market.`,
        retryable: true,
        details: { roundId: round, outcomeId, side },
      });
    }
    return centsToPrice(cents);
  }

  /**
   * A reference price, in the Agent API's quote shape.
   *
   * NOT executable on a server: nothing here reserves anything. Its id carries
   * the price and an expiry, and an order that names it is protected relative to
   * that price — the cap the chain enforces is derived from it.
   */
  async getQuote(request: CreateQuoteRequestBody, signal?: AbortSignal): Promise<PredictQuote> {
    const handle = this.decode(request.marketId);
    const price = await this.legPrice(handle, request.outcomeId, request.side, signal);
    const asOf = this.now();
    const expiresAt = asOf + this.quoteTtlMs;
    return {
      quoteId: encodeQuoteId({ price, expiresAt, binding: quoteBinding(request.marketId, request.outcomeId, request.side) }),
      marketId: request.marketId,
      outcomeId: request.outcomeId,
      side: request.side,
      expectedPrice: formatPrice(price),
      expectedFillSize: null,
      availableSize: null,
      feeAmount: null,
      liquidityTier: 'C',
      qualityFlags: ['TOP_OF_BOOK_ONLY', 'DIRECT_REFERENCE_ONLY'],
      asOf: new Date(asOf).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      onchainMarketIdHex: handle.onchainMarketId,
      onchainSelection: request.outcomeId,
    };
  }

  /* ── Orders ───────────────────────────────────────────────────────────── */

  async executeMarketOrder(intent: DirectExecuteIntent, options: DirectExecuteOptions = {}): Promise<DirectExecuteResult> {
    const store = options.intentStore ?? this.intentStore;
    const { idempotencyKey: explicitKey, referenceQuoteId, ...rest } = intent;
    if (store === undefined && this.requireIntentStore) {
      throw apiError(
        'INVALID_REQUEST',
        'Direct mode places no order without a durable intent store: a retry after a lost answer could not tell an executed order from one never sent.',
      );
    }
    assertSlippage(rest.maxSlippageBps);
    const handle = this.decode(rest.marketId);
    if (rest.side === 'SELL' && (rest.positionId === undefined || !/^\d+$/u.test(rest.positionId))) {
      throw apiError('INVALID_REQUEST', 'A SELL names the numeric on-chain position it closes.');
    }

    // No key means anything to the server in this mode, so the journal is what
    // makes a retry a read-back. A caller's own key is bound INTO the recorded
    // intent: the same intent under the same key is one order, and under a new
    // key it is a new one — the contract the Agent API gives a key.
    // `journalKey` is the store's handle on that record; `idempotencyKey` is
    // what the caller sees.
    const recorded: Record<string, unknown> =
      explicitKey === undefined ? rest : { ...rest, callerIdempotencyKey: explicitKey };
    let journalKey: string | undefined;
    let idempotencyKey: string;
    let replayed = false;
    if (store !== undefined) {
      const reservation = await store.reserve(recorded);
      journalKey = reservation.idempotencyKey;
      replayed = reservation.replayed;
      const known = reservation.record;
      if (known.executionId !== undefined && known.executionId.startsWith(`${EXECUTION_PREFIX}.`)) {
        const resolved = await this.resolveRecorded(known, journalKey, explicitKey ?? journalKey, store, options);
        if (resolved !== 'NEVER_LANDED') return resolved;
        // The earlier attempt provably never executed. Its record goes, and this
        // attempt gets a fresh one — the key has no meaning on the server here,
        // so a new key cannot collide with anything that happened.
        await store.forget(journalKey);
        const fresh = await store.reserve(recorded);
        journalKey = fresh.idempotencyKey;
        replayed = false;
      }
      idempotencyKey = explicitKey ?? journalKey;
    } else {
      idempotencyKey = explicitKey ?? randomUUID();
    }

    // Flipped immediately before `/sponsor/execute`. Until then, nothing this
    // attempt did can have reached the chain, whatever throws.
    let sent = false;
    try {
      const { built, enforcedWorstPrice, executionId } = await this.buildVerified(
        rest,
        handle,
        referenceQuoteId,
        options.signal,
      );

      // On file BEFORE the submission leaves this process: from here on, a retry
      // of this intent reads this digest back instead of building a second order.
      if (store !== undefined && journalKey !== undefined) {
        await store.attach(journalKey, executionId, enforcedWorstPrice);
      }
      const signature = await signBase64(this.signer, built.txBytes);

      let submittedDigest: string;
      sent = true;
      try {
        const executed = await this.http.post<{ digest: string }>(
          R.sponsorExecute,
          { digest: built.digest, signature, source: 'agent/waterx-predict' },
          options.signal,
        );
        submittedDigest = executed.digest;
      } catch (error: unknown) {
        // A definitive refusal executed nothing: an expired sponsor session, or a
        // dry run that would fail. Anything else — a 5xx, a dropped connection,
        // an abort — may have executed, and is resolved by reading, not by
        // sending again.
        const definitive =
          error instanceof PredictAgentApiError &&
          error.httpStatus >= 400 &&
          error.httpStatus < 500 &&
          error.code !== 'RATE_LIMITED';
        if (definitive) {
          // Nothing executed, and in this mode a key means nothing to the server:
          // the record goes, so the same intent can be built again from scratch.
          if (store !== undefined && journalKey !== undefined) await store.forget(journalKey);
          throw error;
        }
        return {
          executionId,
          status: 'SUBMITTING',
          terminal: false,
          timedOut: true,
          transactionDigest: built.digest,
          fill: undefined,
          fee: NO_FILL,
          remainingAllowance: undefined,
          enforcedWorstPrice,
          idempotencyKey,
          idempotencyKeyReplayed: replayed,
        };
      }

      if (submittedDigest !== built.digest) {
        // The sponsor answered for a different transaction than the one signed.
        // What happened to ours is read back by its own digest, not assumed.
        return {
          executionId,
          status: 'SUBMITTING',
          terminal: false,
          timedOut: true,
          transactionDigest: built.digest,
          fill: undefined,
          fee: NO_FILL,
          remainingAllowance: undefined,
          enforcedWorstPrice,
          idempotencyKey,
          idempotencyKeyReplayed: replayed,
        };
      }
      const outcome =
        options.waitFor === 'TERMINAL'
          ? await this.waitForExecution(executionId, options)
          : ({
              executionId,
              status: 'SUBMITTED',
              terminal: false,
              timedOut: false,
              transactionDigest: submittedDigest,
              fill: undefined,
              fee: NO_FILL,
              remainingAllowance: undefined,
            } satisfies ExecutionOutcome);
      if (outcome.terminal && store !== undefined && journalKey !== undefined) {
        await store.settle(journalKey, outcome.status);
      }
      return { ...outcome, enforcedWorstPrice, idempotencyKey, idempotencyKeyReplayed: replayed };
    } catch (error: unknown) {
      // Before the submission, nothing can have executed: the record goes, so a
      // retry of this intent builds afresh. After it, the only throw is the
      // definitive refusal, which removed it already.
      if (!sent && store !== undefined && journalKey !== undefined) {
        await store.forget(journalKey);
      }
      throw error;
    }
  }

  /**
   * Build an order through the public route and verify it — every check that
   * stands before a signature, and nothing after it. Shared by an order and by
   * `probeOrder`, so a probe that passes has passed exactly what an order must.
   */
  private async buildVerified(
    rest: Omit<DirectExecuteIntent, 'idempotencyKey' | 'referenceQuoteId'>,
    handle: MarketHandle,
    referenceQuoteId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ built: PublicTxResponse & { sponsored: true }; enforcedWorstPrice: string; executionId: string; call: string; consolidationLegs: number }> {
    const permission = rest.side === 'BUY' ? PREDICTION_PERMISSIONS.PLACE_ORDER : PREDICTION_PERMISSIONS.REQUEST_CLOSE;
    const owner = await this.ownerOf(rest.accountId, permission, signal);
    const reference = await this.referencePrice(handle, rest, referenceQuoteId, signal);
    const absolute =
      rest.worstAcceptablePrice === undefined ? undefined : parseScaled(rest.worstAcceptablePrice, 6, 'worstAcceptablePrice');
    const expiryTs = BigInt(this.now() + this.orderExpiryMs);
    const agent = this.agentWallet;

    let built: PublicTxResponse;
    let expectation: DirectExpectation;
    let enforced: (minProceeds: bigint | undefined, closed: bigint | 'FULL') => string;

    if (rest.side === 'BUY') {
      if (rest.size.buyAmount === undefined || rest.size.sellShares !== undefined) {
        throw apiError('INVALID_REQUEST', 'A BUY is sized by buyAmount alone.');
      }
      const maxSpend = parseScaled(rest.size.buyAmount, MONEY_DECIMALS, 'buyAmount');
      const boundary = worstAcceptable('BUY', reference, rest.maxSlippageBps, absolute);
      if (boundary < reference) {
        throw new PredictAgentApiError(0, {
          code: 'SLIPPAGE_EXCEEDED',
          message: `The worst acceptable price ${formatPrice(boundary)} is below the current ask ${formatPrice(reference)}; this order could not fill.`,
          retryable: true,
        });
      }
      const guards = buyGuards(maxSpend, boundary);
      const body: PlaceBetBody = {
        sender: owner,
        delegateSender: agent,
        accountId: normalizeSuiAddress(rest.accountId),
        marketId: handle.onchainMarketId,
        selection: rest.outcomeId,
        maxSpend: maxSpend.toString(),
        minShares: guards.minShares.toString(),
        priceCapBps: guards.priceCapBps.toString(),
        expiryTs: expiryTs.toString(),
      };
      built = await this.http.post<PublicTxResponse>(R.placeBet, body, signal);
      expectation = {
        kind: 'place',
        agentWallet: agent,
        accountId: body.accountId,
        onchainMarketId: handle.onchainMarketId,
        selection: rest.outcomeId,
        maxSpend,
        minShares: guards.minShares,
        priceCapBps: guards.priceCapBps,
        expiryTs,
      };
      enforced = () => formatPrice(guards.enforcedWorstPrice);
    } else {
      if (rest.size.sellShares === undefined || rest.size.buyAmount !== undefined) {
        throw apiError('INVALID_REQUEST', 'A SELL is sized by sellShares alone.');
      }
      const shares = parseScaled(rest.size.sellShares, MONEY_DECIMALS, 'sellShares');
      const boundary = worstAcceptable('SELL', reference, rest.maxSlippageBps, absolute);
      // The backend prices the floor from its own bid read, a moment later than
      // ours. It is accepted down to the floor at TWICE the stated slippage from
      // our read — one budget for the book, one for the gap between the reads —
      // and never lower.
      const tolerance = worstAcceptable('SELL', reference, Math.min(9_999, rest.maxSlippageBps * 2), absolute);
      const held = await this.heldShares(owner, rest.positionId!, signal);
      const body: SellBetBody = {
        sender: owner,
        delegateSender: agent,
        accountId: normalizeSuiAddress(rest.accountId),
        positionId: rest.positionId!,
        closeShares: shares.toString(),
        slippageBps: String(rest.maxSlippageBps),
        expiryTs: expiryTs.toString(),
      };
      built = await this.http.post<PublicTxResponse>(R.sellBet, body, signal);
      expectation = {
        kind: 'sell',
        agentWallet: agent,
        accountId: body.accountId,
        positionId: BigInt(rest.positionId!),
        closeShares: shares,
        minProceedsAtLeast: (closed) =>
          sellFloor(closed === 'FULL' ? (held !== undefined && held < shares ? held : shares) : closed, tolerance),
        expiryTs,
      };
      enforced = (minProceeds, closed) => {
        const count = closed === 'FULL' ? (held !== undefined && held < shares ? held : shares) : closed;
        return minProceeds === undefined || count <= 0n ? formatPrice(boundary) : formatPrice(enforcedSellPrice(minProceeds, count));
      };
    }

    if (!built.sponsored) {
      throw apiError('SPONSOR_UNAVAILABLE', 'The backend could not sponsor this order, and a delegate cannot pay its own gas.');
    }
    const deployment = await this.deployment.load(signal);
    const bytes = Uint8Array.from(Buffer.from(built.txBytes, 'base64'));
    const verified = verifyDirectTransaction(bytes, expectation, deployment);
    // The journal, the chain read that settles an unanswered submission and
    // the submission itself are all keyed by this digest, so it is the one
    // these bytes actually have — never the backend's word for it.
    if (suiTransactionDigest(bytes) !== built.digest) {
      throw new DirectVerificationError('DIGEST', 'the digest the backend returned is not the digest of the bytes it built');
    }
    await this.assertAbi(deployment, signal);
    const closed: bigint | 'FULL' =
      verified.call === 'request_close' ? 'FULL' : expectation.kind === 'sell' ? expectation.closeShares : 0n;
    const enforcedWorstPrice = enforced(verified.minProceeds, closed);
    const executionId = encodeExecutionId({
      digest: built.digest,
      owner,
      side: rest.side,
      positionId: rest.positionId,
    });
    return {
      built: built as PublicTxResponse & { sponsored: true },
      enforcedWorstPrice,
      executionId,
      call: verified.call,
      consolidationLegs: verified.consolidationLegs,
    };
  }

  /**
   * Have the backend build this order and verify it — digest, contract shapes
   * and every argument — WITHOUT signing or submitting it (ADR-0015). What a
   * `doctor` write probe runs: it proves the build path works against this
   * deployment and account, and costs a sponsor session that simply expires.
   */
  async probeOrder(
    intent: Omit<DirectExecuteIntent, 'idempotencyKey'>,
    signal?: AbortSignal,
  ): Promise<{ call: string; enforcedWorstPrice: string; consolidationLegs: number; digest: string }> {
    const { referenceQuoteId, ...rest } = intent;
    assertSlippage(rest.maxSlippageBps);
    const handle = this.decode(rest.marketId);
    if (rest.side === 'SELL' && (rest.positionId === undefined || !/^\d+$/u.test(rest.positionId))) {
      throw apiError('INVALID_REQUEST', 'A SELL names the numeric on-chain position it closes.');
    }
    const verified = await this.buildVerified(rest, handle, referenceQuoteId, signal);
    return {
      call: verified.call,
      enforcedWorstPrice: verified.enforcedWorstPrice,
      consolidationLegs: verified.consolidationLegs,
      digest: verified.built.digest,
    };
  }

  private async referencePrice(
    handle: MarketHandle,
    intent: Omit<DirectExecuteIntent, 'idempotencyKey' | 'referenceQuoteId'>,
    referenceQuoteId: string | undefined,
    signal?: AbortSignal,
  ): Promise<bigint> {
    if (referenceQuoteId === undefined) return await this.legPrice(handle, intent.outcomeId, intent.side, signal);
    const ref = decodeQuoteId(referenceQuoteId);
    if (ref === undefined || ref.binding !== quoteBinding(intent.marketId, intent.outcomeId, intent.side)) {
      throw apiError('INVALID_REQUEST', 'The reference quote was not issued for this market, outcome and side.');
    }
    if (this.now() > ref.expiresAt) {
      throw new PredictAgentApiError(0, {
        code: 'QUOTE_EXPIRED',
        message: 'The reference quote has expired. Quote again, or omit it and one is taken at the moment of the order.',
        retryable: true,
      });
    }
    return ref.price;
  }

  private async heldShares(owner: string, positionId: string, signal?: AbortSignal): Promise<bigint | undefined> {
    const bets = await this.http
      .get<PublicBetsResponse>(R.bets, { address: owner, filter: 'active', limit: 100 }, signal)
      .catch(() => undefined);
    const bet = bets?.bets.find((row) => row.positionId === positionId || row.positionIds?.includes(positionId) === true);
    if (bet?.shares === undefined || !Number.isFinite(bet.shares)) return undefined;
    return parseScaled(bet.shares.toFixed(6), MONEY_DECIMALS, 'shares');
  }

  private async resolveRecorded(
    known: { readonly executionId?: string; readonly enforcedWorstPrice?: string; readonly createdAt: string; readonly status: string },
    journalKey: string,
    idempotencyKey: string,
    store: IntentStore,
    options: DirectExecuteOptions,
  ): Promise<DirectExecuteResult | 'NEVER_LANDED'> {
    const executionId = known.executionId!;
    const read = await this.readExecution(executionId, options.signal);
    if (read.status === 'SUBMITTING') {
      // Not on chain. Only once the sponsor session that could have carried it is
      // certainly gone — minutes, per the backend — is that proof it never will be.
      const age = this.now() - Date.parse(known.createdAt);
      if (age > 10 * 60_000 && (await this.chain.landing(decodeExecutionId(executionId).digest, options.signal)) === 'NOT_FOUND') {
        return 'NEVER_LANDED';
      }
    }
    const outcome =
      options.waitFor === 'TERMINAL' && !read.terminal ? await this.waitForExecution(executionId, options) : read;
    if (outcome.terminal && known.status === 'PENDING') await store.settle(journalKey, outcome.status);
    return { ...outcome, enforcedWorstPrice: known.enforcedWorstPrice ?? '', idempotencyKey, idempotencyKeyReplayed: true };
  }

  private async activity(owner: string, signal?: AbortSignal): Promise<PublicActivityEntry[]> {
    const response = await this.http.get<PublicActivityResponse>(R.activity, { address: owner, limit: 100 }, signal);
    return response.activity;
  }

  /** The Agent API's raw execution shape, for surfaces that render it as such. */
  async getExecution(executionId: string, signal?: AbortSignal): Promise<SubmitExecutionResponseBody> {
    const outcome = await this.readExecution(executionId, signal);
    return {
      executionId: outcome.executionId,
      status: outcome.status,
      ...(outcome.transactionDigest === undefined ? {} : { transactionDigest: outcome.transactionDigest }),
      ...(outcome.fill === undefined ? {} : { fill: outcome.fill }),
    };
  }

  /**
   * Where an order stands.
   *
   * The chain decides everything it can, because the activity feed is an index
   * that can lag or stop:
   * - the submission failed on chain → `REJECTED`; not on chain → `SUBMITTING`;
   * - the order is still open → `PENDING_FILL`, or `EXPIRED` once its expiry
   *   plus the keeper's grace has passed — no fill can be reported after that,
   *   and the escrow comes back only through a cancel (`openOrder` says when);
   * - a buy the registry records as filled → `FILLED`, with the position's
   *   shares and cost;
   * - a sell whose close order is gone → `FILLED` if the position is gone with
   *   it, `CANCELLED` if the position is still there.
   * The feed supplies fill details when it has them, and settles what the chain
   * cannot — a buy whose order is gone (cancelled, or filled and since closed).
   * Silence from both is non-terminal, never a guess.
   */
  async readExecution(executionId: string, signal?: AbortSignal): Promise<DirectExecutionOutcome> {
    const ref = decodeExecutionId(executionId);
    const base = {
      executionId,
      timedOut: false,
      transactionDigest: ref.digest,
      remainingAllowance: undefined,
    };
    const done = (status: PredictExecutionStatus, fill?: PredictExecutionFill): DirectExecutionOutcome => ({
      ...base,
      status,
      terminal: TERMINAL.has(status),
      fill,
      fee: fill === undefined ? NO_FILL : EMBEDDED,
    });

    let feed: PublicActivityEntry[] | undefined;
    let feedError: unknown;
    try {
      feed = await this.activity(ref.owner, signal);
    } catch (error: unknown) {
      feedError = error;
    }
    const indexed = feed === undefined ? undefined : feedOutcome(ref, feed);
    if (indexed?.status !== undefined) return done(indexed.status, indexed.fill);

    const landing = await this.chain.landing(ref.digest, signal);
    if (landing === 'FAILURE') return done('REJECTED');
    if (landing !== 'SUCCESS' && indexed?.landed !== true) {
      if (feed === undefined && landing === 'UNKNOWN') throw feedError;
      return done('SUBMITTING');
    }

    const onChain = await this.chainOutcome(ref, indexed?.fill, feed, signal);
    if (onChain !== undefined) return { ...done(onChain.status, onChain.fill), ...onChain.extra };
    if (feed === undefined) throw feedError;
    return done(indexed?.landed === true ? 'PENDING_FILL' : 'SUBMITTED');
  }

  /**
   * The order's state from the registry, or `undefined` when this reader cannot
   * say (no chain order reads, no placed order in the transaction, or a read
   * that failed — which is not evidence of anything).
   */
  private async chainOutcome(
    ref: ExecutionRef,
    indexedFill: PredictExecutionFill | undefined,
    feed: readonly PublicActivityEntry[] | undefined,
    signal?: AbortSignal,
  ): Promise<
    | {
        status: PredictExecutionStatus;
        fill?: PredictExecutionFill | undefined;
        extra?: Pick<DirectExecutionOutcome, 'openOrder'>;
      }
    | undefined
  > {
    const chain = this.chain;
    if (chain.placedOrders === undefined || chain.orderState === undefined) return undefined;
    try {
      const deployment = await this.deployment.load(signal);
      const placed = await chain.placedOrders(ref.digest, deployment.originals.prediction, signal);
      const order = placed?.find(
        (row) =>
          row.kind === (ref.side === 'BUY' ? 'OPEN' : 'CLOSE') &&
          normalizeSuiAddress(row.registry) === deployment.objects.marketRegistry,
      );
      if (order === undefined) return undefined;
      const state = await chain.orderState(order.registry, order.orderId, signal);
      if (state.state === 'OPEN') {
        const fillableUntil = state.expiryTs + KEEPER_FILL_GRACE_MS;
        const openOrder = {
          orderId: order.orderId,
          expiresAt: new Date(state.expiryTs).toISOString(),
          fillableUntil: new Date(fillableUntil).toISOString(),
          cancellableAfter: new Date(Math.max(state.selfCancelAfterTs, fillableUntil)).toISOString(),
          escrow: formatScaled(BigInt(state.escrow), MONEY_DECIMALS),
        };
        return this.now() >= fillableUntil
          ? { status: 'EXPIRED', extra: { openOrder } }
          : { status: 'PENDING_FILL', extra: { openOrder } };
      }
      if (ref.side === 'BUY') {
        // The feed's fill or cancel carries the KEEPER's digest, not this
        // submission's — so it is found by the order id the chain named.
        const byOrder = (kind: string): PublicActivityEntry | undefined =>
          feed?.find((entry) => entry.kind === kind && entry.orderIds.includes(order.orderId));
        const bought = byOrder('bought');
        if (state.state === 'FILLED') {
          return { status: 'FILLED', fill: indexedFill ?? (bought === undefined ? undefined : fillOf(bought)) ?? positionFill(state.position) };
        }
        // Gone from the registry: the feed says which way.
        if (bought !== undefined) return { status: 'FILLED', fill: fillOf(bought) };
        if (byOrder('bought_unfilled') !== undefined) return { status: 'CANCELLED' };
        return undefined;
      }
      // A close order that is no longer open: the position it closes decides
      // which way it went — still there, the close was cancelled; gone, it was
      // confirmed. For a partial close that is the split-off position, which is
      // why the id comes from the event and not from the execution id.
      if (order.positionId === undefined || chain.positionOpen === undefined) return undefined;
      const stillOpen = await chain.positionOpen(order.registry, order.positionId, signal);
      return stillOpen
        ? { status: 'CANCELLED' }
        : { status: 'FILLED', ...(indexedFill === undefined ? {} : { fill: indexedFill }) };
    } catch {
      return undefined;
    }
  }

  async waitForExecution(
    executionId: string,
    options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<DirectExecutionOutcome> {
    const deadline = this.now() + (options.timeoutMs ?? 90_000);
    const interval = Math.max(250, options.pollIntervalMs ?? 2_000);
    // A function, not a property read: the signal can flip during the sleep.
    const aborted = (): boolean => options.signal?.aborted === true;
    let last = await this.readExecution(executionId, options.signal);
    while (!last.terminal && !TERMINAL.has(last.status)) {
      if (this.now() >= deadline || aborted()) return { ...last, timedOut: true };
      await sleep(interval, options.signal);
      if (aborted()) return { ...last, timedOut: true };
      last = await this.readExecution(executionId, options.signal);
    }
    return last;
  }

  async executeMany(
    intents: readonly DirectExecuteIntent[],
    options: DirectExecuteOptions & { concurrency?: number; failurePolicy?: 'STOP' | 'CONTINUE' } = {},
  ): Promise<DirectExecuteManyResult[]> {
    const stopOnFailure = (options.failurePolicy ?? 'STOP') === 'STOP';
    const results: DirectExecuteManyResult[] = [];
    let halted = false;
    // Sequential on purpose: every leg is its own sponsored build, and running
    // them in parallel buys nothing but a burst against a per-IP limit.
    for (const [index, intent] of intents.entries()) {
      if (halted) {
        results.push({ ok: false, index, skipped: true });
        continue;
      }
      try {
        results.push({ ok: true, index, result: await this.executeMarketOrder(intent, options) });
      } catch (error: unknown) {
        results.push({ ok: false, index, error });
        if (stopOnFailure) halted = true;
      }
    }
    return results;
  }

  /* ── Positions ────────────────────────────────────────────────────────── */

  private async requireMainAccount(owner: string, accountId: string, signal?: AbortSignal): Promise<void> {
    const accounts = await this.http.get<PublicAccount[]>(R.accounts, { owner }, signal);
    const account = accounts.find((row) => normalizeSuiAddress(row.accountId) === normalizeSuiAddress(accountId));
    if (account === undefined || !account.isMainAccount) {
      throw new DirectCapabilityUnavailable(
        'account.positions',
        'the public positions feed covers only the owner’s main account, and this is not it.',
      );
    }
  }

  private async legFor(bet: PublicBet, signal?: AbortSignal): Promise<{ marketId: string; outcomeId: 'YES' | 'NO' }> {
    const onchain = bet.betId.split(':')[0] ?? '';
    const route = CARD_ROUTES[bet.cardSnapshot?.kind ?? ''];
    const categories = route === undefined ? DETAIL_CATEGORIES : [route, ...DETAIL_CATEGORIES.filter((c) => c !== route)];
    const slug = bet.marketSlug;
    let round: PublicRound | undefined;
    if (slug !== undefined && slug !== '') {
      for (const category of categories) {
        const detail = await this.http
          .get<{ detail?: { round?: PublicRound } }>(`predict/markets/${category}/${encodeURIComponent(slug)}`, undefined, signal)
          .catch(() => undefined);
        if (detail?.detail?.round !== undefined) {
          round = detail.detail.round;
          break;
        }
      }
    }
    // The current round's side layout is the market's layout: a recurring market
    // keeps its side keys and their legs from round to round.
    const side = round?.sides.find((entry) => entry.key === bet.side);
    const legSelection = side?.trade?.selection ?? 'YES';
    const outcomeId: 'YES' | 'NO' = bet.betAgainst === true ? (legSelection === 'YES' ? 'NO' : 'YES') : legSelection;
    if (round === undefined || !/^0x[0-9a-f]{64}$/iu.test(onchain)) return { marketId: onchain, outcomeId };
    const leg = legsOf({ ...round, id: bet.roundId }).find(
      (entry) => entry.handle.onchainMarketId === normalizeSuiAddress(onchain),
    );
    return { marketId: leg?.marketId ?? onchain, outcomeId };
  }

  async getPositions(
    accountId: string,
    _page?: PredictAgentListQuery,
    signal?: AbortSignal,
  ): Promise<ListPositionsResponseBody> {
    const owner = await this.ownerOf(accountId, 0, signal);
    await this.requireMainAccount(owner, accountId, signal);
    const response = await this.http.get<PublicBetsResponse>(R.bets, { address: owner, filter: 'active', limit: 100 }, signal);
    const positions: PredictPositionSummary[] = [];
    for (const bet of response.bets) {
      if (bet.positionId === '' || bet.submissionState !== 'confirmed') continue;
      const leg = await this.legFor(bet, signal);
      const shares = typeof bet.shares === 'number' ? bet.shares.toFixed(6) : null;
      const cost = formatScaled(parseScaled(bet.stake.amountUsd.toFixed(6), 6, 'stake'), 6);
      positions.push({
        positionId: bet.positionId,
        marketId: leg.marketId,
        outcomeId: leg.outcomeId,
        strategyId: null,
        originalCost: cost,
        remainingCost: cost,
        shares: shares === null ? null : formatScaled(parseScaled(shares, 6, 'shares'), 6),
        avgEntryPrice: typeof bet.avgFillPriceCents === 'number' ? priceText(bet.avgFillPriceCents) : null,
        currentPrice: null,
        unrealizedPnl: null,
        openedAt: new Date(bet.placedAt).toISOString(),
      });
    }
    return { positions, nextCursor: response.nextCursor ?? null };
  }

  /* ── What this mode cannot answer ─────────────────────────────────────── */

  async getEffectiveLimits(_accountId?: string, _signal?: AbortSignal): Promise<never> {
    throw new DirectCapabilityUnavailable(
      'account.risk-limits',
      'there is no server-side mandate; the ceiling is this runtime’s execution policy, and the delegation is on chain.',
    );
  }

  async getAllowance(_accountId?: string, _signal?: AbortSignal): Promise<never> {
    throw new DirectCapabilityUnavailable('account.allowance', 'no public route reports an API allowance.');
  }

  async getFills(_accountId?: string, _page?: PredictAgentListQuery, _signal?: AbortSignal): Promise<never> {
    throw new DirectCapabilityUnavailable('account.fills', 'use order get on the execution id, or account positions.');
  }

  async getPerformance(_accountId?: string, _filter?: unknown, _signal?: AbortSignal): Promise<never> {
    throw new DirectCapabilityUnavailable('account.performance', 'no public route attributes performance to an agent.');
  }

  async listExecutions(_accountId?: string, _page?: PredictAgentListQuery, _signal?: AbortSignal): Promise<never> {
    throw new DirectCapabilityUnavailable(
      'account.executions',
      'the public feed is the owner’s, not this agent’s; read your own orders back with order get.',
    );
  }

  /**
   * What THIS runtime submitted and has not yet seen settle.
   *
   * Direct mode's answer to "is anything unsettled": there is no server list of
   * an agent's orders, so the durable intent journal is the source, and each
   * recorded order is read back before it is reported. A record with no
   * execution id never reached `/sponsor/execute` — the id is attached before
   * sending — so it is not an order and is not listed. An order that reads
   * terminal is settled in the journal and dropped from the answer. A failed
   * read throws: "nothing unsettled" is never claimed from a partial read.
   *
   * Scope is this journal only. Orders placed by another process with another
   * state directory are not seen.
   */
  async listUnsettled(accountId?: string, signal?: AbortSignal): Promise<PredictExecutionSummary[]> {
    const store = this.intentStore;
    if (store === undefined) {
      throw new DirectCapabilityUnavailable(
        'account.executions',
        'no intent store is configured, and without one this runtime keeps no record of what it sent.',
      );
    }
    const unsettled: PredictExecutionSummary[] = [];
    for (const record of await store.pending()) {
      const executionId = record.executionId;
      if (executionId === undefined || !executionId.startsWith(`${EXECUTION_PREFIX}.`)) continue;
      const intent = record.intent as Partial<DirectExecuteIntent>;
      if (accountId !== undefined && intent.accountId !== accountId) continue;
      const read = await this.readExecution(executionId, signal);
      if (read.terminal) {
        await store.settle(record.idempotencyKey, read.status);
        continue;
      }
      const side = intent.side === 'SELL' ? 'SELL' : 'BUY';
      unsettled.push({
        executionId,
        status: read.status,
        side,
        marketId: intent.marketId ?? '',
        outcomeId: intent.outcomeId ?? 'YES',
        size: (side === 'BUY' ? intent.size?.buyAmount : intent.size?.sellShares) ?? '',
        strategyId: intent.strategyId ?? null,
        clientOrderId: intent.clientOrderId ?? null,
        enforcedWorstPrice: record.enforcedWorstPrice ?? null,
        transactionDigest: read.transactionDigest ?? null,
        positionId: intent.positionId ?? null,
        createdAt: record.createdAt,
        terminalAt: null,
      });
    }
    return unsettled;
  }

  get networkName(): DirectNetwork {
    return this.network;
  }
}

/**
 * What the activity feed alone says. `status` only when it shows an end;
 * `landed` when it shows the submission at all.
 */
function feedOutcome(
  ref: ExecutionRef,
  feed: readonly PublicActivityEntry[],
): { status?: PredictExecutionStatus; fill?: PredictExecutionFill; landed: boolean } {
  if (ref.side === 'BUY') {
    const submitted = feed.find((entry) => entry.txDigest === ref.digest);
    if (submitted === undefined) return { landed: false };
    const orders = new Set(submitted.orderIds);
    const related = (kind: string): PublicActivityEntry | undefined =>
      feed.find((entry) => entry.kind === kind && entry.orderIds.some((id) => orders.has(id)));
    const filled = submitted.kind === 'bought' ? submitted : related('bought');
    if (filled !== undefined) {
      const fill = fillOf(filled);
      return { status: 'FILLED', landed: true, ...(fill === undefined ? {} : { fill }) };
    }
    if (submitted.kind === 'bought_unfilled' || related('bought_unfilled') !== undefined) {
      return { status: 'CANCELLED', landed: true };
    }
    return { landed: true };
  }
  const position = ref.positionId;
  const byPosition = (kind: string): PublicActivityEntry | undefined =>
    feed.find((entry) => entry.kind === kind && position !== undefined && entry.positionIds.includes(position));
  const sold = byPosition('sold');
  if (sold !== undefined) {
    const fill = fillOf(sold);
    return { status: 'FILLED', landed: true, ...(fill === undefined ? {} : { fill }) };
  }
  if (byPosition('sell_unfilled') !== undefined) return { status: 'CANCELLED', landed: true };
  return { landed: false };
}

/** A buy's fill from the position it opened. No keeper digest: the registry does not keep one. */
function positionFill(
  position: { readonly filledShares: string; readonly filledCost: string; readonly openedTs: number } | undefined,
): PredictExecutionFill | undefined {
  if (position === undefined) return undefined;
  const shares = BigInt(position.filledShares);
  const cost = BigInt(position.filledCost);
  return {
    filledAmount: formatScaled(cost, MONEY_DECIMALS),
    filledShares: formatScaled(shares, MONEY_DECIMALS),
    avgFillPrice: shares === 0n ? null : formatPrice((cost * PRICE_ONE) / shares),
    actualFee: null,
    txDigest: null,
    filledAt: new Date(position.openedTs).toISOString(),
  };
}

function fillOf(entry: PublicActivityEntry): PredictExecutionFill | undefined {
  if (entry.amountUsd === null) return undefined;
  const filledAmount = formatScaled(parseScaled(entry.amountUsd.toFixed(6), 6, 'amountUsd'), 6);
  const filledShares =
    entry.shares === null ? null : formatScaled(parseScaled(entry.shares.toFixed(6), 6, 'shares'), 6);
  return {
    filledAmount,
    filledShares,
    avgFillPrice: priceText(entry.oddsCents),
    actualFee: null,
    txDigest: entry.txDigest,
    filledAt: new Date(entry.timestampMs).toISOString(),
  };
}
