/**
 * The write plane, and the reads that exist to reconcile it.
 *
 * FIVE COMMANDS, ONE RULE: nothing here signs a transaction that the execution
 * policy has not already authorized. `preview` proves that by signing nothing at
 * all; `execute` and `execute-many` authorize FIRST, grant exactly as many
 * signing permits as they were allowed orders, and only then call the SDK. A
 * path that skipped the authorization would not merely miss a check — the
 * signing gate would refuse it, because it would have no permit to spend.
 *
 * WHAT THIS MODULE WILL NOT DO:
 *  - resolve a market identity itself. Every id comes back from the server.
 *  - guess a size unit. A BUY commits `buyAmount` and a SELL closes `sellShares`;
 *    an ambiguous intent stops before the write (ADR-0001 §11).
 *  - report a timed-out wait as a failure, or as a fill. It is neither: the order
 *    is on-chain, the execution id is valid, and the exit code says AMBIGUOUS so
 *    a shell script cannot mistake it for done.
 *  - retry a write. One idempotency key covers one logical intent, and choosing
 *    to try again is the caller's decision, made with the execution id in hand.
 *  - invent a risk limit. `preview` reports the mandate the server states, and
 *    says which of "not read" and "no mandate" applies when there is none. It
 *    still cannot raise one: risk-profile writes are owner-authenticated
 *    (ADR-0003).
 *  - enforce a limit locally. The blockers a preview reports are the server's
 *    reading a moment ago; the server decides again at execution time.
 */
import { randomUUID } from 'node:crypto';

import type {
  CreateQuoteRequestBody,
  ExecuteManyResult,
  ExecuteMarketOrderIntent,
  ExecuteMarketOrderOptions,
  PredictAgentMarket,
  PredictEffectiveLimitsResponseBody,
  PredictMarketOutcome,
  PredictOutcomeId,
} from '@waterx/predict-agent-sdk';
import { toExecutionOutcome } from '@waterx/predict-agent-sdk';

import { exitCodeForThrown } from '../client.ts';
import type { CommandContext } from '../context.ts';
import { estimateWorstAcceptablePrice } from '../decimal.ts';
import { CliError, isCliError } from '../errors.ts';
import { EXIT_CODES } from '../exit-codes.ts';
import {
  approvalToken,
  authorizeWrite,
  batchApprovalToken,
  normalizeLeg,
  type NormalizedLeg,
  type WriteAuthorization,
} from '../policy.ts';

/**
 * Why a preview carries no mandate.
 *
 * Two distinct cases, and collapsing them would be the bug: NOT_READ means this
 * preview did not ask (a read-only policy previews without touching the account
 * plane at all), while NO_RISK_PROFILE means it asked and no owner has granted
 * one. The first is a gap in this reading; the second is a refusal waiting to
 * happen.
 */
const RISK_LIMITS_NOT_READ = {
  available: false,
  reason: 'NOT_READ',
  detail:
    'This preview ran under a read-only policy and did not read the account plane, so no mandate is reported. None is guessed either.',
  alternative: 'Run `account risk-limits --accountId <id>` for the mandate and the live blockers.',
} as const;

const RISK_LIMITS_NO_MANDATE = {
  available: false,
  reason: 'NO_RISK_PROFILE',
  detail:
    'No owner has granted this agent a risk profile on this account. Absence is denial, not an unlimited default — an execution would be refused.',
  alternative:
    'The account owner must create the profile through the owner-authenticated surface (ADR-0003). An agent credential can never raise its own limits.',
} as const;

const WRITE_CAVEATS: readonly string[] = [
  'A quote is re-checked by the server at execution time. Price protection is honoured; a fill is never guaranteed.',
  '`enforcedWorstPrice` is the bound the chain applied. It may be stricter than the one requested — after granularity rounding — and is never looser.',
  'SUBMITTED and PENDING_FILL are not fills. Only a terminal read carries `fill`, fee availability and remaining allowance.',
  'Reuse `idempotencyKey` for any retry of this same intent. A fresh key is a second order.',
];

/* ── Intent plumbing ───────────────────────────────────────────────────────── */

const sizeOf = (leg: NormalizedLeg): { buyAmount: string } | { sellShares: string } =>
  leg.sizeUnit === 'WXUSD_BUDGET' ? { buyAmount: leg.size } : { sellShares: leg.size };

const toQuoteRequest = (leg: NormalizedLeg): CreateQuoteRequestBody => ({
  marketId: leg.marketId,
  outcomeId: leg.outcomeId as PredictOutcomeId,
  side: leg.side,
  size: sizeOf(leg),
});

/**
 * Normalized leg + the caller's quote → the SDK intent.
 *
 * Optional fields are omitted rather than sent as null: the wire contract's
 * optionality means "absent", and an explicit null is a different request.
 */
/**
 * `referenceQuoteId` is passed through only when the caller supplied one.
 *
 * Omitted, the SDK mints the quote immediately before the create — which for a
 * leg of `execute-many` is the only moment a live quote can exist, because it
 * falls after every earlier leg has finished.
 */
function toIntent(
  leg: NormalizedLeg,
  referenceQuoteId: string | undefined,
  idempotencyKey: string | undefined,
): ExecuteMarketOrderIntent {
  return {
    accountId: leg.accountId,
    marketId: leg.marketId,
    outcomeId: leg.outcomeId as PredictOutcomeId,
    side: leg.side,
    size: sizeOf(leg),
    ...(referenceQuoteId !== undefined ? { referenceQuoteId } : {}),
    maxSlippageBps: leg.maxSlippageBps,
    ...(leg.positionId !== null ? { positionId: leg.positionId } : {}),
    ...(leg.worstAcceptablePrice !== null
      ? { worstAcceptablePrice: leg.worstAcceptablePrice }
      : {}),
    ...(leg.strategyId !== null ? { strategyId: leg.strategyId } : {}),
    ...(leg.clientOrderId !== null ? { clientOrderId: leg.clientOrderId } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

/**
 * `waitFor`/`timeoutMs` from the input, plus a deadline wide enough to hold them.
 *
 * The abort signal must OUTLIVE a terminal wait. A signal that fired first would
 * abort the poll mid-flight and turn "we stopped watching, here are the facts"
 * into "the request failed" — the exact collapse the timeout/failure distinction
 * exists to prevent. So the wait bound wins, with slack for the read in progress.
 */
function waitOptions(context: CommandContext): ExecuteMarketOrderOptions {
  const waitFor = context.input.waitFor;
  const timeoutMs = context.input.timeoutMs;
  const waiting = waitFor === 'TERMINAL' && typeof timeoutMs === 'number';
  return {
    ...(waitFor === 'SUBMITTED' || waitFor === 'TERMINAL' ? { waitFor } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    signal: context.signal(waiting ? timeoutMs + WAIT_SLACK_MS : undefined),
  };
}

/** Room for the in-flight read that discovers the wait has expired. */
const WAIT_SLACK_MS = 15_000;

/**
 * The caller's quote, when they minted one at the right moment.
 *
 * `undefined` is not a missing value here — it hands the timing to the SDK, which
 * mints the quote immediately before the create. That is the only correct choice
 * inside `execute-many`: a quote lives seconds, so pre-minting a batch's quotes
 * guarantees the second leg's has died by the time its turn comes (backlog 1.11).
 *
 * What is still refused is a quote that is present and malformed. Absence is a
 * decision; an empty string is a mistake.
 */
const optionalQuoteId = (input: Readonly<Record<string, unknown>>): string | undefined => {
  const id = input.referenceQuoteId;
  if (id === undefined) return undefined;
  if (typeof id !== 'string' || id === '') {
    throw new CliError(
      'INVALID_INPUT',
      '`referenceQuoteId` was given but is not a non-empty string. Omit it to have the quote minted when the order is placed, or pass one from `market quote`.',
      { field: 'referenceQuoteId' },
    );
  }
  return id;
};

const requireQuoteId = (input: Readonly<Record<string, unknown>>): string => {
  const id = input.referenceQuoteId;
  if (typeof id !== 'string' || id === '') {
    throw new CliError(
      'INVALID_INPUT',
      '`referenceQuoteId` is required: an order is priced against an executable quote from `market quote`, never against a catalog price.',
    );
  }
  return id;
};

/**
 * The key this write will carry, minted here rather than deeper down, and
 * announced before the request leaves.
 *
 * The SDK mints one when a caller omits it, and reuses it across every internal
 * retry — but that value only ever exists inside the call. A process killed
 * mid-write therefore takes with it the one handle that could tell anybody
 * whether the order landed, and a re-run mints a different key, which is how one
 * intent becomes two orders.
 *
 * The Runner solved the same problem by writing the key to its durable store
 * before the create (`packages/runner/src/recovery.ts`). A one-shot command has
 * no store and does not need one: minting the key here and printing it BEFORE
 * the write puts it somewhere that outlives the process — a terminal, a log, a
 * CI transcript — which is all a replay needs, since the caller still holds the
 * input they typed.
 *
 * This does not disturb the approval: `NormalizedLeg` deliberately excludes
 * `idempotencyKey`, because it changes how a retry behaves and not what is
 * traded, so a token minted by `order preview` still matches.
 */
const idempotencyKeyFor = (
  input: Readonly<Record<string, unknown>>,
  context: CommandContext,
  /** Present for `execute-many`, where a key belongs to one leg among several. */
  legIndex?: number,
): string => {
  const supplied =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey !== ''
      ? input.idempotencyKey
      : undefined;
  if (supplied !== undefined) return supplied;

  const minted = randomUUID();
  const which = legIndex === undefined ? 'this order' : `leg ${String(legIndex)}`;
  context.diagnostic(
    `Idempotency key for ${which}: ${minted}\nIf this command dies before it answers, the order may still have been placed. Replay the SAME input with \`idempotencyKey: "${minted}"\` — never a fresh one.\n`,
  );
  return minted;
};

/* ── Authorization ─────────────────────────────────────────────────────────── */

/**
 * Read the account's spendable capacity, for the delegated-auto ceiling check.
 *
 * Only under delegated-auto, and only when the batch buys: it is one extra read
 * before a write, justified because a local ceiling must never authorize more
 * than the exchange currently allows. Under interactive the human-carried
 * approval is the constraint, and the server enforces its own limits regardless.
 */
async function readBuyCapacity(
  context: CommandContext,
  legs: readonly NormalizedLeg[],
): Promise<string | undefined> {
  if (context.config.policy.mode !== 'delegated-auto') return undefined;
  const buying = legs.find((leg) => leg.side === 'BUY');
  if (buying === undefined) return undefined;
  const client = await context.client();
  const allowance = await client.getAllowance(buying.accountId, context.signal());
  return allowance.effectiveBuyCapacity;
}

/**
 * Authorize, then hand the signer exactly as many permits as orders.
 *
 * Everything decidable LOCALLY is decided first, before the capacity read: an
 * order the scope already refuses must cost nothing at all, and reading the
 * allowance for an account the delegation does not name would turn a local
 * refusal into whatever the server said about an account this run may not touch.
 * The second pass adds the server's figure and can only refuse further.
 *
 * `authorizeWrite` throws on denial, so there is no branch here in which an
 * unauthorized write continues.
 */
async function authorize(
  context: CommandContext,
  command: string,
  legs: readonly NormalizedLeg[],
): Promise<WriteAuthorization> {
  const request = { command, legs, approval: context.approval, now: context.now() };
  const local = authorizeWrite(context.config.policy, request);

  const effectiveBuyCapacity = await readBuyCapacity(context, legs);
  const authorization =
    effectiveBuyCapacity === undefined
      ? local
      : authorizeWrite(context.config.policy, { ...request, effectiveBuyCapacity });

  context.gate.grant(authorization);
  return authorization;
}

/** What the result records about the decision. Never the approval's provenance. */
const policyRecord = (context: CommandContext, authorization: WriteAuthorization): unknown => ({
  mode: context.config.policy.mode,
  source: context.config.policy.source,
  basis: authorization.basis,
  approvalToken: authorization.token,
  ...(authorization.checks.length > 0 ? { scopeChecks: authorization.checks } : {}),
  signatures: context.gate.stats,
  note: 'An approval token binds one exact intent. It is not authentication and does not prove a person saw the order.',
});

/* ── order preview ─────────────────────────────────────────────────────────── */

const outcomeOf = (
  market: PredictAgentMarket,
  outcomeId: string,
): PredictMarketOutcome | undefined =>
  market.outcomes.find((outcome) => outcome.outcomeId === outcomeId);

/**
 * The policy verdict, as a REPORT rather than a refusal.
 *
 * Preview is a read: it must answer on a read-only machine, and answering "this
 * write would be refused, here is why" is the whole point. So the denial is
 * caught and described instead of thrown — the only place in this module where
 * that is true, and safe precisely because nothing is signed here.
 */
function previewPolicy(
  context: CommandContext,
  legs: readonly NormalizedLeg[],
  token: string,
  effectiveBuyCapacity: string | undefined,
): unknown {
  const policy = context.config.policy;
  const base = { mode: policy.mode, source: policy.source, approvalToken: token };

  if (policy.mode === 'read-only') {
    return {
      ...base,
      decision: 'DENIED',
      reason: 'READ_ONLY',
      detail:
        'This runtime signs no transactions. `order execute` is refused locally before anything is sent.',
    };
  }

  if (policy.mode === 'interactive') {
    return {
      ...base,
      decision: 'APPROVAL_REQUIRED',
      approveWith: `--approve ${token}`,
      detail:
        'Pass the token back to `order execute` to authorize exactly this order. Change the account, market, side, size, position or price protection and the token no longer matches.',
      note: 'The token binds an intent; it is not authentication. It proves a caller carried a value from this preview to an execution, not that a person read it.',
    };
  }

  try {
    const authorization = authorizeWrite(policy, {
      command: 'order.execute',
      legs,
      // A delegated-auto decision must not depend on an approval: reporting
      // "allowed" here only because one was supplied would misdescribe the
      // policy that is actually in force.
      approval: undefined,
      ...(effectiveBuyCapacity !== undefined ? { effectiveBuyCapacity } : {}),
      now: context.now(),
    });
    return {
      ...base,
      decision: 'ALLOWED_BY_SCOPE',
      scopeChecks: authorization.checks,
      detail:
        'The configured delegation covers this order, so `order execute` proceeds without a per-order approval. The server still enforces the owner’s risk profile independently.',
    };
  } catch (error: unknown) {
    if (!isCliError(error)) throw error;
    return {
      ...base,
      decision: 'DENIED',
      reason: error.code,
      detail: error.message,
      ...(error.details !== undefined ? { violation: error.details } : {}),
    };
  }
}

/**
 * Why there is no spendable figure — three different answers, kept apart.
 *
 * A SELL never had one. A read-only preview did not ask. A BUY that asked and
 * got nothing has no mandate, and therefore no allowance ledger — which is the
 * one of the three that will refuse an execution.
 */
function capacityAbsence(
  side: 'BUY' | 'SELL',
  facts: PredictEffectiveLimitsResponseBody | null,
): { reason: string; detail: string } {
  if (side === 'SELL') {
    return {
      reason: 'NOT_APPLICABLE_TO_SELL',
      detail: 'A SELL closes shares and does not spend the wxUSD allowance.',
    };
  }
  if (facts === null) {
    return {
      reason: 'NOT_READ',
      detail: 'The allowance was not read for this preview.',
    };
  }
  return {
    reason: 'NO_RISK_PROFILE',
    detail:
      'No owner has granted this agent a risk profile on this account, so there is no allowance ledger to spend from. An execution would be refused.',
  };
}

/**
 * Resolve, price and policy-check one order — and place nothing.
 *
 * The market read is what makes the identity SERVER-resolved rather than
 * caller-asserted, and the quote is minted here so the estimate below is against
 * a price that exists rather than one the caller remembered.
 */
/**
 * One leg, priced and policy-checked. The body of what `order preview` has
 * always done, now reachable per leg so a batch can be previewed the same way a
 * single order is — see {@link orderPreview}.
 */
async function previewOneLeg(context: CommandContext, leg: NormalizedLeg): Promise<unknown> {
  const client = await context.client();

  // One account read covers both halves of the policy picture — the allowance a
  // BUY spends and the mandate either side trades under — so a preview that
  // reports both still makes exactly one extra call. A read-only preview skips
  // it: it is pricing an order it has already refused to place.
  const wantsFacts = context.config.policy.mode !== 'read-only';
  const [market, quote, facts] = await Promise.all([
    client.getMarket(leg.marketId, context.signal()),
    client.getQuote(toQuoteRequest(leg), context.signal()),
    wantsFacts ? client.getEffectiveLimits(leg.accountId, context.signal()) : Promise.resolve(null),
  ]);

  // A SELL closes shares and spends no wxUSD allowance, so capacity stays
  // inapplicable for it even though the same read returned one.
  const allowance = leg.side === 'BUY' ? (facts?.allowance ?? null) : null;

  const outcome = outcomeOf(market.market, leg.outcomeId);
  const token = approvalToken(leg);
  const estimate = estimateWorstAcceptablePrice({
    side: leg.side,
    referencePrice: quote.expectedPrice,
    maxSlippageBps: leg.maxSlippageBps,
    ...(leg.worstAcceptablePrice !== null
      ? { worstAcceptablePrice: leg.worstAcceptablePrice }
      : {}),
  });

  return {
    placed: false,
    intent: leg,
    market: {
      marketId: market.market.marketId,
      title: market.market.title,
      status: market.market.status,
      tradeable: market.market.tradeable,
      ...(market.market.tradeabilityReason !== undefined
        ? { tradeabilityReason: market.market.tradeabilityReason }
        : {}),
      closesAt: market.market.closesAt,
      outcome:
        outcome === undefined
          ? {
              resolved: false,
              detail: `The server’s market definition has no outcome \`${leg.outcomeId}\`. Executing would be refused.`,
            }
          : { resolved: true, ...outcome },
    },
    quote: {
      quoteId: quote.quoteId,
      expectedPrice: quote.expectedPrice,
      expiresAt: quote.expiresAt,
      liquidityTier: quote.liquidityTier,
      qualityFlags: quote.qualityFlags,
      expectedFillSize: quote.expectedFillSize,
      availableSize: quote.availableSize,
      feeAmount: quote.feeAmount,
    },
    priceProtection: {
      maxSlippageBps: leg.maxSlippageBps,
      worstAcceptablePrice: leg.worstAcceptablePrice,
      estimate:
        estimate === null
          ? {
              available: false,
              reason: 'REFERENCE_PRICE_UNUSABLE',
              detail:
                'The quote’s expected price is not a usable probability price, so no bound is estimated here. The server computes the authoritative one regardless.',
            }
          : {
              available: true,
              bound: leg.side === 'BUY' ? 'CEILING' : 'FLOOR',
              fromSlippage: estimate.fromSlippage,
              effective: estimate.effective,
              binding: estimate.binding,
            },
      note: 'An ESTIMATE against this quote, computed locally with the server’s own rounding. The server recomputes it against the submission-time quote and the chain may tighten it further at price granularity — never loosen it.',
    },
    capacity:
      allowance === null
        ? {
            available: false,
            ...capacityAbsence(leg.side, facts),
          }
        : {
            available: true,
            apiAllowance: allowance.apiAllowance,
            accountSpendableBalance: allowance.accountSpendableBalance,
            effectiveBuyCapacity: allowance.effectiveBuyCapacity,
          },
    riskLimits:
      facts === null
        ? RISK_LIMITS_NOT_READ
        : facts.limits === null
          ? RISK_LIMITS_NO_MANDATE
          : { available: true, ...facts.limits },
    // The live policy gate, reported but never enforced here: this command
    // places nothing, and an empty `blockers` is not a promise of a fill.
    ...(facts === null
      ? {}
      : {
          blockers: facts.blockers,
          delegation: facts.delegation,
          usage: facts.usage,
        }),
    policy: previewPolicy(
      context,
      [leg],
      token,
      allowance === null ? undefined : allowance.effectiveBuyCapacity,
    ),
    nextStep: {
      command: 'order execute',
      referenceQuoteId: quote.quoteId,
      detail:
        'Quote a fresh price immediately before executing. This quote expires, and an expired one is refused rather than extended.',
    },
    caveats: [
      'Nothing was placed and nothing was signed. This command mints a quote and reads; that is its entire effect.',
      'Quotes are size-blind on this API version: `availableSize` and `expectedFillSize` are null, so a large order can be correctly priced and still fail to fill (backlog B5).',
      ...WRITE_CAVEATS.slice(0, 2),
    ],
  };
}

/**
 * `order preview` — one intent, or a whole batch.
 *
 * A batch has to be previewable for the same reason a single order does: under
 * `interactive` the write needs an approval, and an approval is a digest of the
 * exact intent. Before this, `order execute-many` had no preview at all, so the
 * only way to learn a batch's token was to be REFUSED once and read it out of
 * the error — a flow that works but cannot honestly be written down as the way
 * to place a multi-leg order.
 *
 * The batch token is not a new idea here: `batchApprovalToken` already derives it
 * from the per-leg tokens in order, precisely so a caller could reproduce it.
 * What was missing was somewhere to get it without computing a SHA-256 by hand.
 *
 * Legs are previewed CONCURRENTLY, which is safe because a preview signs nothing
 * and places nothing — the sequencing that matters belongs to `execute-many`,
 * where each leg is quoted in its own turn.
 */
export async function orderPreview(context: CommandContext): Promise<unknown> {
  const orders = context.input['orders'];
  if (orders === undefined) return await previewOneLeg(context, normalizeLeg(context.input));

  if (!Array.isArray(orders) || orders.length === 0) {
    throw new CliError('INVALID_INPUT', '`orders` must be a non-empty array of order intents.');
  }
  const legs = (orders as Record<string, unknown>[]).map((order) => normalizeLeg(order));
  const previews = await Promise.all(legs.map((leg) => previewOneLeg(context, leg)));
  const token = batchApprovalToken(legs);
  const mode = context.config.policy.mode;

  return {
    placed: false,
    atomic: false,
    legs: previews,
    policy: {
      mode,
      source: context.config.policy.source,
      approvalToken: token,
      ...(mode === 'interactive'
        ? { decision: 'APPROVAL_REQUIRED', approveWith: `--approve ${token}` }
        : {}),
      note: 'One token approves the whole batch, in this order. Reordering the legs is a different intent and a different token, because a batch that stops on the first failure is not the same batch reversed.',
    },
    caveats: [
      'A preview places nothing and signs nothing. Every leg below is priced against a quote that has already begun expiring.',
      'This is client-side orchestration, not a backend batch: legs succeed or fail independently and nothing is rolled back.',
      'Each leg is quoted again, in its own turn, when `order execute-many` runs it. The prices here are indicative of that moment, not of it.',
    ],
  };
}


/* ── order execute ─────────────────────────────────────────────────────────── */

/**
 * Place one protected market order.
 *
 * The order of operations is the safety property: normalize (which is where an
 * ambiguous size dies), authorize (which is where an unapproved or out-of-scope
 * one dies), grant permits, then — and only then — create, sign and submit.
 */
export async function orderExecute(context: CommandContext): Promise<unknown> {
  const leg = normalizeLeg(context.input);
  const referenceQuoteId = requireQuoteId(context.input);
  const authorization = await authorize(context, 'order.execute', [leg]);

  const client = await context.client();
  // Minted and announced BEFORE the request, so a process that dies mid-write
  // leaves the key behind rather than taking it with it.
  const result = await client.executeMarketOrder(
    toIntent(leg, referenceQuoteId, idempotencyKeyFor(context.input, context)),
    waitOptions(context),
  );

  if (result.timedOut) {
    context.exitAs(EXIT_CODES.AMBIGUOUS);
    context.diagnostic(
      `The wait for ${result.executionId} ran out before a terminal status. The order was NOT cancelled; reconcile with \`order reconcile --executionId ${result.executionId}\`.`,
    );
  }

  return {
    placed: true,
    execution: result,
    /**
     * Repeated at the top level because it is the field a caller must persist:
     * everything about recovering from an ambiguous outcome starts here.
     */
    executionId: result.executionId,
    idempotencyKey: result.idempotencyKey,
    policy: policyRecord(context, authorization),
    ...(result.timedOut
      ? {
          reconciliation: {
            required: true,
            reason: 'WAIT_TIMED_OUT',
            detail:
              'The wait ended before the execution did. This is not a failure and not a cancellation: the order is on-chain and may still fill.',
            command: `order reconcile --executionId ${result.executionId}`,
            neverDo: 'Do not resubmit under a fresh idempotency key. That places a second order.',
          },
        }
      : {}),
    caveats: [...WRITE_CAVEATS],
  };
}

/* ── order get / order reconcile ───────────────────────────────────────────── */

const executionIdOf = (context: CommandContext): string => String(context.input.executionId);

/** One read of one execution. Places nothing, so it is always safe to repeat. */
export async function orderGet(context: CommandContext): Promise<unknown> {
  const client = await context.client();
  const read = await client.getExecution(executionIdOf(context), context.signal());
  const outcome = toExecutionOutcome(read, false);
  return {
    execution: outcome,
    caveats: [
      'A non-terminal status means the order is still live. It is not a failure and it is not a fill.',
      '`fee.available: false` with reason EMBEDDED_IN_PRICE means the published price is already fee-adjusted — not that the fee was zero.',
    ],
  };
}

/**
 * How long a reconcile waits when the caller names no bound.
 *
 * Stated here rather than inherited from the SDK, because the deadline below has
 * to be computed from the SAME number the wait uses. A default that lived only
 * in the client would leave this signal sized against the wrong one.
 */
const RECONCILE_TIMEOUT_MS = 60_000;

/**
 * Wait for one execution to stop moving.
 *
 * Running out of time is reported, not thrown: the exit code says AMBIGUOUS and
 * the execution id comes back intact, which is exactly what a caller needs to
 * try again. Throwing would push facts that are not failures into a catch block.
 *
 * Which is why the deadline is widened to hold the wait, exactly as `execute`
 * does. This is the command an ambiguous outcome tells a caller to run; letting
 * the 15-second invocation timeout abort a 60-second reconcile would turn "not
 * terminal yet, here is the id" back into "the request failed" — for the one
 * caller who is already holding an order whose outcome it does not know.
 */
export async function orderReconcile(context: CommandContext): Promise<unknown> {
  const executionId = executionIdOf(context);
  const timeoutMs =
    typeof context.input.timeoutMs === 'number' ? context.input.timeoutMs : RECONCILE_TIMEOUT_MS;
  const client = await context.client();
  const outcome = await client.waitForExecution(executionId, {
    timeoutMs,
    ...(typeof context.input.pollIntervalMs === 'number'
      ? { pollIntervalMs: context.input.pollIntervalMs }
      : {}),
    signal: context.signal(timeoutMs + WAIT_SLACK_MS),
  });

  if (outcome.timedOut) context.exitAs(EXIT_CODES.AMBIGUOUS);

  return {
    execution: outcome,
    resolved: outcome.terminal,
    ...(outcome.timedOut
      ? {
          reconciliation: {
            required: true,
            reason: 'WAIT_TIMED_OUT',
            detail:
              'Still not terminal when the wait ended. Nothing was cancelled and nothing was resubmitted; run this command again with the same execution id.',
          },
        }
      : {}),
    caveats: [
      'This command places nothing, cancels nothing and signs nothing. Repeating it cannot cost anything.',
      'Only a terminal read carries `fill`, fee availability and remaining allowance.',
    ],
  };
}

/* ── order execute-many ────────────────────────────────────────────────────── */

interface LegReport {
  readonly index: number;
  readonly status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  readonly intent: NormalizedLeg;
  readonly execution?: unknown;
  readonly executionId?: string;
  readonly idempotencyKey?: string;
  readonly error?: unknown;
  readonly detail?: string;
}

/** A leg's failure, flattened for the envelope. Never the raw thrown object. */
function describeLegError(error: unknown): Record<string, unknown> {
  if (isCliError(error)) {
    return {
      code: error.code,
      message: error.message,
      source: 'CLI',
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  const api = error as { code?: unknown; message?: unknown; retryable?: unknown } | null;
  if (api !== null && typeof api.code === 'string') {
    return {
      code: api.code,
      message: String(api.message ?? ''),
      source: 'SERVER',
      retryable: api.retryable === true,
    };
  }
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : 'An unrecognised failure occurred.',
    source: 'CLI',
  };
}

function toLegReport(leg: NormalizedLeg, result: ExecuteManyResult | undefined): LegReport {
  const index = result?.index ?? 0;
  if (result === undefined) {
    return {
      index,
      status: 'SKIPPED',
      intent: leg,
      detail: 'The runtime returned no result for this leg. It was not launched.',
    };
  }
  if (result.ok) {
    return {
      index: result.index,
      status: 'SUCCEEDED',
      intent: leg,
      execution: result.result,
      executionId: result.result.executionId,
      idempotencyKey: result.result.idempotencyKey,
    };
  }
  if ('skipped' in result) {
    return {
      index: result.index,
      status: 'SKIPPED',
      intent: leg,
      detail:
        'Not launched: an earlier leg failed under failurePolicy STOP. Nothing was sent for this leg, so it is safe to resubmit exactly it.',
    };
  }
  return {
    index: result.index,
    status: 'FAILED',
    intent: leg,
    error: describeLegError(result.error),
  };
}

/**
 * Several independent orders, with independent results.
 *
 * NOT atomic and never described as if it were: every leg has its own quote,
 * idempotency key, execution and outcome, and partial success is the expected
 * case rather than an edge one. `failurePolicy: STOP` stops legs that have not
 * LAUNCHED; it cannot cancel or roll back one already submitted, and saying so
 * is more useful than a batch abstraction that pretends otherwise.
 *
 * The whole batch is authorized once, before any leg runs, and the signing gate
 * gets exactly as many permits as there are approved legs — so a bug that tried
 * to place an extra order would run out of permits rather than trade.
 */
export async function orderExecuteMany(context: CommandContext): Promise<unknown> {
  const raw = context.input.orders;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CliError('INVALID_INPUT', '`orders` must be a non-empty array of order intents.');
  }
  const orders = raw as Record<string, unknown>[];
  const legs = orders.map((order) => normalizeLeg(order));
  const quoteIds = orders.map((order) => optionalQuoteId(order));
  // One key per LEG, not one per call: the legs are separate logical intents and
  // sharing a key between them would make the second a duplicate of the first.
  //
  // Announced per leg, and by index, because this call is never atomic: a
  // process that dies partway leaves some legs placed and some not, and the only
  // way to replay exactly the ones that did not land is to know which key
  // belonged to which.
  const keys = orders.map((order, index) => idempotencyKeyFor(order, context, index));

  const authorization = await authorize(context, 'order.execute-many', legs);

  const client = await context.client();
  const results = await client.executeMany(
    legs.map((leg, index) => toIntent(leg, quoteIds[index], keys[index])),
    {
      ...waitOptions(context),
      ...(typeof context.input.concurrency === 'number'
        ? { concurrency: context.input.concurrency }
        : {}),
      ...(context.input.failurePolicy === 'CONTINUE' || context.input.failurePolicy === 'STOP'
        ? { failurePolicy: context.input.failurePolicy }
        : {}),
    },
  );

  const reports = legs.map((leg, index) => toLegReport(leg, results[index]));
  const succeeded = reports.filter((report) => report.status === 'SUCCEEDED');
  const failed = reports.filter((report) => report.status === 'FAILED');
  const skipped = reports.filter((report) => report.status === 'SKIPPED');
  const ambiguous = results.some(
    (result) => result !== undefined && result.ok && result.result.timedOut,
  );

  // An unknown outcome outranks a known refusal: a caller that retried on the
  // refusal's exit code would be retrying a leg that may already be filling.
  if (ambiguous) {
    context.exitAs(EXIT_CODES.AMBIGUOUS);
  } else {
    const firstFailure = results.find(
      (result): result is Extract<ExecuteManyResult, { error: unknown }> =>
        result !== undefined && !result.ok && 'error' in result,
    );
    if (firstFailure !== undefined) context.exitAs(exitCodeForThrown(firstFailure.error));
  }

  return {
    atomic: false,
    legs: reports.length,
    summary: {
      succeeded: succeeded.length,
      failed: failed.length,
      skipped: skipped.length,
      ambiguous,
    },
    results: reports,
    policy: policyRecord(context, authorization),
    caveats: [
      'This is client-side orchestration, not a backend batch. Legs are independent and no ordering or atomicity is implied.',
      '`failurePolicy: STOP` prevents legs that have not launched from launching. It cannot cancel or roll back one already submitted or filled.',
      'A SKIPPED leg sent nothing, so exactly it can be resubmitted. A FAILED leg has an error naming what refused it.',
      ...WRITE_CAVEATS,
    ],
  };
}
