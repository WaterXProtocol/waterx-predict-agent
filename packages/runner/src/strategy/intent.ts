/**
 * Turning what a caller asked for into what the store may keep.
 *
 * This is the layer that refuses. Everything downstream — the executor, the
 * signer, the reconciler — is built to carry out an intent exactly; the place to
 * catch an intent that means two things is before it is durable, because after
 * that a Runner will faithfully execute whichever one it happened to store.
 *
 * Three rules do most of the work here:
 *
 * 1. **A size is never inferred from the side.** A BUY commits `buyAmount`, a
 *    SELL closes `sellShares`, and any other combination stops (ADR-0001 §11).
 * 2. **"Sell half" freezes.** `sellFractionOfPosition` is resolved against an
 *    authoritative position read *now* and stored as an absolute share count, so
 *    a position that grows before the trigger does not enlarge the order. The
 *    other reading exists, but only under a different field name that says what
 *    it does — `dynamicSellFractionOfPosition` (D-15).
 * 3. **Nothing is resolved from wording.** A market is an id, not a description;
 *    a fraction is `0.5`, not "half"; an expiry is an absolute ISO instant with a
 *    zone, not "tomorrow". Resolving any of those is the server's job or the
 *    caller's, and guessing here is how an agent trades the wrong market.
 *
 * Normalization is pure apart from the position read, and the first refusal wins:
 * nothing partial is written, because nothing is written at all.
 */
import {
  fromScaled,
  toScaled,
  type DecimalString,
  type Iso8601,
  type PredictOutcomeId,
  type PredictSide,
  type PriceString,
} from '@waterx/predict-agent-sdk';

import type { JobLegIntent, JobLegSizing, JobPolicySnapshot, JobTrigger } from '../job.ts';
import { StrategyError } from './errors.ts';
import { findPosition, type StrategyPositionReader } from './positions.ts';

/** ADR-0005: the beta maximum a strategy may be armed for. Seven days. */
export const BETA_MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** One unit of `1` at the decimal scale the contract uses. */
const ONE = 1_000_000n;

/**
 * An absolute instant with an explicit zone.
 *
 * `Date.parse` also accepts `01/02/2026` and bare local times, and both are
 * decided by where the machine is — a strategy that stops a day early or twelve
 * hours late depending on the host is not a strategy anyone armed.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/* ── The request ───────────────────────────────────────────────────────────── */

/**
 * One leg as asked for, before normalization.
 *
 * The four sizing fields are mutually exclusive and deliberately not collapsed
 * into a discriminated union: a caller sending JSON gets a refusal that names
 * which fields collided, rather than a schema error about a tag it never knew to
 * send.
 */
export interface StrategyLegRequest {
  readonly marketId: string;
  readonly outcomeId: PredictOutcomeId;
  readonly side: PredictSide;
  /** BUY only: the budget committed, in quote units. */
  readonly buyAmount?: DecimalString;
  /** SELL only: an absolute share count. */
  readonly sellShares?: DecimalString;
  /**
   * SELL only: a fraction in `(0, 1]` of the position, resolved to shares NOW and
   * stored absolute. This is what "sell half" means by default.
   */
  readonly sellFractionOfPosition?: DecimalString;
  /**
   * SELL only: the same fraction, re-read at trigger time instead. Sells more
   * than the owner pictured if the position grew, which is why it is a separate
   * field and never a flag on the one above.
   */
  readonly dynamicSellFractionOfPosition?: DecimalString;
  /** Required for SELL: which position is being closed. */
  readonly positionId?: string;
  readonly maxSlippageBps: number;
  readonly worstAcceptablePrice?: PriceString;
}

export type StrategyTriggerRequest =
  | { readonly kind: 'IMMEDIATE' }
  | {
      readonly kind: 'PRICE';
      readonly targetPrice: PriceString;
      /**
       * The watched market, when it is not the one being traded. All three or
       * none: naming a market without an outcome and a side would leave the other
       * two to be derived from legs that trade somewhere else.
       */
      readonly marketId?: string;
      readonly outcomeId?: PredictOutcomeId;
      readonly side?: PredictSide;
    };

export interface StrategyRequest {
  /** Optional: the service mints one when the caller has no name for it. */
  readonly strategyId?: string;
  readonly ownerAddress: string;
  readonly accountId: string;
  readonly agentWallet: string;
  readonly legs: readonly StrategyLegRequest[];
  readonly trigger: StrategyTriggerRequest;
  readonly policy: JobPolicySnapshot;
  /**
   * Mandatory (ADR-0005). Optional in the type ONLY so a JSON caller that omits
   * it is refused with `EXPIRY_REQUIRED` at runtime — which is the audience for
   * the rule — rather than being a compile error TypeScript callers alone see.
   */
  readonly expiresAt?: Iso8601;
}

/* ── The result ────────────────────────────────────────────────────────────── */

export interface ResolvedExpiry {
  /** Canonical UTC, so a preview shows the absolute instant that will be enforced. */
  readonly expiresAt: Iso8601;
  readonly expiresInMs: number;
}

export interface NormalizedStrategy {
  readonly legs: readonly JobLegIntent[];
  readonly trigger: JobTrigger;
  readonly expiresAt: Iso8601;
  readonly expiresInMs: number;
}

export interface NormalizeOptions {
  /** The creation instant. Expiry is measured from here, not from a wall clock read twice. */
  readonly at: Iso8601;
  /** Required only by `sellFractionOfPosition`; nothing else reads the account. */
  readonly positions?: StrategyPositionReader;
  /** Overridable for tests. The beta cap is the default and the product rule. */
  readonly maxExpiryMs?: number;
  readonly signal?: AbortSignal;
}

/* ── Expiry ────────────────────────────────────────────────────────────────── */

/**
 * ADR-0005, as a function: mandatory, absolute, in the future, within the cap.
 *
 * Nothing is clamped. A request for thirty days is refused naming the seven-day
 * maximum, because a silently shortened expiry is a strategy the owner believes
 * is still armed three weeks after it stopped.
 */
export const resolveExpiry = (
  expiresAt: Iso8601 | undefined,
  at: Iso8601,
  maxExpiryMs: number = BETA_MAX_EXPIRY_MS,
): ResolvedExpiry => {
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) {
    throw new StrategyError('FIELD_INVALID', `creation instant is not a date: ${at}`, {
      field: 'at',
    });
  }
  if (expiresAt === undefined || (typeof expiresAt === 'string' && expiresAt.trim() === '')) {
    throw new StrategyError(
      'EXPIRY_REQUIRED',
      'expiresAt is required: there is no permanent watcher, so a strategy must say when it stops',
      { field: 'expiresAt', maxExpiryMs },
    );
  }
  // The type says string; a JSON caller is not bound by the type, and the whole
  // point of this function is to be the boundary that one crosses.
  if (typeof expiresAt !== 'string' || !ISO_INSTANT.test(expiresAt)) {
    throw new StrategyError(
      'EXPIRY_INVALID',
      `expiresAt must be an ISO-8601 instant with a zone (e.g. 2026-08-24T12:00:00Z), got ${expiresAt}`,
      { field: 'expiresAt', value: expiresAt },
    );
  }
  const expiryMs = Date.parse(expiresAt);
  if (Number.isNaN(expiryMs)) {
    throw new StrategyError('EXPIRY_INVALID', `expiresAt is not a real instant: ${expiresAt}`, {
      field: 'expiresAt',
      value: expiresAt,
    });
  }
  if (expiryMs <= atMs) {
    throw new StrategyError(
      'EXPIRY_IN_PAST',
      `expiresAt ${expiresAt} is not after the creation instant ${at}`,
      { field: 'expiresAt', expiresAt, at },
    );
  }
  const expiresInMs = expiryMs - atMs;
  if (expiresInMs > maxExpiryMs) {
    throw new StrategyError(
      'EXPIRY_TOO_FAR',
      `expiresAt ${expiresAt} is ${describeMs(expiresInMs)} away; the beta maximum is ${describeMs(maxExpiryMs)} and is not clamped silently`,
      {
        field: 'expiresAt',
        expiresInMs,
        maxExpiryMs,
        latestAllowed: new Date(atMs + maxExpiryMs).toISOString(),
      },
    );
  }
  return { expiresAt: new Date(expiryMs).toISOString(), expiresInMs };
};

const describeMs = (ms: number): string => {
  const days = ms / 86_400_000;
  return days >= 1 && Number.isInteger(days)
    ? `${String(days)} day${days === 1 ? '' : 's'}`
    : `${String(Math.round(ms / 3_600_000))} hours`;
};

/* ── Normalization ─────────────────────────────────────────────────────────── */

export const normalizeStrategy = async (
  request: StrategyRequest,
  options: NormalizeOptions,
): Promise<NormalizedStrategy> => {
  requireText(request.ownerAddress, 'ownerAddress');
  requireText(request.accountId, 'accountId');
  requireText(request.agentWallet, 'agentWallet');

  // A read-only policy is refused at creation rather than at the trigger. A
  // strategy exists in order to sign later; arming one that may not is a promise
  // the Runner would break hours after the owner walked away (ADR-0001 §9).
  if (request.policy.mode === 'read-only') {
    throw new StrategyError(
      'POLICY_FORBIDS_WRITE',
      'the policy in force is read-only, and a durable strategy exists to place an order later',
      { mode: request.policy.mode, source: request.policy.source },
    );
  }

  const expiry = resolveExpiry(request.expiresAt, options.at, options.maxExpiryMs);

  if (!Array.isArray(request.legs) || request.legs.length === 0) {
    throw new StrategyError(
      'NO_LEGS',
      'a strategy needs at least one leg; otherwise it watches a price and does nothing',
      { field: 'legs' },
    );
  }

  const legs: JobLegIntent[] = [];
  for (const [index, leg] of request.legs.entries()) {
    legs.push(await normalizeLeg(leg, index, request.accountId, options));
  }

  return {
    legs,
    trigger: normalizeTrigger(request.trigger, legs),
    expiresAt: expiry.expiresAt,
    expiresInMs: expiry.expiresInMs,
  };
};

const SIZING_FIELDS = [
  'buyAmount',
  'sellShares',
  'sellFractionOfPosition',
  'dynamicSellFractionOfPosition',
] as const;

type SizingField = (typeof SIZING_FIELDS)[number];

const normalizeLeg = async (
  leg: StrategyLegRequest,
  index: number,
  accountId: string,
  options: NormalizeOptions,
): Promise<JobLegIntent> => {
  const where = { leg: index };
  const marketId = requireText(leg.marketId, `legs[${String(index)}].marketId`);
  const outcomeId = requireOutcome(leg.outcomeId, index);
  const side = requireSide(leg.side, index);
  const maxSlippageBps = requireSlippage(leg.maxSlippageBps, index);

  const given = SIZING_FIELDS.filter((field) => leg[field] !== undefined);
  if (given.length === 0) {
    throw new StrategyError(
      'SIZE_MISSING',
      `legs[${String(index)}] has no size: a ${side} needs ${side === 'BUY' ? 'buyAmount' : 'sellShares, sellFractionOfPosition or dynamicSellFractionOfPosition'}`,
      where,
    );
  }
  if (given.length > 1) {
    throw new StrategyError(
      'SIZE_AMBIGUOUS',
      `legs[${String(index)}] gives more than one size (${given.join(', ')}); exactly one is required`,
      { ...where, given },
    );
  }
  const sizingField = given[0] as SizingField;

  if (side === 'BUY' && sizingField !== 'buyAmount') {
    throw new StrategyError(
      'SIZE_AMBIGUOUS',
      `legs[${String(index)}] is a BUY sized by ${sizingField}; a BUY commits a budget with buyAmount`,
      { ...where, side, given: sizingField },
    );
  }
  if (side === 'SELL' && sizingField === 'buyAmount') {
    throw new StrategyError(
      'SIZE_AMBIGUOUS',
      `legs[${String(index)}] is a SELL sized by buyAmount; a SELL closes shares`,
      { ...where, side, given: sizingField },
    );
  }

  if (side === 'BUY' && leg.positionId !== undefined) {
    throw new StrategyError(
      'POSITION_NOT_APPLICABLE',
      `legs[${String(index)}] is a BUY carrying positionId; a BUY opens exposure rather than closing a position`,
      where,
    );
  }
  const positionId =
    side === 'SELL'
      ? requirePositionId(leg.positionId, index)
      : undefined;

  const worstAcceptablePrice =
    leg.worstAcceptablePrice === undefined
      ? undefined
      : requirePrice(leg.worstAcceptablePrice, `legs[${String(index)}].worstAcceptablePrice`);

  const base = {
    marketId,
    outcomeId,
    side,
    maxSlippageBps,
    ...(positionId === undefined ? {} : { positionId }),
    ...(worstAcceptablePrice === undefined ? {} : { worstAcceptablePrice }),
  };

  switch (sizingField) {
    case 'buyAmount':
      return {
        ...base,
        buyAmount: requireSize(leg.buyAmount as string, `legs[${String(index)}].buyAmount`),
        sizing: { kind: 'ABSOLUTE' },
      };
    case 'sellShares':
      return {
        ...base,
        sellShares: requireSize(leg.sellShares as string, `legs[${String(index)}].sellShares`),
        sizing: { kind: 'ABSOLUTE' },
      };
    case 'dynamicSellFractionOfPosition': {
      // No position read here on purpose: nothing is being frozen, and the
      // executor must read the position at trigger time regardless. Reading it
      // now would only produce a number this mode promises not to use.
      const fraction = requireFraction(
        leg.dynamicSellFractionOfPosition as string,
        `legs[${String(index)}].dynamicSellFractionOfPosition`,
      );
      return { ...base, sizing: { kind: 'DYNAMIC_FRACTION', fraction } };
    }
    case 'sellFractionOfPosition': {
      const fraction = requireFraction(
        leg.sellFractionOfPosition as string,
        `legs[${String(index)}].sellFractionOfPosition`,
      );
      const frozen = await freezeFraction({
        fraction,
        index,
        accountId,
        // `positionId` is defined here: this branch is SELL-only, and a SELL
        // without one was refused above.
        positionId: positionId as string,
        marketId,
        outcomeId,
        options,
      });
      return { ...base, sellShares: frozen.sellShares, sizing: frozen.sizing };
    }
  }
};

/**
 * A fraction of a holding, as an exact share count.
 *
 * Shared by the two places a fraction becomes a size — freezing at creation, and
 * the dynamic mode's re-read at trigger — so the two cannot arrive at different
 * numbers from the same inputs. Scaled-integer arithmetic throughout, truncating
 * toward zero: `0.5` of an odd share count sells the smaller half, because the
 * larger one is shares the position does not have.
 *
 * `null` means the fraction truncated to nothing. That is not a size, and it is
 * returned rather than thrown so the trigger-time caller can skip one leg where
 * the creation-time caller refuses the whole strategy.
 */
export const sharesForFraction = (
  sharesHeld: DecimalString,
  fraction: DecimalString,
): DecimalString | null => {
  const shares = (toScaled(sharesHeld) * toScaled(fraction)) / ONE;
  return shares === 0n ? null : fromScaled(shares);
};

interface FreezeInput {
  readonly fraction: DecimalString;
  readonly index: number;
  readonly accountId: string;
  readonly positionId: string;
  readonly marketId: string;
  readonly outcomeId: PredictOutcomeId;
  readonly options: NormalizeOptions;
}

/**
 * "Half of what you hold" → an absolute share count, taken once.
 *
 * Every refusal below is a case where the alternative is sizing an order against
 * a number nobody verified: an unwired reader, an unproven absence, a position in
 * a different market, or a share count the server itself reported as unknown.
 */
const freezeFraction = async (
  input: FreezeInput,
): Promise<{ sellShares: DecimalString; sizing: JobLegSizing }> => {
  const { fraction, index, positionId, options } = input;
  const where = { leg: index, positionId };

  if (options.positions === undefined) {
    throw new StrategyError(
      'POSITION_READ_UNAVAILABLE',
      `legs[${String(index)}] freezes a fraction of ${positionId}, which needs an authoritative position read, and no reader is configured`,
      where,
    );
  }

  const lookup = await findPosition(options.positions, input.accountId, positionId, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!lookup.found) {
    throw lookup.proven
      ? new StrategyError(
          'POSITION_UNKNOWN',
          `position ${positionId} is not among account ${input.accountId}'s positions`,
          { ...where, accountId: input.accountId, pagesRead: lookup.pagesRead },
        )
      : new StrategyError(
          'POSITION_LOOKUP_INCONCLUSIVE',
          `position ${positionId} was not found, but the server never proved the list was complete; refusing to size against an unverified holding`,
          { ...where, accountId: input.accountId, pagesRead: lookup.pagesRead },
        );
  }

  const position = lookup.position;
  if (position.marketId !== input.marketId || position.outcomeId !== input.outcomeId) {
    throw new StrategyError(
      'POSITION_MISMATCH',
      `position ${positionId} is ${position.marketId}/${position.outcomeId}, but legs[${String(index)}] sells ${input.marketId}/${input.outcomeId}`,
      {
        ...where,
        positionMarketId: position.marketId,
        positionOutcomeId: position.outcomeId,
        legMarketId: input.marketId,
        legOutcomeId: input.outcomeId,
      },
    );
  }
  if (position.shares === null) {
    throw new StrategyError(
      'POSITION_SHARES_UNKNOWN',
      `the server reported the share count of ${positionId} as unknown; null is not zero, and a fraction of an unknown quantity is not a size`,
      where,
    );
  }

  // Validated before the arithmetic so a share count the server rendered in some
  // other form is a refusal a caller can branch on, not a RangeError from a
  // helper two layers down.
  parseScaled(position.shares, `position ${positionId} shares`, 'SIZE_INVALID', where);
  const frozenShares = sharesForFraction(position.shares, fraction);
  if (frozenShares === null) {
    throw new StrategyError(
      'FRACTION_RESOLVES_TO_ZERO',
      `${fraction} of the ${position.shares} shares held in ${positionId} rounds down to nothing`,
      { ...where, fraction, positionShares: position.shares },
    );
  }

  return {
    sellShares: frozenShares,
    sizing: {
      kind: 'FROZEN_FRACTION',
      fraction,
      positionSharesAtCreation: position.shares,
      frozenAt: input.options.at,
    },
  };
};

/* ── Trigger ───────────────────────────────────────────────────────────────── */

const normalizeTrigger = (
  trigger: StrategyTriggerRequest,
  legs: readonly JobLegIntent[],
): JobTrigger => {
  if (trigger.kind === 'IMMEDIATE') {
    const stray = ['targetPrice', 'marketId', 'outcomeId', 'side'].filter(
      (field) => (trigger as Record<string, unknown>)[field] !== undefined,
    );
    if (stray.length > 0) {
      throw new StrategyError(
        'TRIGGER_INVALID',
        `an IMMEDIATE trigger carries ${stray.join(', ')}; it fires on creation and watches nothing`,
        { given: stray },
      );
    }
    return { kind: 'IMMEDIATE' };
  }
  if (trigger.kind !== 'PRICE') {
    throw new StrategyError(
      'TRIGGER_INVALID',
      `unknown trigger kind ${JSON.stringify((trigger as { kind?: unknown }).kind)}`,
      { field: 'trigger.kind' },
    );
  }

  if (typeof trigger.targetPrice !== 'string' || trigger.targetPrice.trim() === '') {
    throw new StrategyError(
      'TRIGGER_INVALID',
      'a PRICE trigger needs targetPrice; without one there is nothing to wait for',
      { field: 'trigger.targetPrice' },
    );
  }
  const targetPrice = requirePrice(trigger.targetPrice, 'trigger.targetPrice');

  const named = (['marketId', 'outcomeId', 'side'] as const).filter(
    (field) => trigger[field] !== undefined,
  );
  if (named.length > 0 && named.length < 3) {
    throw new StrategyError(
      'TRIGGER_INCOMPLETE',
      `the watched market was named in part (${named.join(', ')}); give marketId, outcomeId and side together, or none and let the legs decide`,
      { given: named },
    );
  }

  const marketId =
    named.length === 3
      ? requireText(trigger.marketId, 'trigger.marketId')
      : unanimous(legs, 'marketId');
  const outcomeId =
    named.length === 3
      ? requireOutcomeField(trigger.outcomeId, 'trigger.outcomeId')
      : unanimous(legs, 'outcomeId');
  const side =
    named.length === 3 ? requireSideField(trigger.side, 'trigger.side') : unanimous(legs, 'side');

  return {
    kind: 'PRICE',
    targetPrice,
    marketId,
    outcomeId,
    side,
    // Derived, never accepted: a BUY target is a ceiling on the ask and a SELL
    // target a floor under the bid, and letting a caller pass the other one is
    // how a stop-loss becomes a take-profit (ADR-0001 §12).
    observe: side === 'BUY' ? 'ASK' : 'BID',
  };
};

/**
 * The one value every leg agrees on, or a refusal.
 *
 * With several legs there is no "the market" unless they say so themselves, and
 * picking the first leg's would arm the watcher on whichever leg happened to be
 * written first.
 */
const unanimous = <K extends 'marketId' | 'outcomeId' | 'side'>(
  legs: readonly JobLegIntent[],
  field: K,
): JobLegIntent[K] => {
  const distinct = [...new Set(legs.map((leg) => leg[field]))];
  const only = distinct[0];
  if (distinct.length !== 1 || only === undefined) {
    throw new StrategyError(
      'TRIGGER_AMBIGUOUS',
      `the legs disagree on ${field} (${distinct.join(', ')}), so the watched market cannot be derived; name trigger.marketId, trigger.outcomeId and trigger.side explicitly`,
      { field, distinct },
    );
  }
  return only;
};

/* ── Field validation ──────────────────────────────────────────────────────── */

const requireText = (value: string | undefined, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StrategyError('FIELD_REQUIRED', `${field} is required`, { field });
  }
  return value;
};

const requirePositionId = (value: string | undefined, index: number): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StrategyError(
      'POSITION_REQUIRED',
      `legs[${String(index)}] is a SELL without positionId; a SELL names the position it closes`,
      { leg: index },
    );
  }
  return value;
};

const requireOutcome = (value: PredictOutcomeId, index: number): PredictOutcomeId =>
  requireOutcomeField(value, `legs[${String(index)}].outcomeId`);

const requireOutcomeField = (
  value: PredictOutcomeId | undefined,
  field: string,
): PredictOutcomeId => {
  if (value !== 'YES' && value !== 'NO') {
    throw new StrategyError('FIELD_INVALID', `${field} must be YES or NO, got ${String(value)}`, {
      field,
      value,
    });
  }
  return value;
};

const requireSide = (value: PredictSide, index: number): PredictSide =>
  requireSideField(value, `legs[${String(index)}].side`);

const requireSideField = (value: PredictSide | undefined, field: string): PredictSide => {
  if (value !== 'BUY' && value !== 'SELL') {
    throw new StrategyError('FIELD_INVALID', `${field} must be BUY or SELL, got ${String(value)}`, {
      field,
      value,
    });
  }
  return value;
};

const requireSlippage = (value: number, index: number): number => {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new StrategyError(
      'FIELD_INVALID',
      `legs[${String(index)}].maxSlippageBps must be a whole number of basis points between 0 and 10000, got ${String(value)}`,
      { leg: index, field: 'maxSlippageBps', value },
    );
  }
  return value;
};

/** A size that would move nothing is refused rather than sent and rejected. */
const requireSize = (value: string, field: string): DecimalString => {
  const scaled = parseScaled(value, field, 'SIZE_INVALID', { field });
  if (scaled === 0n) {
    throw new StrategyError('SIZE_INVALID', `${field} is zero; that is not an order`, {
      field,
      value,
    });
  }
  return value;
};

/** `(0, 1]`. Above one would sell shares the position does not have. */
const requireFraction = (value: string, field: string): DecimalString => {
  const scaled = parseScaled(value, field, 'FRACTION_INVALID', { field });
  if (scaled <= 0n || scaled > ONE) {
    throw new StrategyError(
      'FRACTION_INVALID',
      `${field} must be a fraction greater than 0 and at most 1 (0.5 is half), got ${value}`,
      { field, value },
    );
  }
  return value;
};

/** Contract: a price is a probability in the inclusive range 0–1. */
const requirePrice = (value: string, field: string): PriceString => {
  const scaled = parseScaled(value, field, 'FIELD_INVALID', { field });
  if (scaled > ONE) {
    throw new StrategyError(
      'FIELD_INVALID',
      `${field} must be a probability between 0 and 1, got ${value}`,
      { field, value },
    );
  }
  return value;
};

/**
 * `toScaled` with the RangeError turned into a refusal a caller can branch on.
 * A malformed decimal reaching a comparison is exactly the failure the exact
 * arithmetic exists to prevent, so it never gets past this layer.
 */
const parseScaled = (
  value: string,
  field: string,
  code: 'SIZE_INVALID' | 'FRACTION_INVALID' | 'FIELD_INVALID',
  detail: Readonly<Record<string, unknown>>,
): bigint => {
  try {
    return toScaled(value);
  } catch (error) {
    throw new StrategyError(
      code,
      `${field} is not a decimal string with at most 6 decimal places: ${JSON.stringify(value)}`,
      { ...detail, value, cause: error instanceof Error ? error.message : String(error) },
    );
  }
};
