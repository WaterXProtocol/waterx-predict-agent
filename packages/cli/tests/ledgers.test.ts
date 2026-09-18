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
