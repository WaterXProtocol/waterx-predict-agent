/**
 * The state chart's invariants, asserted against the whole table rather than
 * against the handful of edges a feature happened to use.
 */
import {
  canEndLocally,
  canTransition,
  isTerminalJobState,
  JOB_STATES,
  JOB_TRANSITIONS,
  type JobState,
} from '../src/state-machine.ts';

const ALL_STATES = Object.keys(JOB_STATES) as JobState[];

describe('the job state machine', () => {
  it('walks the path the plan specifies', () => {
    const path: JobState[] = [
      'DRAFT',
      'WATCHING',
      'TRIGGERED',
      'QUOTING',
      'CREATING',
      'AWAITING_SIGNATURE',
      'SUBMITTING',
      'SUBMITTED',
      'RECONCILING',
      'FILLED',
    ];
    for (const [index, from] of path.entries()) {
      const to = path[index + 1];
      if (to === undefined) break;
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it('gives every state an entry in both tables', () => {
    for (const state of ALL_STATES) {
      expect(JOB_TRANSITIONS[state], state).toBeDefined();
    }
    for (const [state, targets] of Object.entries(JOB_TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL_STATES, `${state} -> ${target}`).toContain(target);
      }
    }
  });

  it('never lets a local decision end a job that may already have an order', () => {
    // The one that matters: a user cancel or a passing `expiresAt` cannot be
    // applied once CREATING has been entered, because the order may exist and
    // reporting a stop that did not happen is worse than reporting nothing
    // (ADR-0001 §15).
    for (const state of ALL_STATES) {
      if (!JOB_STATES[state].inFlight) continue;
      if (state === 'RECONCILING') continue; // terminal facts read from the server
      expect(canTransition(state, 'CANCELLED'), `${state} -> CANCELLED`).toBe(false);
      expect(canTransition(state, 'EXPIRED'), `${state} -> EXPIRED`).toBe(false);
      expect(canEndLocally(state), state).toBe(false);
    }
  });

  it('lets RECONCILING report a cancellation or expiry the server decided', () => {
    // Distinct fact from the case above: here the chain cancelled or expired the
    // order and the Runner read it back.
    expect(canTransition('RECONCILING', 'CANCELLED')).toBe(true);
    expect(canTransition('RECONCILING', 'EXPIRED')).toBe(true);
  });

  it('gives UNKNOWN_PENDING exactly one exit, and it is a read', () => {
    // Any other exit would let a job that lost confirmation mint a second intent
    // for one logical order.
    expect(JOB_TRANSITIONS.UNKNOWN_PENDING).toEqual(['RECONCILING']);
  });

  it('admits a terminal fill only where one could have been read', () => {
    const canFill = ALL_STATES.filter((state) => canTransition(state, 'FILLED'));
    expect(canFill).toEqual(['RECONCILING']);
  });

  it('makes every terminal state a sink', () => {
    for (const state of ALL_STATES) {
      if (!isTerminalJobState(state)) continue;
      expect(JOB_TRANSITIONS[state], state).toEqual([]);
    }
  });

  it('requires a persisted leg for every state that can write or has written', () => {
    for (const state of ALL_STATES) {
      const spec = JOB_STATES[state];
      if (spec.effect === 'WRITE' || spec.effect === 'SIGN') {
        expect(spec.requiresLeg, state).toBe(true);
        expect(spec.inFlight, state).toBe(true);
      }
    }
  });

  it('keeps every state reachable from DRAFT', () => {
    const seen = new Set<JobState>(['DRAFT']);
    const queue: JobState[] = ['DRAFT'];
    while (queue.length > 0) {
      const state = queue.shift() as JobState;
      for (const next of JOB_TRANSITIONS[state]) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    expect([...seen].sort()).toEqual([...ALL_STATES].sort());
  });
});
