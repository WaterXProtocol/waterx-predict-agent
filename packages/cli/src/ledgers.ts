/**
 * The write controls that must outlive one invocation (ADR-0014).
 *
 * Two ledgers, both local, both small:
 *
 *   approvals  an approval is ISSUED by `order preview` and CONSUMED by the one
 *              write it names. It expires, and it is spent exactly once, so a
 *              value carried out of a preview authorizes one order — not every
 *              later order that happens to look the same.
 *   spend      what `delegated-auto` has authorized to BUY under one scope, so
 *              `maxCumulativeBuyAmount` bounds the scope and not merely the
 *              process that happens to be running.
 *
 * WHAT THIS IS NOT. It is not a security boundary against a process running as
 * the same user: that process can edit these files, as it can edit the config.
 * It is the difference between an unattended loop being bounded and not, and
 * between an approval meaning "this order, once" and "this shape, forever".
 *
 * Every read-modify-write holds an exclusive lock file, so two invocations
 * cannot both consume one approval or both fit under one remaining budget.
 */
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';

import { formatDecimal, parseDecimal } from './decimal.ts';
import { CliError } from './errors.ts';

/* ── Approvals ─────────────────────────────────────────────────────────────── */

/** How long an issued approval may be used. Long enough to read a preview, short enough to go stale. */
export const APPROVAL_TTL_MS = 10 * 60_000;

export interface ApprovalRecord {
  readonly token: string;
  /** The intent digest (`apv1_…`) the approval was issued for. */
  readonly intent: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  /** Who gave the approval, as `--approver` named them. Present once spent. */
  readonly approvedBy?: string;
}

export interface ApprovalLedger {
  /** Issue a fresh approval for exactly this intent. */
  issue(intent: string, now: Date): ApprovalRecord;
  /**
   * Spend one approval on the intent it was issued for. Throws POLICY_DENIED
   * when it is unknown, for another intent, expired or already spent — and in
   * every one of those cases nothing is spent.
   */
  consume(token: string, intent: string, now: Date, approvedBy: string): ApprovalRecord;
}

const APPROVAL_PATTERN = /^apv2_[0-9a-f]{16}_[0-9a-f]{16}$/u;

/** The intent digest an approval token names, or undefined if it is not one. */
export function approvalIntent(token: string): string | undefined {
  if (!APPROVAL_PATTERN.test(token)) return undefined;
  return `apv1_${token.slice(5, 21)}`;
}

const mintToken = (intent: string): string => `apv2_${intent.slice(5)}_${randomBytes(8).toString('hex')}`;

function refuse(token: string, reason: string, detail: string, extra: Record<string, unknown> = {}): CliError {
  return new CliError('POLICY_DENIED', `${detail} Nothing was sent. Run \`order preview\` for this order and approve the token it issues.`, {
    policy: 'interactive',
    reason,
    suppliedApproval: token,
    ...extra,
    note: 'An approval is issued by one preview, names one exact intent, expires, and is spent by the one write it authorizes.',
  });
}

function issueInto(records: ApprovalRecord[], intent: string, now: Date): ApprovalRecord {
  const record: ApprovalRecord = {
    token: mintToken(intent),
    intent,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    consumedAt: null,
  };
  records.push(record);
  return record;
}

function consumeFrom(records: ApprovalRecord[], token: string, intent: string, now: Date, approvedBy: string): ApprovalRecord {
  const index = records.findIndex((record) => record.token === token);
  const record = records[index];
  if (record === undefined) {
    throw refuse(token, 'UNKNOWN_APPROVAL', `The approval \`${token}\` was not issued on this machine.`);
  }
  if (record.intent !== intent) {
    throw refuse(
      token,
      'INTENT_MISMATCH',
      `The approval \`${token}\` was issued for a different order. An approval names one exact order — account, market, side, size, position and price protection.`,
    );
  }
  if (record.consumedAt !== null) {
    throw refuse(token, 'APPROVAL_SPENT', `The approval \`${token}\` was already spent at ${record.consumedAt}; an approval authorizes one write.`, {
      consumedAt: record.consumedAt,
    });
  }
  if (now.getTime() >= Date.parse(record.expiresAt)) {
    throw refuse(token, 'APPROVAL_EXPIRED', `The approval \`${token}\` expired at ${record.expiresAt}.`, {
      expiresAt: record.expiresAt,
    });
  }
  const spent = { ...record, consumedAt: now.toISOString(), approvedBy };
  records[index] = spent;
  return spent;
}

/** Drop what can never be used again, a day after it stopped being usable. */
function pruneApprovals(records: readonly ApprovalRecord[], now: Date): ApprovalRecord[] {
  const horizon = now.getTime() - 24 * 60 * 60_000;
  return records.filter((record) => Date.parse(record.consumedAt ?? record.expiresAt) >= horizon);
}

/* ── Spend ─────────────────────────────────────────────────────────────────── */

export interface SpendRecord {
  /** Which scope the spend counts against — a digest of the scope itself. */
  readonly scope: string;
  readonly amount: string;
  readonly at: string;
  /** Released spend no longer counts: the order it was reserved for was never signed. */
  readonly released: boolean;
  readonly id: string;
}

export interface SpendLedger {
  /**
   * Reserve `amount` against `scope` if, with everything already reserved
   * there, it stays within `ceiling`. Returns the reservation id; throws
   * POLICY_DENIED when it would not fit, reserving nothing.
   */
  reserve(scope: string, amount: string, ceiling: string, now: Date): { id: string; total: string };
  /** Give back a reservation whose order was never signed. */
  release(id: string): void;
  /** What is reserved against `scope` right now. */
  total(scope: string): string;
}

function sumOf(records: readonly SpendRecord[], scope: string): bigint {
  let total = 0n;
  for (const record of records) {
    if (record.scope !== scope || record.released) continue;
    total += parseDecimal(record.amount) ?? 0n;
  }
  return total;
}

function reserveInto(records: SpendRecord[], scope: string, amount: string, ceiling: string, now: Date): { id: string; total: string } {
  const add = parseDecimal(amount);
  const limit = parseDecimal(ceiling);
  if (add === null || limit === null) {
    throw new CliError('POLICY_DENIED', 'The cumulative budget could not be checked, so nothing was authorized.', {
      amount,
      ceiling,
    });
  }
  const already = sumOf(records, scope);
  if (already + add > limit) {
    throw new CliError(
      'POLICY_DENIED',
      `The delegated-auto scope has ${formatDecimal(limit - already > 0n ? limit - already : 0n)} wxUSD of its cumulative budget left, and this order asks for ${formatDecimal(add)}. Nothing was sent.`,
      {
        policy: 'delegated-auto',
        violation: 'the combined budget exceeds the cumulative ceiling',
        alreadyAuthorized: formatDecimal(already),
        requested: formatDecimal(add),
        maxCumulativeBuyAmount: ceiling,
        note: 'The cumulative ceiling counts every BUY this scope authorized, across invocations, until `notAfter`. A new scope (any change to it) starts a new count.',
      },
    );
  }
  const id = randomBytes(8).toString('hex');
  records.push({ scope, amount: formatDecimal(add), at: now.toISOString(), released: false, id });
  return { id, total: formatDecimal(already + add) };
}

/* ── Adoption ──────────────────────────────────────────────────────────────── */

/**
 * The account this agent last traded on, per network and agent wallet.
 *
 * An agent wallet can hold grants on several accounts over time. Which one it
 * trades is whose money moves, so once one is in use a different one is never
 * taken up silently — only when someone names it.
 */
export interface AdoptionRecord {
  readonly accountId: string;
  readonly ownerAddress: string;
  readonly adoptedAt: string;
  /** `FIRST_SEEN` when the only authorized account was taken up; `NAMED` when someone chose it. */
  readonly basis: 'FIRST_SEEN' | 'NAMED';
  /** Where the name came from, when it was named. */
  readonly namedBy?: 'COMMAND' | 'CONFIG';
}

export interface AdoptionLedger {
  get(key: string): AdoptionRecord | undefined;
  set(key: string, record: AdoptionRecord): void;
}

/* ── Audit ─────────────────────────────────────────────────────────────────── */

/**
 * Every decision the ledgers take, one line each, never rewritten or pruned.
 *
 * The state file answers "what holds now" and forgets what no longer matters;
 * this answers "who authorized what, when" for as long as the file is kept.
 * It holds tokens, digests, amounts, account ids and names an operator typed —
 * never a key, a signature or transaction bytes.
 */
export type AuditEvent =
  | { readonly event: 'approval.issued'; readonly token: string; readonly intent: string; readonly expiresAt: string }
  | {
      readonly event: 'approval.spent';
      readonly token: string;
      readonly intent: string;
      readonly approvedBy: string;
      readonly command: string;
    }
  | { readonly event: 'spend.reserved'; readonly id: string; readonly scope: string; readonly amount: string; readonly total: string }
  | { readonly event: 'spend.released'; readonly id: string }
  | {
      readonly event: 'account.adopted';
      readonly key: string;
      readonly accountId: string;
      readonly basis: AdoptionRecord['basis'];
      readonly namedBy?: AdoptionRecord['namedBy'];
      readonly previous?: string;
    }
  | {
      readonly event: 'write.result';
      readonly command: string;
      readonly intent: string;
      readonly approvedBy?: string;
      readonly executions: readonly { readonly executionId: string; readonly status: string }[];
      readonly refused?: string;
    };

export interface AuditLog {
  append(event: AuditEvent, at: Date): void;
}

/* ── Storage ───────────────────────────────────────────────────────────────── */

interface LedgerFile {
  version: 1;
  approvals: ApprovalRecord[];
  spend: SpendRecord[];
  adopted?: Record<string, AdoptionRecord>;
}

const EMPTY = (): LedgerFile => ({ version: 1, approvals: [], spend: [] });

/** One JSON file under an exclusive lock, written atomically. */
class LockedJsonFile {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  update<T>(mutate: (file: LedgerFile) => T): T {
    const dir = this.path.slice(0, this.path.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    const release = acquire(lock);
    try {
      const file = this.read();
      const result = mutate(file);
      const temporary = `${this.path}.${String(process.pid)}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
      return result;
    } finally {
      release();
    }
  }

  read(): LedgerFile {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return EMPTY();
    }
    const parsed = JSON.parse(text) as Partial<LedgerFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.approvals) || !Array.isArray(parsed.spend)) {
      // A ledger this build cannot read is refused, never reset: resetting the
      // spend record would hand an unattended loop a fresh budget.
      throw new CliError('CONFIG_INVALID', `The write ledger at ${this.path} is not one this build can read. Nothing was authorized.`, {
        path: this.path,
      });
    }
    return parsed as LedgerFile;
  }
}

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function acquire(lock: string): () => void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      return () => rmSync(lock, { force: true });
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      // A lock older than any update could take belongs to a process that died
      // holding it. Taking it over is safe: the file under it was written
      // atomically, so it is whole.
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CliError('TIMEOUT', `The write ledger is locked by another invocation (${lock}). Nothing was authorized; try again.`, {
          lock,
        });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** Both ledgers, backed by one file in the state directory. */
/** Append one line and make it durable before returning. */
function appendDurably(path: string, line: string): void {
  const dir = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'a', 0o600);
  try {
    appendFileSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function createFileLedgers(
  path: string,
  auditPath = `${path.slice(0, path.lastIndexOf('/'))}/write-audit.jsonl`,
): { approvals: ApprovalLedger; spend: SpendLedger; adoptions: AdoptionLedger; audit: AuditLog } {
  const file = new LockedJsonFile(path);
  return {
    audit: {
      append: (event, at) => appendDurably(auditPath, `${JSON.stringify({ v: 1, at: at.toISOString(), ...event })}\n`),
    },
    adoptions: {
      get: (key) => file.read().adopted?.[key],
      set: (key, record) =>
        file.update((state) => {
          state.adopted = { ...state.adopted, [key]: record };
        }),
    },
    approvals: {
      issue: (intent, now) =>
        file.update((state) => {
          state.approvals = pruneApprovals(state.approvals, now);
          return issueInto(state.approvals, intent, now);
        }),
      consume: (token, intent, now, approvedBy) =>
        file.update((state) => consumeFrom(state.approvals, token, intent, now, approvedBy)),
    },
    spend: {
      reserve: (scope, amount, ceiling, now) => file.update((state) => reserveInto(state.spend, scope, amount, ceiling, now)),
      release: (id) =>
        file.update((state) => {
          state.spend = state.spend.map((record) => (record.id === id ? { ...record, released: true } : record));
        }),
      total: (scope) => formatDecimal(sumOf(file.read().spend, scope)),
    },
  };
}

/** The same ledgers in memory, for a host that keeps them itself (and for tests). */
export function createMemoryLedgers(): {
  approvals: ApprovalLedger;
  spend: SpendLedger;
  adoptions: AdoptionLedger;
  audit: AuditLog & { readonly events: readonly (AuditEvent & { at: string })[] };
} {
  const state = EMPTY();
  const events: (AuditEvent & { at: string })[] = [];
  return {
    audit: {
      events,
      append: (event, at) => {
        events.push({ ...event, at: at.toISOString() });
      },
    },
    adoptions: {
      get: (key) => state.adopted?.[key],
      set: (key, record) => {
        state.adopted = { ...state.adopted, [key]: record };
      },
    },
    approvals: {
      issue: (intent, now) => issueInto(state.approvals, intent, now),
      consume: (token, intent, now, approvedBy) => consumeFrom(state.approvals, token, intent, now, approvedBy),
    },
    spend: {
      reserve: (scope, amount, ceiling, now) => reserveInto(state.spend, scope, amount, ceiling, now),
      release: (id) => {
        state.spend = state.spend.map((record) => (record.id === id ? { ...record, released: true } : record));
      },
      total: (scope) => formatDecimal(sumOf(state.spend, scope)),
    },
  };
}
