/**
 * A real database in a temporary directory, not `:memory:`.
 *
 * The store's guarantees are about what survives a process that stopped —
 * WAL, fsync, and rows still being there on reopen — and an in-memory database
 * cannot be reopened. Every test here pays the file I/O for that reason.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JobLegIntent, JobPolicySnapshot, JobTrigger } from '../src/job.ts';
import type { BeginSideEffectInput, CreateJobInput, JobStore } from '../src/store.ts';

export const T0 = '2026-08-17T12:00:00.000Z';

export const later = (fromIso: string, ms: number): string =>
  new Date(Date.parse(fromIso) + ms).toISOString();

export const LEG: JobLegIntent = {
  marketId: 'mkt_btts_yes',
  outcomeId: 'YES',
  side: 'SELL',
  sellShares: '25.000000',
  positionId: 'pos_1',
  maxSlippageBps: 50,
};

export const TRIGGER: JobTrigger = { kind: 'PRICE', targetPrice: '0.8200', observe: 'BID' };

export const POLICY: JobPolicySnapshot = {
  mode: 'delegated-auto',
  source: 'file:~/.waterx/policy.json',
  maxOrderNotional: '100.000000',
};

export const jobInput = (overrides: Partial<CreateJobInput> = {}): CreateJobInput => ({
  jobId: 'job_1',
  strategyId: 'strat_1',
  ownerAddress: '0xowner',
  accountId: 'acct_1',
  agentWallet: '0xagent',
  intent: [LEG],
  trigger: TRIGGER,
  policy: POLICY,
  expiresAt: later(T0, 86_400_000),
  at: T0,
  ...overrides,
});

/**
 * What a process that stopped between two writes throws.
 *
 * Named rather than anonymous so a test can assert it caught the injected death
 * and not some other failure that happens to arrive as an `Error`.
 */
export class Crash extends Error {
  override readonly name = 'Crash';
}

/**
 * The store, with a trip wire. `hook` runs BEFORE the delegated call, so a throw
 * from it leaves the database in exactly the state a process that died one
 * instruction earlier would have left it in.
 *
 * Shared by the driver tests, which call one pass directly, and the daemon tests,
 * which let the scheduler call it — the same injected death, at both levels.
 */
export const crashingStore = (
  inner: JobStore,
  hook: (method: string, args: readonly unknown[]) => void,
): JobStore =>
  new Proxy(inner, {
    get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        hook(String(property), args);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as JobStore;

/** Dies just before the ledger records that a request for `legIndex` is coming. */
export const crashBeforeSideEffect = (inner: JobStore, legIndex: number): JobStore =>
  crashingStore(inner, (method, args) => {
    if (method !== 'beginSideEffect') return;
    if ((args[0] as BeginSideEffectInput).legIndex !== legIndex) return;
    throw new Crash(`crash before the attempt for leg ${String(legIndex)}`);
  });

export interface TempStoreDir {
  readonly path: string;
  cleanup(): void;
}

export const tempStoreDir = (): TempStoreDir => {
  const directory = mkdtempSync(join(tmpdir(), 'waterx-runner-'));
  return {
    path: join(directory, 'nested', 'jobs.sqlite'),
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

export interface TempRuntimeDir {
  /** The runtime directory itself: the socket and the token file live here. */
  readonly dir: string;
  readonly storePath: string;
  cleanup(): void;
}

/**
 * A private runtime directory under the OS temp dir.
 *
 * `mkdtemp` already creates at `0700`, which is what the daemon asserts. Tests
 * that need a *loose* directory relax it explicitly, so the assertion under test
 * is never accidentally satisfied by the default.
 */
export const tempRuntimeDir = (): TempRuntimeDir => {
  const directory = mkdtempSync(join(tmpdir(), 'wx-run-'));
  return {
    dir: directory,
    storePath: join(directory, 'jobs.sqlite'),
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
};
