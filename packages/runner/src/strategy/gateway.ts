/**
 * Everything the executor is allowed to touch outside its own process.
 *
 * Declared structurally, and deliberately as the *narrow* set: `PredictAgentClient`
 * satisfies `StrategyGateway` as it stands, and a test satisfies it with an object
 * literal that opens no socket. Writing the executor against the concrete client
 * would make every driver test need a transport, a token and a base URL, which is
 * how a suite ends up proving that a mock works.
 *
 * Two seams are separate from the gateway on purpose:
 *
 * - **The signer.** ADR-0001 §7 puts it inside the Runner trust boundary and
 *   nowhere else. It takes base64 in and returns a signature out, so no caller of
 *   the executor — and no subprocess — ever holds key material, and the executor
 *   itself never learns what kind of key it is.
 * - **The price observer.** A trigger is watched with an *indicative* price, which
 *   may come from a stream frame or a size-blind quote, and is never the price an
 *   order is built on. Keeping it out of the gateway means the executor cannot
 *   accidentally price an order off it: the only thing that returns a
 *   `referenceQuoteId` is `getQuote`.
 */
import type {
  CreateExecutionRequestBody,
  CreateExecutionResponseBody,
  CreateQuoteRequestBody,
  GetMarketResponseBody,
  PredictEffectiveLimitsResponseBody,
  PredictOrderSize,
  PredictOutcomeId,
  PredictQuote,
  PredictSide,
  PriceString,
  SubmitExecutionResponseBody,
} from '@waterx/predict-agent-sdk';

import type { JobLegIntent, JobRecord } from '../job.ts';
import { StrategyError } from './errors.ts';
import type { StrategyPositionReader } from './positions.ts';

/**
 * The reads and writes a durable strategy makes.
 *
 * `createExecution` and `submitExecution` are separate rather than the SDK's
 * one-call `executeMarketOrder` because the Runner has to persist the execution
 * id *between* them. A crash after a create that nothing recorded is the one
 * failure this whole layer exists to survive, and a combined call gives the store
 * no instant at which to write.
 */
export interface StrategyGateway extends StrategyPositionReader {
  getQuote(request: CreateQuoteRequestBody, signal?: AbortSignal): Promise<PredictQuote>;
  createExecution(
    request: CreateExecutionRequestBody,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<CreateExecutionResponseBody>;
  submitExecution(
    executionId: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<SubmitExecutionResponseBody>;
  getExecution(executionId: string, signal?: AbortSignal): Promise<SubmitExecutionResponseBody>;
  getMarket(marketId: string, signal?: AbortSignal): Promise<GetMarketResponseBody>;
  getEffectiveLimits(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<PredictEffectiveLimitsResponseBody>;
}

/** The one thing that may see key material, and the least it can be given. */
export interface StrategySigner {
  /**
   * Sign sponsored transaction bytes given as base64, exactly as the API handed
   * them over. `signBase64` from the SDK adapts an `AgentSigner` to this in one
   * line; a KMS-backed implementation satisfies it without decoding anything here.
   */
  sign(sponsoredTransactionBytes: string, signal?: AbortSignal): Promise<string>;
}

/** The market/outcome/side a price trigger watches. */
export interface WatchKey {
  readonly marketId: string;
  readonly outcomeId: PredictOutcomeId;
  readonly side: PredictSide;
}

export interface PriceObserver {
  /**
   * The latest indicative price for the watched side, or `null` when there is
   * none to report.
   *
   * `null` is not "the target was not met" — it is "nothing was observed", and
   * the executor treats it as a pass with no opinion rather than as a price that
   * failed the test. A feed that goes quiet must not look like a market that
   * moved away.
   */
  observe(watch: WatchKey, signal?: AbortSignal): Promise<PriceString | null>;
}

/**
 * The size a leg trades, in the shape the wire takes it.
 *
 * Throws rather than defaulting. Normalization already guaranteed exactly one of
 * the two is present (ADR-0001 §11), so reaching here without one means a record
 * was written by something that skipped that layer — and inventing a size for it
 * is the single most expensive guess in this codebase. A `DYNAMIC_FRACTION` leg
 * legitimately has no `sellShares` until the executor resolves one, which is why
 * this is called after resolution and not before.
 */
export const sizeOf = (intent: JobLegIntent, legIndex: number): PredictOrderSize => {
  if (intent.side === 'BUY') {
    if (intent.buyAmount === undefined) {
      throw new StrategyError(
        'SIZE_MISSING',
        `legs[${String(legIndex)}] is a BUY with no buyAmount`,
        { leg: legIndex, side: intent.side },
      );
    }
    return { buyAmount: intent.buyAmount };
  }
  if (intent.sellShares === undefined) {
    throw new StrategyError(
      'SIZE_MISSING',
      `legs[${String(legIndex)}] is a SELL with no sellShares; a dynamic fraction must be resolved before it is sized`,
      { leg: legIndex, side: intent.side, sizing: intent.sizing?.kind },
    );
  }
  return { sellShares: intent.sellShares };
};

/** The quote request for a leg: same market, same side, same size as the order. */
export const quoteRequestFor = (
  intent: JobLegIntent,
  legIndex: number,
): CreateQuoteRequestBody => ({
  marketId: intent.marketId,
  outcomeId: intent.outcomeId,
  side: intent.side,
  size: sizeOf(intent, legIndex),
});

/**
 * The exact create body for a leg.
 *
 * Pure, and derived only from durable values: the job record, the leg intent the
 * store holds, and the quote id from the fresh quote. That is what lets a replay
 * after a restart rebuild byte-identical bytes and present the same
 * `requestFingerprint` the first attempt did.
 */
export const buildCreateRequest = (
  job: JobRecord,
  intent: JobLegIntent,
  legIndex: number,
  referenceQuoteId: string,
): CreateExecutionRequestBody => ({
  accountId: job.accountId,
  marketId: intent.marketId,
  outcomeId: intent.outcomeId,
  side: intent.side,
  size: sizeOf(intent, legIndex),
  ...(intent.positionId === undefined ? {} : { positionId: intent.positionId }),
  referenceQuoteId,
  maxSlippageBps: intent.maxSlippageBps,
  ...(intent.worstAcceptablePrice === undefined
    ? {}
    : { worstAcceptablePrice: intent.worstAcceptablePrice }),
  strategyId: job.strategyId,
});
