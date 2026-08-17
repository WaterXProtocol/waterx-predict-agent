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
import type { CreateJobInput } from '../src/store.ts';

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
