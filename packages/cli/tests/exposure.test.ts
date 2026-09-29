/**
 * What the account is carrying — the notes that ride on every state (ADR-0023).
 *
 * The properties worth protecting are about restraint: a note costs no request,
 * changes no state, and never turns "not known" into a number. `null` in a
 * position's price means the market stopped quoting, and a portfolio value
 * totalled over one of those would be a guess wearing a currency sign.
 */
import { describe, expect, it } from 'vitest';

import { exposureNotes, KEEPER_MIN_FILL_USD, STALE_SUBMISSION_MS } from '../src/commands/exposure.ts';
import { decideNext, type NextFacts } from '../src/commands/next.ts';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const position = (over: Record<string, unknown> = {}) =>
  ({
    positionId: `0x${'e'.repeat(63)}1`,
    marketId: `0x${'f'.repeat(63)}1`,
    outcomeId: 'YES',
    strategyId: null,
    originalCost: '10.000000',
    remainingCost: '10.000000',
    shares: '13.500000',
    avgEntryPrice: '0.740000',
    currentPrice: '0.750000',
    unrealizedPnl: '0.125000',
    openedAt: ago(3_600_000),
    ...over,
  }) as never;

const execution = (over: Record<string, unknown> = {}) =>
  ({
    executionId: 'exec_direct_0000000001',
    status: 'SUBMITTED',
    side: 'BUY',
    marketId: `0x${'f'.repeat(63)}1`,
    outcomeId: 'YES',
    size: '25.000000',
    strategyId: null,
    clientOrderId: null,
    enforcedWorstPrice: null,
    transactionDigest: null,
    positionId: null,
    createdAt: ago(30_000),
    terminalAt: null,
    ...over,
  }) as never;

const kinds = (notes: readonly { kind: string }[]): string[] => notes.map((note) => note.kind);

describe('what the account is carrying', () => {
  it('says nothing when there is nothing to say', () => {
    expect(exposureNotes([], [], NOW)).toEqual([]);
  });

  it('reports cost deployed, which is known, and not a value, which is not', () => {
    const notes = exposureNotes([position(), position({ remainingCost: '5.500000' })], [], NOW);
    expect(kinds(notes)).toEqual(['DEPLOYED']);
    expect(notes[0]?.says).toContain('15.5');
    expect(notes[0]?.says).toContain('at cost');
  });

  it('refuses to price what has no price, and says the number is unknown rather than zero', () => {
    const notes = exposureNotes(
      [position(), position({ currentPrice: null, unrealizedPnl: null })],
      [],
      NOW,
    );
    expect(kinds(notes)).toEqual(['DEPLOYED', 'UNPRICED_POSITION']);
    expect(notes[1]?.says).toMatch(/unknown, not zero/u);
    // The total it does give is the one it can: cost, which does not need a quote.
    expect(notes[0]?.says).toContain('20');
    // How much of it is stranded, said separately from the portfolio's cost:
    // one position of the two here, so 10 rather than 20.
    expect(notes[1]?.says).toContain('10 wxUSD of cost');
    // And what a resolved one needs, which is not something this runtime does.
    expect(notes[1]?.says).toMatch(/claimed, which this runtime cannot do/u);
  });

  it('calls out an order the keeper will never fill, before its age', () => {
    // Measured on mainnet (order 38308): an open below the keeper's minimum is
    // cancelled with `below_min_fill`. It is not slow, it is finished.
    const notes = exposureNotes([], [execution({ size: '1.500000', createdAt: ago(30_000) })], NOW);
    expect(kinds(notes)).toEqual(['BELOW_KEEPER_MINIMUM']);
    expect(notes[0]?.says).toContain(String(KEEPER_MIN_FILL_USD));
    expect(notes[0]?.look).toContain('order reconcile --executionId exec_direct_0000000001');
  });

  it('says how long an order has been sitting once it is past the keeper’s grace', () => {
    const fresh = exposureNotes([], [execution({ createdAt: ago(STALE_SUBMISSION_MS - 1_000) })], NOW);
    expect(fresh).toEqual([]);
    const stale = exposureNotes([], [execution({ createdAt: ago(42 * 60_000) })], NOW);
    expect(kinds(stale)).toEqual(['UNSETTLED_TOO_LONG']);
    expect(stale[0]?.says).toContain('42 minutes');
    expect(stale[0]?.says).toMatch(/escrow is held/u);
  });

  it('every note points at something runnable as printed', () => {
    const notes = exposureNotes(
      [position({ currentPrice: null })],
      [execution({ createdAt: ago(60 * 60_000) })],
      NOW,
    );
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note.look, note.kind).toBeDefined();
      expect(note.look, note.kind).toMatch(/^waterx-predict /u);
      expect(note.look, note.kind).not.toContain('<');
    }
  });
});

describe('the notes as `next` carries them', () => {
  const READY_FACTS = (over: Partial<NextFacts> = {}): NextFacts =>
    ({
      requirements: [],
      writes: 'NEEDS_APPROVAL',
      session: { ok: true },
      now: NOW,
      onboarding: {
        status: 'READY',
        accounts: [],
        account: { accountId: `0x${'c'.repeat(63)}2`, ownerAddress: `0x${'a'.repeat(63)}9`, isSuspended: false },
        nextStep: { actor: 'AGENT', action: 'trade' },
      },
      account: { limits: null, unsettled: [], positions: [] },
      ...over,
    }) as unknown as NextFacts;

  it('rides on a state that otherwise reads as fine, and does not change it', () => {
    const quiet = decideNext(READY_FACTS());
    const carrying = decideNext(
      READY_FACTS({
        account: {
          limits: null,
          unsettled: [execution({ createdAt: ago(60 * 60_000) })],
          positions: [position({ currentPrice: null })],
        },
      } as Partial<NextFacts>),
    );
    // The state is whatever the state machine says — the notes are beside it.
    expect(carrying.state).toBe('UNSETTLED_EXECUTION');
    expect(quiet.notes).toBeUndefined();
    expect(kinds(carrying.notes ?? [])).toEqual([
      'DEPLOYED',
      'UNPRICED_POSITION',
      'UNSETTLED_TOO_LONG',
    ]);
  });

  it('says nothing about an account it could not read', () => {
    const unread = decideNext(READY_FACTS({ account: { failed: 'SERVICE_UNAVAILABLE' } } as Partial<NextFacts>));
    expect(unread.notes).toBeUndefined();
  });
});
