/**
 * What happened to a strategy, in one ordered feed.
 *
 * A caller polling `get` sees a state and has to infer the story; the durable
 * record already contains it, in two tables that answer different questions. The
 * transition log says what the Runner decided. The side-effect ledger says what
 * left the process — and, crucially, what left without an answer. Merging them is
 * what makes "we asked, and we do not know" visible as an event rather than as a
 * gap between two states.
 *
 * Two properties this feed has to keep:
 *
 * - **Stable identity.** `eventId` is derived from the durable row, so an event a
 *   caller has already seen keeps the same id across restarts, page reads and
 *   reorderings. `sequence` is only a dense index into this answer; it renumbers
 *   as events arrive and must never be persisted as a cursor.
 * - **No invented facts.** An attempt with no outcome yields a BEGAN event and no
 *   resolution, because there is none. The absence is the information.
 */
import type { Iso8601 } from '@waterx/predict-agent-sdk';

import type { JobTransitionRecord, SideEffectAttempt, SideEffectKind, SideEffectOutcome } from '../job.ts';
import { isTerminalJobState, type JobState } from '../state-machine.ts';

export type StrategyEventKind = 'TRANSITION' | 'SIDE_EFFECT_BEGAN' | 'SIDE_EFFECT_RESOLVED';

interface StrategyEventBase {
  /** Durable and stable. Derived from the row, not from this feed's position. */
  readonly eventId: string;
  readonly jobId: string;
  readonly at: Iso8601;
  /** An index into THIS answer. Not a cursor; it renumbers as events arrive. */
  readonly sequence: number;
}

export interface StrategyTransitionEvent extends StrategyEventBase {
  readonly kind: 'TRANSITION';
  readonly fromState: JobState | null;
  readonly state: JobState;
  readonly reason: string;
  readonly instanceId: string | null;
  /** The job ended here. There will be no further events. */
  readonly terminal: boolean;
  readonly detail: Readonly<Record<string, unknown>> | null;
}

export interface StrategySideEffectEvent extends StrategyEventBase {
  readonly kind: 'SIDE_EFFECT_BEGAN' | 'SIDE_EFFECT_RESOLVED';
  readonly attemptId: string;
  readonly legIndex: number;
  readonly effect: SideEffectKind;
  /** Null on BEGAN, and on an attempt nothing ever came back from. */
  readonly outcome: SideEffectOutcome | null;
  /**
   * A request may have left this process and no reply was ever recorded. Only a
   * reconcile under the original idempotency key can settle it.
   */
  readonly unresolved: boolean;
  readonly detail: Readonly<Record<string, unknown>> | null;
}

export type StrategyEvent = StrategyTransitionEvent | StrategySideEffectEvent;

/** Same instant: the decision, then what it set in motion, then the answer. */
const KIND_ORDER: Record<StrategyEventKind, number> = {
  TRANSITION: 0,
  SIDE_EFFECT_BEGAN: 1,
  SIDE_EFFECT_RESOLVED: 2,
};

/**
 * Merges the two durable logs into a deterministic order.
 *
 * Time first, because that is the order things happened in; the rest of the key
 * exists so that two rows sharing a millisecond come back in the same order on
 * every read, from any process. A feed that shuffles under a tie would make a
 * caller diffing it see events it has already handled.
 */
export const buildStrategyEvents = (
  jobId: string,
  transitions: readonly JobTransitionRecord[],
  attempts: readonly SideEffectAttempt[],
): readonly StrategyEvent[] => {
  const unsequenced: (Omit<StrategyTransitionEvent, 'sequence'> | Omit<StrategySideEffectEvent, 'sequence'>)[] =
    [];

  // Belt and braces: both logs are read per job, so a foreign row here would be a
  // caller mixing two jobs into one story rather than a store that lost track.
  for (const transition of transitions.filter((row) => row.jobId === jobId)) {
    unsequenced.push({
      eventId: `${transition.jobId}:t:${String(transition.seq)}`,
      jobId: transition.jobId,
      kind: 'TRANSITION',
      at: transition.at,
      fromState: transition.fromState,
      state: transition.toState,
      reason: transition.reason,
      instanceId: transition.instanceId,
      terminal: isTerminalJobState(transition.toState),
      detail: transition.detail,
    });
  }

  for (const attempt of attempts.filter((row) => row.jobId === jobId)) {
    unsequenced.push({
      eventId: `${attempt.jobId}:s:${attempt.attemptId}:began`,
      jobId: attempt.jobId,
      kind: 'SIDE_EFFECT_BEGAN',
      at: attempt.startedAt,
      attemptId: attempt.attemptId,
      legIndex: attempt.legIndex,
      effect: attempt.kind,
      outcome: null,
      unresolved: attempt.outcome === null,
      detail: null,
    });
    if (attempt.outcome === null) continue;
    unsequenced.push({
      eventId: `${attempt.jobId}:s:${attempt.attemptId}:resolved`,
      jobId: attempt.jobId,
      kind: 'SIDE_EFFECT_RESOLVED',
      // `outcomeAt` accompanies an outcome; falling back to the start instant
      // keeps the ordering total rather than inventing a time.
      at: attempt.outcomeAt ?? attempt.startedAt,
      attemptId: attempt.attemptId,
      legIndex: attempt.legIndex,
      effect: attempt.kind,
      outcome: attempt.outcome,
      unresolved: false,
      detail: attempt.detail,
    });
  }

  return unsequenced
    .sort((left, right) => {
      const byTime = Date.parse(left.at) - Date.parse(right.at);
      if (byTime !== 0) return byTime;
      const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
      if (byKind !== 0) return byKind;
      return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
    })
    .map((event, index) => ({ ...event, sequence: index }) as StrategyEvent);
};
