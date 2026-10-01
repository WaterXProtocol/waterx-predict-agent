/**
 * The file behind approvals and spend (ADR-0014). Two instances stand for two
 * invocations: what one spends, the other must see as spent.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { APPROVAL_TTL_MS, approvalIntent, createFileLedgers } from '../src/ledgers.ts';

const INTENT = 'apv1_0123456789abcdef';
const NOW = new Date('2026-09-17T00:00:00.000Z');
const dirs: string[] = [];

function ledgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wxp-ledger-'));
  dirs.push(dir);
  return join(dir, 'state', 'write-ledger.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the file ledger', () => {
  it('issues an approval another invocation can spend exactly once', () => {
    const path = ledgerPath();
    const issued = createFileLedgers(path).approvals.issue(INTENT, NOW);
    expect(approvalIntent(issued.token)).toBe(INTENT);
    expect(Date.parse(issued.expiresAt) - NOW.getTime()).toBe(APPROVAL_TTL_MS);

    const later = createFileLedgers(path);
    expect(later.approvals.consume(issued.token, INTENT, NOW, 'operator').consumedAt).toBe(NOW.toISOString());
    expect(() => createFileLedgers(path).approvals.consume(issued.token, INTENT, NOW, 'operator')).toThrow(/already spent/u);
  });

  it('appends the audit log, durably and privately, and never rewrites it', () => {
    const path = ledgerPath();
    const ledgers = createFileLedgers(path);
    ledgers.audit.append({ event: 'spend.released', id: 'a' }, NOW);
    createFileLedgers(path).audit.append({ event: 'spend.released', id: 'b' }, NOW);
    const auditPath = join(path, '..', 'write-audit.jsonl');
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([
      { v: 1, at: NOW.toISOString(), event: 'spend.released', id: 'a' },
      { v: 1, at: NOW.toISOString(), event: 'spend.released', id: 'b' },
    ]);
    expect(statSync(auditPath).mode & 0o777).toBe(0o600);
  });

  it('keeps the file private', () => {
    const path = ledgerPath();
    createFileLedgers(path).approvals.issue(INTENT, NOW);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  });

  it('counts spend across instances, and a release stops counting', () => {
    const path = ledgerPath();
    const first = createFileLedgers(path).spend.reserve('scope1_a', '60', '100', NOW);
    expect(() => createFileLedgers(path).spend.reserve('scope1_a', '50', '100', NOW)).toThrow(/40 wxUSD/u);
    // Another scope has its own count.
    expect(createFileLedgers(path).spend.reserve('scope1_b', '50', '100', NOW).total).toBe('50');
    createFileLedgers(path).spend.release(first.id);
    expect(createFileLedgers(path).spend.reserve('scope1_a', '100', '100', NOW).total).toBe('100');
  });

  it('refuses a ledger it cannot read rather than starting a fresh budget', () => {
    const path = ledgerPath();
    createFileLedgers(path).spend.reserve('scope1_a', '60', '100', NOW);
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(() => createFileLedgers(path).spend.reserve('scope1_a', '1', '100', NOW)).toThrow(/not one this build can read/u);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 2 });
  });

  it('takes over a lock a dead invocation left behind, and waits out a live one', () => {
    const path = ledgerPath();
    createFileLedgers(path).approvals.issue(INTENT, NOW);
    const lock = `${path}.lock`;
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(() => createFileLedgers(path).approvals.issue(INTENT, NOW)).not.toThrow();

    writeFileSync(lock, '');
    const started = Date.now();
    expect(() => createFileLedgers(path).approvals.issue(INTENT, NOW)).toThrow(/locked by another invocation/u);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
  }, 15_000);
});

describe('a budget belongs to the scope it was written under', () => {
  it('reports what an edited scope left behind, rather than starting silently at zero', () => {
    // The surprise this exists for: an operator narrowing a scope believes they
    // tightened a ceiling, and has in fact reset one. The reset is correct — a
    // ceiling inherited across a rewritten mandate would be enforced against
    // something nobody measured — so the fix is that it is visible.
    const path = ledgerPath();
    const ledgers = createFileLedgers(path);
    ledgers.spend.reserve('scope1_old', '30.000000', '50.000000', NOW);
    expect(ledgers.spend.total('scope1_old')).toBe('30');

    const edited = createFileLedgers(path);
    expect(edited.spend.total('scope1_new')).toBe('0');
    expect(edited.spend.elsewhere('scope1_new')).toEqual({ scopes: 1, total: '30' });
    // And nothing is reported for the scope that holds the spend itself.
    expect(edited.spend.elsewhere('scope1_old')).toEqual({ scopes: 0, total: '0' });
  });

  // A batch reserves once, before any leg is signed, because that is the only
  // order in which the batch can be refused before it starts. `release` is then
  // the wrong instrument for a batch that placed some of its legs: it is
  // all-or-nothing, so one filled leg kept the budget of the legs that were
  // never sent, for the life of the scope (ADR-0030).
  describe('settling a reservation against what it committed', () => {
    it('gives back the difference, and keeps counting what was committed', () => {
      const path = ledgerPath();
      const reserved = createFileLedgers(path).spend.reserve('scope1_a', '4.400000', '10.000000', NOW);
      expect(reserved.total).toBe('4.4');

      createFileLedgers(path).spend.settle(reserved.id, '2.200000');
      // Another invocation sees it: this is a durable control, not a number
      // held by the process that happened to place the batch.
      expect(createFileLedgers(path).spend.total('scope1_a')).toBe('2.2');
    });

    it('is a release when nothing was committed', () => {
      const path = ledgerPath();
      const reserved = createFileLedgers(path).spend.reserve('scope1_a', '4.400000', '10.000000', NOW);
      createFileLedgers(path).spend.settle(reserved.id, '0');
      expect(createFileLedgers(path).spend.total('scope1_a')).toBe('0');
      // One representation of "counts for nothing", so a reader does not have
      // to know whether a zero got there by release or by settlement.
      expect(createFileLedgers(path).spend.elsewhere('scope1_other')).toEqual({ scopes: 0, total: '0' });
    });

    it('never raises a reservation, whatever it is asked for', () => {
      // The direction that matters. A reservation is what the ceiling was
      // checked against; letting a settle exceed it would commit money past a
      // ceiling nothing ever cleared.
      const path = ledgerPath();
      const reserved = createFileLedgers(path).spend.reserve('scope1_a', '4.000000', '10.000000', NOW);
      createFileLedgers(path).spend.settle(reserved.id, '9.000000');
      expect(createFileLedgers(path).spend.total('scope1_a')).toBe('4');
    });

    it('leaves an unparseable amount and a released reservation alone', () => {
      const path = ledgerPath();
      const reserved = createFileLedgers(path).spend.reserve('scope1_a', '4.000000', '10.000000', NOW);
      // Budget is given back on evidence; a number nobody could read is none.
      createFileLedgers(path).spend.settle(reserved.id, 'two and a bit');
      expect(createFileLedgers(path).spend.total('scope1_a')).toBe('4');

      createFileLedgers(path).spend.release(reserved.id);
      createFileLedgers(path).spend.settle(reserved.id, '3.000000');
      expect(createFileLedgers(path).spend.total('scope1_a'), 'a released reservation stayed released').toBe('0');
    });

    it('frees the ceiling it gave back, for the next invocation', () => {
      // The whole point, stated as the thing an operator feels: budget that a
      // never-sent leg was holding is budget the next order can use.
      const path = ledgerPath();
      const reserved = createFileLedgers(path).spend.reserve('scope1_a', '4.400000', '5.000000', NOW);
      expect(() => createFileLedgers(path).spend.reserve('scope1_a', '2.200000', '5.000000', NOW)).toThrow(/POLICY_DENIED|cumulative/u);

      createFileLedgers(path).spend.settle(reserved.id, '2.200000');
      expect(createFileLedgers(path).spend.reserve('scope1_a', '2.200000', '5.000000', NOW).total).toBe('4.4');
    });
  });

  it('does not count a reservation that was released', () => {
    const path = ledgerPath();
    const ledgers = createFileLedgers(path);
    const reserved = ledgers.spend.reserve('scope1_old', '30.000000', '50.000000', NOW);
    ledgers.spend.release(reserved.id);
    // Nothing was signed under the old scope, so there is nothing to report
    // having left behind.
    expect(createFileLedgers(path).spend.elsewhere('scope1_new')).toEqual({ scopes: 0, total: '0' });
  });
});
