/**
 * The thing that makes a durable job move.
 *
 * Everything else in this package records what happened; this is the only module
 * that causes it. One call is one *pass*: it reads the job, does at most one
 * unit of forward progress, and returns what it did. A pass never loops, never
 * sleeps and never schedules — the caller decides cadence, which is what lets a
 * test drive a whole strategy deterministically without a clock.
 *
 * ## Why the whole trigger is one pass
 *
 * Two values in the sequence are deliberately never persisted: the sponsored
 * transaction bytes and the signature over them (ADR-0001 §7 — a job store
 * holding either would be a second copy of the signer's secrets on disk). A
 * dynamic fraction's resolved share count is not persisted before the create
 * either, because the leg it belongs to has not been reserved yet.
 *
 * So `TRIGGERED → QUOTING → CREATING → AWAITING_SIGNATURE → SUBMITTING →
 * SUBMITTED` runs inside a single pass, and every crash inside it is recoverable
 * by *evidence* rather than by resumption:
 *
 *   - before a leg is reserved — nothing was sent, and recovery re-arms the job
 *     (`classify` maps `TRIGGERED`/`QUOTING` back to `WATCHING`);
 *   - after a leg is reserved and an attempt is open — a request may exist, so
 *     the job goes to `UNKNOWN_PENDING` and only the reconciler may end it;
 *   - after a create succeeded but before the submit — the execution is on the
 *     server under a key this store holds, and the reconciler reads it back;
 *   - after one leg was created but before its sibling was sent at all — the
 *     reconciler proves the sibling never left the process, and `resume` sends it
 *     for the first time, under the key already on disk.
 *
 * ## Multi-leg, as phases rather than as a queue
 *
 * The job state machine has one state per *phase*, not one per leg, and there is
 * no "next leg" edge. So all creates happen in `CREATING`, all signatures in
 * `AWAITING_SIGNATURE`, all submits in `SUBMITTING`. Legs stay independent
 * inside a phase (ADR-0001 §15): a leg the server definitively refuses is marked
 * FAILED and the pass carries on with its siblings, and one leg's refusal never
 * rolls back another leg's fill — there is nothing to roll back, because a
 * submitted order is on chain.
 *
 * The one thing that does stop the whole pass is *ambiguity*. A transport error
 * means the request may have left this process, and continuing to the next leg
 * would leave that open attempt unexamined while new orders are created beside
 * it. The job goes to `UNKNOWN_PENDING` with the attempt still open, which is
 * the state that says exactly that.
 *
 * ## What this module refuses to do
 *
 * It does not decide outcomes. No fill, failure, cancellation or expiry of an
 * order is ever inferred here from a status code, a timeout or a clock — the
 * driver hands off to `reconcileJob`, which reads the server. The only terminal
 * states this module writes itself are the ones no order was involved in: a
 * cancel the owner asked for, the job's own `expiresAt`, and a refusal that
 * happened before anything was reserved.
 */
import {
  isPredictAgentApiError,
  targetReached,
  type CreateExecutionResponseBody,
  type PredictQuote,
} from '@waterx/predict-agent-sdk';

import { JobStoreError } from '../errors.ts';
import { fingerprintRequest, newAttemptId, newIdempotencyKey } from '../ids.ts';
import type { JobLease, JobLegIntent, JobRecord } from '../job.ts';
import { reconcileJob } from '../reconciler.ts';
import { isSignerError } from '../signer.ts';
import {
  canEndLocally,
  canTransition,
  isTerminalJobState,
  type JobState,
} from '../state-machine.ts';
import type { JobStore } from '../store.ts';
import {
  buildCreateRequest,
  quoteRequestFor,
  type PriceObserver,
  type StrategyGateway,
  type StrategySigner,
  type WatchKey,
} from './gateway.ts';
import {
  checkLocalPolicy,
  checkMarkets,
  preflight,
  type LegSkip,
  type PreparedLeg,
} from './preflight.ts';

export interface DriveJobOptions {
  readonly store: JobStore;
  readonly gateway: StrategyGateway;
  /** Inside the Runner trust boundary. Nothing else in a pass sees key material. */
  readonly signer: StrategySigner;
  readonly prices: PriceObserver;
  /** Held by this instance, and asserted by every write below. */
  readonly lease: JobLease;
  readonly at: string;
  /**
   * The lease signal. A Runner fenced out mid-pass must stop acting for a job
   * another instance now owns; the store would refuse its writes in any case.
   */
  readonly signal?: AbortSignal;
}

/** What a pass did. One value, chosen so a log line reads as a sentence. */
export type DriveAction =
  /** The job had already ended. Nothing was read and nothing was written. */
  | 'ALREADY_TERMINAL'
  /** A draft became a live watcher. */
  | 'ARMED'
  /** Watched, and the market has not offered what the job is waiting for. */
  | 'WAITING'
  /** The market cannot be traded right now. The job keeps its original expiry. */
  | 'PAUSED'
  /** A paused job's market is quotable again. */
  | 'RESUMED'
  /** The target was observed and the job is now acting on it. */
  | 'TRIGGERED'
  /** Acted, then went back to watching: nothing was sent. */
  | 'REARMED'
  /** At least one order was created and submitted in this pass. */
  | 'EXECUTED'
  /** A reconcile pass ran against the server. Nothing terminal was established. */
  | 'RECONCILED'
  /** The job reached a terminal state. */
  | 'ENDED'
  /** A request may have left this process and nothing observed the answer. */
  | 'UNKNOWN_PENDING'
  /** The job is in a state only recovery or the reconciler may move. */
  | 'NOT_DRIVABLE';

/** One leg's fate in this pass, for the caller's log. Never a fill claim. */
export interface DriveLegReport {
  readonly legIndex: number;
  readonly attempted: boolean;
  readonly executionId?: string;
  readonly skip?: LegSkip;
  /** A server refusal this pass observed, by code. Legs stay independent. */
  readonly refusedCode?: string;
  /**
   * A local refusal by the signer, by code — kept apart from `refusedCode`
   * because the execution exists on the server either way, and confusing "the
   * server would not take this order" with "this Runner would not authorize it"
   * sends an operator to the wrong system.
   */
  readonly signRefusedCode?: string;
}

export interface DriveResult {
  readonly jobId: string;
  readonly from: JobState;
  readonly to: JobState;
  readonly action: DriveAction;
  readonly reason: string;
  readonly legs?: readonly DriveLegReport[];
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Advance one job by one pass.
 *
 * Safe to call on any job in any state: a job that is terminal, or in a state
 * only recovery may move, answers rather than throwing. What it does throw on is
 * a lost lease or an illegal transition — those are bugs or fencing, and
 * swallowing either would let two Runners believe they own one order.
 */
export const driveJob = async (options: DriveJobOptions): Promise<DriveResult> => {
  const { store, lease } = options;
  const job = await store.getJob(lease.jobId);
  if (job === undefined) {
    throw new JobStoreError('UNKNOWN_JOB', `unknown job ${lease.jobId}`, { jobId: lease.jobId });
  }

  if (isTerminalJobState(job.state)) {
    return say(job, job.state, 'ALREADY_TERMINAL', `JOB_${job.state}`);
  }

  // Not knowing has exactly one exit, and it is not this module's to take. The
  // job is handed along so that the one answer a reconcile can give which needs
  // an order placed — a leg it proved was never sent — has somewhere to go.
  if (job.state === 'UNKNOWN_PENDING' || job.state === 'RECONCILING') {
    return await reconcilePass(options, job.state, job);
  }

  if (canEndLocally(job.state)) {
    const ended = await endLocally(options, job);
    if (ended !== undefined) return ended;
    // Before any read: a job whose policy cannot authorize an unattended write is
    // not a job to keep watching.
    const refused = await refuseLocally(options, job);
    if (refused !== undefined) return refused;
  }

  switch (job.state) {
    case 'DRAFT': {
      await options.store.transition({
        lease,
        to: 'WATCHING',
        reason: 'ARMED',
        at: options.at,
        detail: { expiresAt: job.expiresAt, trigger: job.trigger.kind },
      });
      return say(job, 'WATCHING', 'ARMED', 'ARMED');
    }
    case 'WATCHING':
    case 'PAUSED':
      return await watchPass(options, job);
    case 'TRIGGERED':
      return await actPass(options, job);
    default:
      // CREATING through SUBMITTED. A pass never leaves a job in one of these —
      // reaching here means a crash did, and recovery owns that decision.
      return say(job, job.state, 'NOT_DRIVABLE', 'AWAITING_RECOVERY');
  }
};

/* ── Local endings ─────────────────────────────────────────────────────────── */

/**
 * The two endings that need no server: the owner asked, or the clock passed.
 *
 * Only ever reached from a state where nothing is in flight — `canEndLocally` is
 * derived from `inFlight` precisely so this cannot be extended to a state where
 * an order might exist. A cancel outranks an expiry when both are true: it names
 * a person who acted.
 */
const endLocally = async (
  options: DriveJobOptions,
  job: JobRecord,
): Promise<DriveResult | undefined> => {
  const { store, lease, at } = options;

  if (job.cancelRequestedAt !== null) {
    await store.transition({
      lease,
      to: 'CANCELLED',
      reason: 'CANCEL_REQUESTED',
      at,
      detail: {
        requestedAt: job.cancelRequestedAt,
        ...(job.cancelReason === null ? {} : { cancelReason: job.cancelReason }),
      },
    });
    return say(job, 'CANCELLED', 'ENDED', 'CANCEL_REQUESTED');
  }

  if (Date.parse(job.expiresAt) <= Date.parse(at)) {
    // ADR-0005: the expiry is the job's own, never extended and never inherited
    // from a market that reopened. A running Runner ends the job here rather than
    // leaving it for whatever restarts next.
    await store.transition({
      lease,
      to: 'EXPIRED',
      reason: 'EXPIRY_REACHED',
      at,
      detail: { expiresAt: job.expiresAt },
    });
    return say(job, 'EXPIRED', 'ENDED', 'EXPIRY_REACHED');
  }

  return undefined;
};

/**
 * The third local decision, and the one that is about authority rather than time:
 * may this Runner sign for this job at all, without a person present?
 *
 * `checkLocalPolicy` is the same function `preflight` opens with, and the same
 * rule `createExternalCommandSigner` applies before it will spawn anything. It is
 * asked here, on every pass, because the alternative is a job that reads a market
 * every few seconds for hours in order to reach a signature it was never going to
 * be allowed to produce. Nothing here talks to the server.
 *
 * A refusal is an ending; an unrecognized mode is a pause, per ADR-0004 — the
 * build that understands it may be the next one to start, and an ended job cannot
 * be brought back by installing it.
 */
const refuseLocally = async (
  options: DriveJobOptions,
  job: JobRecord,
): Promise<DriveResult | undefined> => {
  const verdict = checkLocalPolicy(job, options.at);
  if (verdict === undefined) return undefined;
  if (verdict.kind === 'STOP') return await stop(options, job, verdict.reason, verdict.detail);
  if (verdict.kind === 'PAUSE') return await pause(options, job, verdict.reason, verdict.detail);
  return undefined;
};

/**
 * Paused, without writing the same fact twice.
 *
 * A job already paused for one reason and still paused for it gets a report, not
 * a transition: a log that records an unchanging fact once a second is a log
 * nobody can read the interesting lines of. And a state that cannot legally pause
 * yet — `DRAFT`, which has not been armed — simply stays put and is asked again
 * on the next pass.
 */
const pause = async (
  options: DriveJobOptions,
  job: JobRecord,
  reason: string,
  detail: Readonly<Record<string, unknown>>,
): Promise<DriveResult> => {
  if (job.state === 'PAUSED') return say(job, 'PAUSED', 'WAITING', reason, { detail });
  if (!canTransition(job.state, 'PAUSED')) {
    return say(job, job.state, 'WAITING', reason, { detail });
  }
  await options.store.transition({
    lease: options.lease,
    to: 'PAUSED',
    reason,
    at: options.at,
    detail,
  });
  return say(job, 'PAUSED', 'PAUSED', reason, { detail });
};

/* ── Watching ──────────────────────────────────────────────────────────────── */

/**
 * A watch pass: is the market still runnable, and has the target been observed?
 *
 * The market is re-read on every watch pass, not only at the trigger, because
 * that is the only way a job that halts at 3am is reported as paused rather than
 * as quietly watching a book that is not there. It costs one read per market per
 * pass, and the caller's cadence sets the bill.
 */
const watchPass = async (options: DriveJobOptions, job: JobRecord): Promise<DriveResult> => {
  const { store, lease, at } = options;

  const markets = await checkMarkets({
    job,
    gateway: options.gateway,
    at,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (markets?.kind === 'STOP') return await stop(options, job, markets.reason, markets.detail);

  if (markets?.kind === 'PAUSE') return await pause(options, job, markets.reason, markets.detail);

  if (job.state === 'PAUSED') {
    // ADR-0004: resuming means going back to WATCHING, never skipping ahead to
    // the act. The target is observed again below, on this pass, from scratch.
    await store.transition({ lease, to: 'WATCHING', reason: 'MARKET_RUNNABLE', at });
  }
  const resumed = job.state === 'PAUSED';

  const observation = await observe(options, job);
  if (observation.kind !== 'REACHED') {
    return say(
      job,
      'WATCHING',
      resumed ? 'RESUMED' : observation.kind === 'UNDRIVABLE' ? 'NOT_DRIVABLE' : 'WAITING',
      observation.reason,
      { detail: observation.detail },
    );
  }

  await store.transition({
    lease,
    to: 'TRIGGERED',
    reason: observation.reason,
    at,
    detail: observation.detail,
  });
  // Same pass: the observed price is indicative and decays, so the executable
  // quote it will be re-verified against is minted immediately, not next tick.
  const acted = await actPass(options, { ...job, state: 'TRIGGERED' });
  return { ...acted, from: job.state };
};

type Observation =
  | { readonly kind: 'REACHED'; readonly reason: string; readonly detail: Record<string, unknown> }
  | { readonly kind: 'WAITING'; readonly reason: string; readonly detail: Record<string, unknown> }
  | {
      readonly kind: 'UNDRIVABLE';
      readonly reason: string;
      readonly detail: Record<string, unknown>;
    };

/** The watched market/outcome/side, or nothing when the trigger names it in part. */
export const watchKeyOf = (job: JobRecord): WatchKey | undefined => {
  const { marketId, outcomeId, side } = job.trigger;
  if (marketId === undefined || outcomeId === undefined || side === undefined) return undefined;
  return { marketId, outcomeId, side };
};

const observe = async (options: DriveJobOptions, job: JobRecord): Promise<Observation> => {
  if (job.trigger.kind === 'IMMEDIATE') {
    return { kind: 'REACHED', reason: 'IMMEDIATE', detail: {} };
  }

  const watch = watchKeyOf(job);
  const target = job.trigger.targetPrice;
  if (watch === undefined || target === undefined) {
    // Normalization refuses this shape, so a record carrying it was written
    // around that layer. Guessing which market to watch is exactly the
    // hallucinated identity ADR-0004 forbids, so the job is left alone.
    return {
      kind: 'UNDRIVABLE',
      reason: 'TRIGGER_INCOMPLETE',
      detail: { trigger: job.trigger },
    };
  }

  const observed = await options.prices.observe(watch, options.signal);
  if (observed === null) {
    // A quiet feed is not a market that moved away. Nothing is concluded.
    return { kind: 'WAITING', reason: 'NO_PRICE_OBSERVED', detail: { watch } };
  }

  const detail = {
    observed,
    target,
    side: watch.side,
    ...(job.trigger.observe === undefined ? {} : { book: job.trigger.observe }),
  };
  return targetReached(watch.side, observed, target)
    ? { kind: 'REACHED', reason: 'TARGET_OBSERVED', detail }
    : { kind: 'WAITING', reason: 'TARGET_NOT_MET', detail };
};

/* ── Acting ────────────────────────────────────────────────────────────────── */

interface QuotedLeg {
  readonly legIndex: number;
  readonly intent: JobLegIntent;
  readonly quote: PredictQuote;
}

/**
 * The act pass: everything between an observed target and a submitted order.
 *
 * Order matters and is fixed — authorization, market, position, then price —
 * because each check is more expensive than the one before it and a job whose
 * mandate was revoked should not page an account's positions to find that out.
 */
const actPass = async (options: DriveJobOptions, job: JobRecord): Promise<DriveResult> => {
  const { store, lease, at } = options;

  const verdict = await preflight({
    job,
    gateway: options.gateway,
    at,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (verdict.kind === 'STOP') return await stop(options, job, verdict.reason, verdict.detail);
  if (verdict.kind === 'PAUSE') {
    await store.transition({
      lease,
      to: 'PAUSED',
      reason: verdict.reason,
      at,
      detail: verdict.detail,
    });
    return say(job, 'PAUSED', 'PAUSED', verdict.reason, { detail: verdict.detail });
  }

  const attemptable = verdict.legs.filter((leg) => leg.skip === undefined);
  if (attemptable.length === 0) return await noneLeft(options, job, verdict.legs);

  await store.transition({
    lease,
    to: 'QUOTING',
    reason: 'PREFLIGHT_PASSED',
    at,
    detail: { legs: attemptable.map((leg) => leg.legIndex) },
  });

  // A fresh, executable quote per leg — never the indicative price the trigger
  // was observed on, and re-verified against the target before it is acted on.
  const quoted: QuotedLeg[] = [];
  const skipped: PreparedLeg[] = verdict.legs.filter((leg) => leg.skip !== undefined);
  for (const leg of attemptable) {
    const quote = await options.gateway.getQuote(
      quoteRequestFor(leg.intent, leg.legIndex),
      options.signal,
    );
    const refusal = verifyQuote(job, leg.intent, quote, at);
    if (refusal !== undefined) {
      skipped.push({ ...leg, skip: refusal });
      continue;
    }
    quoted.push({ legIndex: leg.legIndex, intent: leg.intent, quote });
  }

  if (quoted.length === 0) return await noneLeft(options, { ...job, state: 'QUOTING' }, skipped);

  return await execute(options, job, quoted, skipped);
};

/**
 * The fresh quote, checked against everything the job may refuse it for.
 *
 * `maxSlippageBps` is NOT checked here: it goes on the create request, and the
 * server returns the `enforcedWorstPrice` the chain will actually apply. Checking
 * a local approximation of it as well would produce a second opinion that
 * disagrees with the one enforced, and the disagreement would be silent.
 */
export const verifyQuote = (
  job: JobRecord,
  intent: JobLegIntent,
  quote: PredictQuote,
  at: string,
): LegSkip | undefined => {
  if (Date.parse(quote.expiresAt) <= Date.parse(at)) {
    // A quote past its own expiry is gone; the contract says re-quote rather than
    // retry, and the next pass does exactly that.
    return {
      reason: 'QUOTE_EXPIRED',
      retryable: true,
      detail: { quoteId: quote.quoteId, expiresAt: quote.expiresAt, at },
    };
  }

  const bound = intent.worstAcceptablePrice;
  if (bound !== undefined && !targetReached(intent.side, quote.expectedPrice, bound)) {
    return {
      reason: 'PRICE_WORSE_THAN_BOUND',
      retryable: true,
      detail: { expectedPrice: quote.expectedPrice, worstAcceptablePrice: bound, side: intent.side },
    };
  }

  // Re-verify the trigger's own target, and only for the leg that trades the
  // market the target was about. A leg on a different market was never priced
  // against this number, and holding it to one would refuse an order the owner
  // described.
  const watch = watchKeyOf(job);
  const target = job.trigger.targetPrice;
  if (
    job.trigger.kind === 'PRICE' &&
    target !== undefined &&
    watch !== undefined &&
    watch.marketId === intent.marketId &&
    watch.outcomeId === intent.outcomeId &&
    watch.side === intent.side &&
    !targetReached(intent.side, quote.expectedPrice, target)
  ) {
    return {
      reason: 'TARGET_NO_LONGER_MET',
      retryable: true,
      detail: { expectedPrice: quote.expectedPrice, targetPrice: target, side: intent.side },
    };
  }

  return undefined;
};

/**
 * Nothing can be attempted this pass. Wait, or end.
 *
 * Nothing has been reserved at this point, which is what makes both answers
 * cheap: a re-armed job has no leg rows to reconcile and no key that was minted
 * for an order that never happened. The distinction is whether ANY skip could
 * come back — a price that moved will, a position that is gone will not, and a
 * job whose every leg is permanently unqualified would otherwise sit watching a
 * price it has already decided it will refuse.
 */
const noneLeft = async (
  options: DriveJobOptions,
  job: JobRecord,
  legs: readonly PreparedLeg[],
): Promise<DriveResult> => {
  const reports = legs.map(toReport);
  const detail = { legs: reports };

  if (legs.some((leg) => leg.skip?.retryable === true)) {
    await options.store.transition({
      lease: options.lease,
      to: 'WATCHING',
      reason: 'NO_LEG_QUALIFIED',
      at: options.at,
      detail,
    });
    return say(job, 'WATCHING', 'REARMED', 'NO_LEG_QUALIFIED', { legs: reports, detail });
  }

  await options.store.transition({
    lease: options.lease,
    to: 'FAILED',
    reason: 'NO_LEG_CAN_QUALIFY',
    at: options.at,
    detail,
  });
  return say(job, 'FAILED', 'ENDED', 'NO_LEG_CAN_QUALIFY', { legs: reports, detail });
};

/* ── Writing ───────────────────────────────────────────────────────────────── */

interface LiveLeg extends QuotedLeg {
  readonly created: CreateExecutionResponseBody;
}

interface SignedLeg extends LiveLeg {
  readonly signature: string;
}

/**
 * Reserve, create, sign, submit — the part that can move money.
 *
 * The reservation is deliberately the last thing before the first write. Every
 * refusal above it happens with nothing on disk, so a job that decided not to
 * act leaves no leg, no key and no attempt behind; and every write below it
 * happens with the key already persisted, which is what makes a replay after a
 * crash the SAME logical order rather than a second one.
 */
const execute = async (
  options: DriveJobOptions,
  job: JobRecord,
  quoted: readonly QuotedLeg[],
  skipped: readonly PreparedLeg[],
): Promise<DriveResult> => {
  const { store, lease, at } = options;
  const from = job.state;

  // A re-armed job may already hold rows from a pass that crashed between the
  // reservation and the first request. The persisted key is reused verbatim:
  // minting a second one for the same leg index is how one intent becomes two
  // orders, and the store refuses it anyway.
  const existing = await store.listLegs(job.jobId);
  const keyFor = (legIndex: number): string =>
    existing.find((leg) => leg.legIndex === legIndex)?.idempotencyKey ?? newIdempotencyKey();

  for (const leg of [...quoted, ...skipped].sort((a, b) => a.legIndex - b.legIndex)) {
    await store.reserveLeg({
      lease,
      legIndex: leg.legIndex,
      idempotencyKey: keyFor(leg.legIndex),
      intent: leg.intent,
      at,
    });
  }
  for (const leg of skipped) {
    // Recorded as SKIPPED now, not left PENDING: the run is happening, this leg
    // is not in it, and a leg the reconciler would keep looking for is a job that
    // never concludes. A retryable skip is only retryable while the job is still
    // watching — once its siblings trade, this run is the one it missed.
    await store.updateLeg({
      lease,
      legIndex: leg.legIndex,
      at,
      status: 'SKIPPED',
    });
  }

  const legKeys = new Map(
    (await store.listLegs(job.jobId)).map((leg) => [leg.legIndex, leg.idempotencyKey]),
  );
  /**
   * The key as the STORE holds it, re-read after the reservation rather than
   * remembered from before it. A create sent under a key the store does not have
   * is a request nothing could ever replay, so the absence is a refusal.
   */
  const keyOf = (legIndex: number): string => {
    const key = legKeys.get(legIndex);
    if (key === undefined) {
      throw new JobStoreError(
        'NO_IDEMPOTENCY_KEY',
        `leg ${String(legIndex)} of job ${job.jobId} has no persisted idempotency key`,
        { legIndex },
      );
    }
    return key;
  };

  await store.transition({
    lease,
    to: 'CREATING',
    reason: 'LEGS_RESERVED',
    at,
    detail: {
      creating: quoted.map((leg) => leg.legIndex),
      ...(skipped.length === 0 ? {} : { skipped: skipped.map(toReport) }),
    },
  });

  const reports = new Map<number, DriveLegReport>(
    skipped.map((leg) => [leg.legIndex, toReport(leg)]),
  );
  const live: LiveLeg[] = [];

  for (const leg of quoted) {
    const body = buildCreateRequest(job, leg.intent, leg.legIndex, leg.quote.quoteId);
    const attempt = await store.beginSideEffect({
      lease,
      attemptId: newAttemptId(),
      legIndex: leg.legIndex,
      kind: 'CREATE_EXECUTION',
      requestFingerprint: fingerprintRequest(body),
      at,
    });

    let created: CreateExecutionResponseBody;
    try {
      created = await options.gateway.createExecution(body, {
        idempotencyKey: keyOf(leg.legIndex),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (!isDefinitive(error)) {
        return await unknown(options, job, from, 'CREATE_UNRESOLVED', {
          legIndex: leg.legIndex,
          attemptId: attempt.attemptId,
        });
      }
      await store.completeSideEffect({
        lease,
        attemptId: attempt.attemptId,
        outcome: 'FAILED',
        at,
        detail: refusalDetail(error),
        leg: { status: 'FAILED' },
      });
      reports.set(leg.legIndex, {
        legIndex: leg.legIndex,
        attempted: true,
        refusedCode: refusalDetail(error).code,
      });
      continue;
    }

    // One transaction: the attempt closes and the execution id lands together.
    // Two would let a crash between them turn a real order into "nothing was
    // sent", and the next pass would create a second one.
    await store.completeSideEffect({
      lease,
      attemptId: attempt.attemptId,
      outcome: 'SUCCEEDED',
      at,
      detail: {
        executionId: created.executionId,
        status: created.status,
        enforcedWorstPrice: created.enforcedWorstPrice,
        signatureExpiresAt: created.signatureExpiresAt,
      },
      leg: {
        executionId: created.executionId,
        referenceQuoteId: created.referenceQuoteId,
        submissionQuoteId: created.submissionQuoteId,
        quotedAt: leg.quote.asOf,
      },
    });
    reports.set(leg.legIndex, {
      legIndex: leg.legIndex,
      attempted: true,
      executionId: created.executionId,
    });
    live.push({ ...leg, created });
  }

  if (live.length === 0) {
    // Every attempted leg was refused by the server, definitively. The job is
    // not declared failed here: the reconciler owns the summary, and it reaches
    // the same place from the leg rows this pass wrote.
    await store.transition({ lease, to: 'RECONCILING', reason: 'ALL_CREATES_REFUSED', at });
    const result = await reconcilePass(options, 'RECONCILING');
    return { ...result, from, legs: sorted(reports), reason: 'ALL_CREATES_REFUSED' };
  }

  await store.transition({
    lease,
    to: 'AWAITING_SIGNATURE',
    reason: 'EXECUTIONS_CREATED',
    at,
    detail: { legs: live.map((leg) => ({ legIndex: leg.legIndex, executionId: leg.created.executionId })) },
  });

  const signed: SignedLeg[] = [];
  /**
   * Every leg that was created and not signed, with the signer's own code.
   *
   * The code, not the message: a refusal an operator has to diagnose from a leg
   * index alone is indistinguishable between "your keystore is down" and "this
   * job may never sign, and never could have" — and the second one is a policy
   * decision they need to see. A signer's error carries no bytes and no
   * signature, so the code is safe to persist; nothing else about the attempt is.
   */
  const unsigned: { legIndex: number; code: string }[] = [];
  for (const leg of live) {
    try {
      // The bytes and the job's authority go in and a signature comes out.
      // Neither the bytes nor the signature is persisted, logged, or put in a
      // result — ADR-0001 §7. The policy travels with the request because the
      // signer, not this loop, is the thing that must refuse an authority that
      // does not permit unattended signing; passing it is not a courtesy.
      const signature = await options.signer.sign(
        {
          jobId: job.jobId,
          legIndex: leg.legIndex,
          agentWallet: job.agentWallet,
          policy: job.policy,
          sponsoredTransactionBytes: leg.created.sponsoredTransactionBytes,
        },
        options.signal,
      );
      signed.push({ ...leg, signature });
    } catch (error) {
      // An unsigned execution cannot fill, and it is not this module's place to
      // call it failed: the server holds it until `signatureExpiresAt`, and the
      // reconciler will read whatever it becomes. That is true of a refusal as
      // much as of a failure — a policy that forbids signing does not un-create
      // the execution the create already made.
      const code = isSignerError(error) ? error.code : 'SIGNER_ERROR';
      unsigned.push({ legIndex: leg.legIndex, code });
      const report = reports.get(leg.legIndex);
      if (report !== undefined) reports.set(leg.legIndex, { ...report, signRefusedCode: code });
    }
  }

  if (signed.length === 0) {
    await store.transition({
      lease,
      to: 'RECONCILING',
      reason: 'NOTHING_SIGNED',
      at,
      detail: { unsigned },
    });
    const result = await reconcilePass(options, 'RECONCILING');
    return { ...result, from, legs: sorted(reports), reason: 'NOTHING_SIGNED' };
  }

  await store.transition({
    lease,
    to: 'SUBMITTING',
    reason: 'SIGNED',
    at,
    detail: {
      legs: signed.map((leg) => leg.legIndex),
      ...(unsigned.length === 0 ? {} : { unsigned }),
    },
  });

  for (const leg of signed) {
    const attempt = await store.beginSideEffect({
      lease,
      attemptId: newAttemptId(),
      legIndex: leg.legIndex,
      kind: 'SUBMIT_EXECUTION',
      // Over the execution id, NOT the signature. A signature is key-derived
      // output that must never reach the store in any form, and a signer is not
      // required to be deterministic — fingerprinting one would make a legitimate
      // replay look like different bytes.
      requestFingerprint: fingerprintRequest({ submit: leg.created.executionId }),
      at,
    });

    try {
      const submitted = await options.gateway.submitExecution(
        leg.created.executionId,
        leg.signature,
        options.signal,
      );
      await store.completeSideEffect({
        lease,
        attemptId: attempt.attemptId,
        outcome: 'SUCCEEDED',
        at,
        detail: { executionId: submitted.executionId, status: submitted.status },
        // No leg status: the order exists, and whether it FILLED is a fact only
        // the reconciler may write, from a read of the server.
        leg:
          submitted.transactionDigest === undefined
            ? {}
            : { submissionDigest: submitted.transactionDigest },
      });
    } catch (error) {
      if (!isDefinitive(error)) {
        return await unknown(options, job, from, 'SUBMIT_UNRESOLVED', {
          legIndex: leg.legIndex,
          attemptId: attempt.attemptId,
          executionId: leg.created.executionId,
        });
      }
      await store.completeSideEffect({
        lease,
        attemptId: attempt.attemptId,
        outcome: 'FAILED',
        at,
        detail: refusalDetail(error),
        leg: { status: 'FAILED' },
      });
      reports.set(leg.legIndex, {
        legIndex: leg.legIndex,
        attempted: true,
        executionId: leg.created.executionId,
        refusedCode: refusalDetail(error).code,
      });
    }
  }

  await store.transition({ lease, to: 'SUBMITTED', reason: 'SUBMITTED', at });
  await store.transition({ lease, to: 'RECONCILING', reason: 'RECONCILE_STARTED', at });
  const reconciled = await reconcilePass(options, 'RECONCILING');

  return {
    jobId: job.jobId,
    from,
    to: reconciled.to,
    // ENDED only when the reconciler read a terminal fact from the server on this
    // very pass. Otherwise EXECUTED, which claims orders were submitted and
    // nothing about whether they filled.
    action: reconciled.action === 'ENDED' ? 'ENDED' : 'EXECUTED',
    reason: 'SUBMITTED',
    legs: sorted(reports),
    detail: { reconcile: reconciled.reason, ...(unsigned.length === 0 ? {} : { unsigned }) },
  };
};

/* ── Endings and ambiguity ─────────────────────────────────────────────────── */

/**
 * A refusal that happened before anything was sent, recorded as FAILED.
 *
 * FAILED rather than CANCELLED or EXPIRED, and the reason carries which refusal
 * it was. The other two terminal states are claims about *who* stopped the job —
 * the owner, or the job's own clock — and a market that resolved is neither.
 */
const stop = async (
  options: DriveJobOptions,
  job: JobRecord,
  reason: string,
  detail: Readonly<Record<string, unknown>>,
): Promise<DriveResult> => {
  await options.store.transition({
    lease: options.lease,
    to: 'FAILED',
    reason,
    at: options.at,
    detail,
  });
  return say(job, 'FAILED', 'ENDED', reason, { detail });
};

/**
 * A request that may have left this process, recorded as such.
 *
 * The attempt row stays OPEN. It is the only evidence that something may exist
 * on the server, and closing it to make the state tidy would erase the reason
 * the reconciler knows to look.
 */
const unknown = async (
  options: DriveJobOptions,
  job: JobRecord,
  from: JobState,
  reason: string,
  detail: Readonly<Record<string, unknown>>,
): Promise<DriveResult> => {
  await options.store.transition({
    lease: options.lease,
    to: 'UNKNOWN_PENDING',
    reason,
    at: options.at,
    detail,
  });
  return { jobId: job.jobId, from, to: 'UNKNOWN_PENDING', action: 'UNKNOWN_PENDING', reason, detail };
};

/* ── Resuming a run a crash cut in half ────────────────────────────────────── */

/**
 * The only way back into `CREATING`, and the narrowest one that finishes a run.
 *
 * Reached only when `reconcileJob` proved, from the ledger, that a leg was never
 * sent while a sibling's order was — so this is not a retry of anything. It is
 * the rest of a run, sent for the first time, under the key that was minted for
 * it before the crash.
 *
 * Three properties hold it together:
 *
 * 1. **The persisted intent, not a fresh one.** The key on disk was minted for
 *    the intent on disk. A resolved dynamic fraction is re-read here to see
 *    whether the position still qualifies the leg at all, but the size that is
 *    actually sent is the one the key belongs to — sending a different order
 *    under it would be a second logical order wearing the first one's key.
 * 2. **Fresh checks all the same.** Authorization, market lifecycle, position and
 *    an executable quote are re-read exactly as they are at a trigger. A crash is
 *    not permission to skip the checks; if anything, more time has passed.
 * 3. **The job cannot be ended here.** An order exists on the server, so a
 *    refusal skips the *legs* and leaves the terminal verdict to the reconciler,
 *    which reads it. That is the difference between "this leg missed the run" and
 *    a stop that did not happen (ADR-0001 §15).
 */
const resume = async (options: DriveJobOptions, job: JobRecord): Promise<DriveResult> => {
  const { store, lease, at } = options;
  // The state is RECONCILING by the time a REPLAYABLE answer exists; naming it
  // keeps every transition below legal for the state the store actually holds.
  const inFlight: JobRecord = { ...job, state: 'RECONCILING' };

  const legs = await store.listLegs(job.jobId);
  const attempted = new Set(
    (await store.listSideEffects(job.jobId)).map((attempt) => attempt.legIndex),
  );
  const unsent = legs.filter(
    (leg) => leg.status === 'PENDING' && leg.executionId === null && !attempted.has(leg.legIndex),
  );
  if (unsent.length === 0) {
    // Nothing to resume after all. Not an error: the reconcile that said so read
    // the store a moment earlier, and the honest answer is to reconcile again.
    return await reconcilePass(options, 'RECONCILING');
  }
  const intents = new Map(unsent.map((leg) => [leg.legIndex, leg.intent]));
  const missed = (skip: LegSkip): readonly PreparedLeg[] =>
    unsent.map((leg) => ({ legIndex: leg.legIndex, intent: leg.intent, skip }));

  if (Date.parse(job.expiresAt) <= Date.parse(at)) {
    // ADR-0005: never extended, not even to finish a run the job started. Nothing
    // was sent for these legs, so saying they were not is a fact, not a stop.
    return await concludeResume(
      options,
      inFlight,
      missed({
        reason: 'EXPIRED_BEFORE_SENT',
        retryable: false,
        detail: { expiresAt: job.expiresAt, at },
      }),
    );
  }

  const verdict = await preflight({
    job: inFlight,
    gateway: options.gateway,
    at,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (verdict.kind === 'PAUSE') {
    // No transition: PAUSED is a state a job with an order on the server may not
    // enter, and the job is already in the one that describes it. The next pass
    // asks again, and the expiry above is what bounds the asking.
    return say(inFlight, 'RECONCILING', 'RECONCILED', `RESUME_${verdict.reason}`, {
      detail: verdict.detail,
    });
  }
  if (verdict.kind === 'STOP') {
    return await concludeResume(
      options,
      inFlight,
      missed({
        reason: 'REFUSED_ON_RESUME',
        retryable: false,
        detail: { refusal: verdict.reason, ...verdict.detail },
      }),
    );
  }

  const skipped: PreparedLeg[] = [];
  const quoted: QuotedLeg[] = [];
  for (const prepared of verdict.legs) {
    const intent = intents.get(prepared.legIndex);
    if (intent === undefined) continue; // Already resolved; not this pass's business.
    if (prepared.skip !== undefined) {
      skipped.push({ ...prepared, intent });
      continue;
    }
    const quote = await options.gateway.getQuote(
      quoteRequestFor(intent, prepared.legIndex),
      options.signal,
    );
    const refusal = verifyQuote(inFlight, intent, quote, at);
    if (refusal !== undefined) {
      skipped.push({ legIndex: prepared.legIndex, intent, skip: refusal });
      continue;
    }
    quoted.push({ legIndex: prepared.legIndex, intent, quote });
  }

  if (quoted.length === 0) return await concludeResume(options, inFlight, skipped);
  return await execute(options, inFlight, quoted, skipped);
};

/**
 * No leg of the resume can be sent. Record which, and let the reconciler decide
 * what the job as a whole became.
 *
 * The verdict is deliberately not written here. Some sibling filled or failed on
 * the server, and `concludeJob` derives the job's state from the leg rows — a
 * terminal state written from this side would be this process's opinion about an
 * order it never read.
 */
const concludeResume = async (
  options: DriveJobOptions,
  job: JobRecord,
  skipped: readonly PreparedLeg[],
): Promise<DriveResult> => {
  for (const leg of skipped) {
    await options.store.updateLeg({
      lease: options.lease,
      legIndex: leg.legIndex,
      at: options.at,
      status: 'SKIPPED',
    });
  }
  const result = await reconcilePass(options, 'RECONCILING');
  return {
    ...result,
    from: job.state,
    legs: skipped.map(toReport),
    detail: { ...result.detail, resume: 'NO_LEG_SENT' },
  };
};

/**
 * @param resumable - the job record, when this pass is allowed to act on a
 * `REPLAYABLE` answer. Omitted by the calls made from inside {@link execute}: a
 * pass that has just created orders must not turn round and create more, and a
 * leg it left unsent has an attempt row, so it cannot be replayable anyway. The
 * next pass will resume it if it is.
 */
const reconcilePass = async (
  options: DriveJobOptions,
  from: JobState,
  resumable?: JobRecord,
): Promise<DriveResult> => {
  const result = await reconcileJob({
    store: options.store,
    gateway: options.gateway,
    lease: options.lease,
    at: options.at,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (result.disposition === 'REPLAYABLE' && resumable !== undefined) {
    return await resume(options, resumable);
  }

  const action: DriveAction =
    result.disposition === 'TERMINAL'
      ? 'ENDED'
      : result.disposition === 'INCONCLUSIVE'
        ? 'UNKNOWN_PENDING'
        : result.disposition === 'REARMED'
          ? 'REARMED'
          : result.disposition === 'NOT_APPLICABLE'
            ? 'NOT_DRIVABLE'
            : 'RECONCILED';

  return {
    jobId: result.jobId,
    from,
    to: result.to,
    action,
    reason: result.reason,
    detail: {
      disposition: result.disposition,
      ...(result.legIndex === undefined ? {} : { legIndex: result.legIndex }),
      ...(result.executionId === undefined ? {} : { executionId: result.executionId }),
      ...(result.status === undefined ? {} : { status: result.status }),
    },
  };
};

/**
 * Whether the server answered.
 *
 * The whole ambiguity rule in one predicate: an API error means WaterX received
 * the request and decided, so the leg failed and its siblings carry on. Anything
 * else — a socket that died, an abort, a DNS failure — means nobody knows
 * whether the request landed, and the job must say so rather than assume.
 */
const isDefinitive = (error: unknown): boolean => isPredictAgentApiError(error);

/** The parts of a server refusal that are safe and useful to persist. */
const refusalDetail = (error: unknown): { code: string; httpStatus?: number; retryable?: boolean } =>
  isPredictAgentApiError(error)
    ? { code: error.code, httpStatus: error.httpStatus, retryable: error.retryable }
    : { code: 'UNKNOWN' };

/** Leg reports in leg order, so a caller reads them as the strategy was written. */
const sorted = (reports: ReadonlyMap<number, DriveLegReport>): readonly DriveLegReport[] =>
  [...reports.values()].sort((a, b) => a.legIndex - b.legIndex);

const toReport = (leg: PreparedLeg): DriveLegReport => ({
  legIndex: leg.legIndex,
  attempted: false,
  ...(leg.skip === undefined ? {} : { skip: leg.skip }),
});

const say = (
  job: JobRecord,
  to: JobState,
  action: DriveAction,
  reason: string,
  extra?: { legs?: readonly DriveLegReport[]; detail?: Readonly<Record<string, unknown>> },
): DriveResult => ({
  jobId: job.jobId,
  from: job.state,
  to,
  action,
  reason,
  ...(extra?.legs === undefined ? {} : { legs: extra.legs }),
  ...(extra?.detail === undefined ? {} : { detail: extra.detail }),
});
