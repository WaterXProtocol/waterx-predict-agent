/**
 * One logical write, one idempotency key — across process restarts, not just
 * across retries inside one call.
 *
 * `executeMarketOrder` has always minted a key and reused it for every retry of
 * the create. That covers the failure it was written for: a timeout mid-create
 * resolves to the original execution instead of opening a second order. What it
 * cannot cover is the process going away. A key held in a local variable dies
 * with the frame, so a caller who crashes between the create and the terminal
 * read comes back with no way to ask what happened — only a way to send a
 * second order under a fresh key, which the server has no reason to dedupe.
 *
 * The SDK's own answer to that used to be one sentence of documentation:
 * "supply `idempotencyKey` explicitly". Every caller who read it then had to
 * invent the same durable store, and inventing it is not the easy part — the
 * hard part is deciding WHICH FIELDS make two orders the same order, and that
 * decision is this package's to make, not each caller's.
 *
 * WHAT IS DIGESTED, and why it is a denylist rather than an allowlist.
 * The digest covers the whole intent MINUS a named set of fields that must not
 * discriminate:
 *
 *   - `idempotencyKey` — it is the output, not an input.
 *   - `referenceQuoteId` — a quote lives about three seconds. Including it
 *     would mint a fresh key on every retry, which is the exact defect this
 *     module exists to prevent. The CLI's approval token excludes it for the
 *     same reason and says so; two normalizations of "the same intent" that
 *     disagreed would be worse than either.
 *
 * Everything else discriminates, INCLUDING fields this contract has not grown
 * yet. That is the whole reason for a denylist: when the API adds a field that
 * changes what an order does, an allowlist silently drops it, two genuinely
 * different orders collide on one key, and the second one is deduped away with
 * the caller believing it traded. A denylist fails the other way — a cosmetic
 * new field mints a second key and the caller sends a second order — which is
 * visible, refusable at the risk profile, and reviewable. Neither direction is
 * free; this one is the one you can see happening.
 *
 * CONCURRENCY, WHICH IS NOT OPTIONAL HERE. An atomic rename stops a torn file;
 * it does nothing about two processes reading the same ledger, each finding no
 * record, and each minting a key for the same order. That is not a hypothetical
 * — the shipped recipes are shell scripts, and running one twice at once is a
 * thing people do. So `createFileIntentStore` holds an exclusive lock across the
 * whole read-modify-write: an `O_EXCL` file beside the ledger, in-process work
 * already serialized behind it, and the two together make one reservation per
 * intent across processes as well as within one.
 *
 * NOTHING TAKES A LOCK IT DID NOT CREATE. This is the whole of the exclusion
 * argument, and it is short on purpose, because two earlier versions were not.
 *
 * The first declared a holder dead after a timeout and removed it. The second
 * kept the removal and asked `process.kill(pid, 0)` first, so only a provably
 * dead holder was cleared. Both are unsound, and for the same structural reason
 * rather than for a reason about how the deadness was decided: `unlink` then
 * `open(O_EXCL)` is two steps. Two callers can read the same dead lock, the
 * first can clear it and create its own, and the second — still acting on what
 * it read a moment ago — deletes THAT one and creates a third. Now two sections
 * are running and each believes it holds the lock. No amount of care about the
 * liveness question fixes a takeover that is not atomic, and plain `fs` offers
 * no compare-and-swap to make it atomic with.
 *
 * So there is no takeover. `open(O_EXCL)` succeeds for exactly one caller and
 * that is the entire protocol; a lock that exists is respected, always, and a
 * caller only ever removes the lock whose token is still its own.
 *
 * The cost is that a process killed mid-section leaves a file behind, and the
 * next run stops until somebody removes it. That is a deliberate trade. This
 * guards a ledger that decides whether a second order is placed, and a refusal
 * naming the path is thirty seconds of a person's time; every automatic
 * recovery available here buys those thirty seconds with a race. The liveness
 * check survives as the thing that makes the refusal ACTIONABLE — it tells the
 * operator whether the holder is still running, so they know whether removing
 * the file is safe — but nothing acts on the answer.
 *
 * The write is fenced as well: the ledger rewrite re-checks the token before it
 * commits, so a section whose lock was removed by a person mid-run fails
 * instead of writing.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { sleep } from './sleep.ts';

/**
 * Fields that never make two intents different.
 *
 * Deliberately tiny, and deliberately the only exception list. See the header:
 * every field NOT named here discriminates, including ones added later.
 */
export const INTENT_DIGEST_EXCLUDED_FIELDS: readonly string[] = [
  'idempotencyKey',
  'referenceQuoteId',
];

/**
 * The on-disk shape. Bumped only when it changes meaning.
 *
 * A reader that meets a version it does not know REFUSES. Reading a newer
 * ledger on old assumptions is how a record is misinterpreted rather than
 * merely missed, and a misread record is a key minted twice.
 */
const LEDGER_VERSION = 1;

/** Where a reserved key stands. `PENDING` is the state a restart has to resolve. */
export type IntentRecordStatus = 'PENDING' | 'SETTLED';

export interface IntentRecord {
  /** The key minted for this intent, and replayed for every later attempt at it. */
  readonly idempotencyKey: string;
  /** The intent's canonical digest — this record's identity, and its index. */
  readonly digest: string;
  /** The intent as digested, so a restart can report WHAT it was about to do. */
  readonly intent: Readonly<Record<string, unknown>>;
  readonly status: IntentRecordStatus;
  readonly createdAt: string;
  /**
   * Recorded the moment the server admits the execution exists.
   *
   * This is the field the hand-rolled version of this store always lacks, and
   * the one that makes a restart recoverable: a key alone tells you an order
   * MIGHT exist, an execution id tells you what to read back.
   */
  readonly executionId?: string;
  /**
   * The price the chain enforced for that execution.
   *
   * Recorded beside the id because it is the one fact about a completed write
   * that a later READ cannot recover — `getExecution` does not carry it. Without
   * it, resolving an intent by reading its execution back could not produce a
   * complete result, and the code that does so falls through to sending instead
   * of inventing a number.
   */
  readonly enforcedWorstPrice?: string;
  readonly settledAt?: string;
  /** The terminal status observed, when one was. Free text, from the server. */
  readonly outcome?: string;
}

export interface IntentReservation {
  readonly idempotencyKey: string;
  /**
   * True when this exact intent had already been reserved.
   *
   * A replay is the normal, safe path — it is what makes a retry a retry. It is
   * also the signal a caller wants before a WRITE that follows a crash: a
   * replayed key whose record is still `PENDING` means an order may already
   * exist, and the answer is to read it back by `executionId`, never to send.
   */
  readonly replayed: boolean;
  readonly record: IntentRecord;
}

/**
 * Durable minting of idempotency keys, one per logical intent.
 *
 * Every method is async because a real implementation is I/O — a file, a row,
 * a KV entry. The in-memory one satisfies it without pretending otherwise.
 */
export interface IntentStore {
  /**
   * The key for this intent: the one already minted for it, or a new one.
   *
   * Idempotent by construction. Calling it twice with the same intent returns
   * the same key both times, which is the entire guarantee.
   */
  reserve(intent: Readonly<Record<string, unknown>>): Promise<IntentReservation>;
  /**
   * Record the execution as soon as the server admits the write exists.
   *
   * `enforcedWorstPrice` comes along because the create is the only place it is
   * ever seen; see {@link IntentRecord.enforcedWorstPrice}.
   */
  attach(idempotencyKey: string, executionId: string, enforcedWorstPrice?: string): Promise<void>;
  /** Mark the intent finished. `outcome` is the terminal status observed. */
  settle(idempotencyKey: string, outcome: string): Promise<void>;
  /** Every intent reserved and never settled — what a restart must reconcile. */
  pending(): Promise<readonly IntentRecord[]>;
  /** By digest, for a caller checking before it acts. */
  find(intent: Readonly<Record<string, unknown>>): Promise<IntentRecord | undefined>;
  /**
   * Drop a record.
   *
   * For a caller that has read the execution back and finished with it. Never
   * call it to "clear a stuck order": forgetting a PENDING record is how the
   * next attempt mints a fresh key and places the second order.
   */
  forget(idempotencyKey: string): Promise<void>;
}

/* ── The digest ───────────────────────────────────────────────────────────── */

/**
 * JSON with every object key sorted, at every depth.
 *
 * Two callers building the same intent with their fields in a different order
 * must digest identically — otherwise the key depends on the shape of the
 * caller's source code, and the same order placed from two code paths gets two
 * keys.
 *
 * `undefined` members are dropped rather than encoded, so an explicitly-absent
 * optional (`{ positionId: undefined }`, which `exactOptionalPropertyTypes`
 * still permits at runtime) digests the same as an omitted one.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    // JSON.stringify turns these into `null`, which would make NaN and Infinity
    // digest identically to an absent field — and a slippage bound of NaN must
    // never share a key with one that was never set.
    throw new RangeError(`not representable in an intent digest: ${String(value)}`);
  }
  if (typeof value === 'bigint') {
    throw new TypeError('not representable in an intent digest: bigint');
  }
  return JSON.stringify(value) ?? 'null';
}

/** The intent, minus the fields the header explains must not discriminate. */
export function normalizeIntent(
  intent: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(intent)) {
    if (INTENT_DIGEST_EXCLUDED_FIELDS.includes(key)) continue;
    if (value === undefined) continue;
    normalized[key] = value;
  }
  return normalized;
}

/**
 * This intent's identity: sha-256 over its canonical form.
 *
 * Full length, not truncated. A truncated digest is a smaller keyspace for
 * something that decides whether two orders are the same order, and the sixteen
 * hex characters that look tidy in a file buy nothing a caller can spend.
 */
export function intentDigest(intent: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(normalizeIntent(intent))).digest('hex');
}

/* ── Implementations ──────────────────────────────────────────────────────── */

/**
 * The serialized core both stores share.
 *
 * Written once so the file store and the memory store cannot drift on the part
 * that decides whether a second order is placed. The difference between them is
 * where the map lives and whether it survives the process — nothing else.
 */
abstract class BaseIntentStore implements IntentStore {
  /** One promise chain, so a read-modify-write is never interleaved with itself. */
  private queue: Promise<unknown> = Promise.resolve();

  protected abstract load(): Map<string, IntentRecord>;
  protected abstract save(records: Map<string, IntentRecord>): void;

  /**
   * Run one read-modify-write with whatever exclusion this storage needs.
   *
   * The in-memory store needs none — the map is not shared with anyone. The file
   * store takes a cross-process lock. Both still run behind the same queue, so
   * this only ever has to think about OTHER processes.
   */
  protected async exclusive<T>(operation: () => T): Promise<T> {
    return await Promise.resolve(operation());
  }

  private async serialize<T>(operation: () => T): Promise<T> {
    const guarded = async (): Promise<T> => await this.exclusive(operation);
    const run = this.queue.then(guarded, guarded);
    // The chain must survive a rejection, or one failed write deadlocks every
    // later one. The caller still sees the rejection; the chain does not.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async reserve(intent: Readonly<Record<string, unknown>>): Promise<IntentReservation> {
    const digest = intentDigest(intent);
    return await this.serialize(() => {
      const records = this.load();
      const existing = records.get(digest);
      if (existing !== undefined) {
        return { idempotencyKey: existing.idempotencyKey, replayed: true, record: existing };
      }
      const record: IntentRecord = {
        idempotencyKey: randomUUID(),
        digest,
        intent: normalizeIntent(intent),
        status: 'PENDING',
        createdAt: new Date().toISOString(),
      };
      records.set(digest, record);
      this.save(records);
      return { idempotencyKey: record.idempotencyKey, replayed: false, record };
    });
  }

  async attach(
    idempotencyKey: string,
    executionId: string,
    enforcedWorstPrice?: string,
  ): Promise<void> {
    await this.update(idempotencyKey, (record) => ({
      ...record,
      executionId,
      ...(enforcedWorstPrice === undefined ? {} : { enforcedWorstPrice }),
    }));
  }

  async settle(idempotencyKey: string, outcome: string): Promise<void> {
    await this.update(idempotencyKey, (record) => ({
      ...record,
      status: 'SETTLED',
      settledAt: new Date().toISOString(),
      outcome,
    }));
  }

  async pending(): Promise<readonly IntentRecord[]> {
    return await this.serialize(() =>
      [...this.load().values()]
        .filter((record) => record.status === 'PENDING')
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
    );
  }

  async find(intent: Readonly<Record<string, unknown>>): Promise<IntentRecord | undefined> {
    const digest = intentDigest(intent);
    return await this.serialize(() => this.load().get(digest));
  }

  async forget(idempotencyKey: string): Promise<void> {
    await this.serialize(() => {
      const records = this.load();
      for (const [digest, record] of records) {
        if (record.idempotencyKey === idempotencyKey) records.delete(digest);
      }
      this.save(records);
    });
  }

  /**
   * Mutate by key rather than by digest, because that is the handle a caller
   * holds after `reserve`. A key nobody reserved is IGNORED rather than thrown:
   * these calls sit on the success path of a write that already happened, and
   * failing one would turn a bookkeeping miss into a reported order failure.
   */
  private async update(
    idempotencyKey: string,
    change: (record: IntentRecord) => IntentRecord,
  ): Promise<void> {
    await this.serialize(() => {
      const records = this.load();
      for (const [digest, record] of records) {
        if (record.idempotencyKey !== idempotencyKey) continue;
        records.set(digest, change(record));
        this.save(records);
        return;
      }
    });
  }
}

/** Nothing survives the process. For tests, and for a caller who says so. */
class MemoryIntentStore extends BaseIntentStore {
  private readonly records = new Map<string, IntentRecord>();

  protected load(): Map<string, IntentRecord> {
    return this.records;
  }

  protected save(): void {
    // The map IS the storage; `load` handed out the live one.
  }
}

/**
 * A store with no durability, stated in its name.
 *
 * It exists so the wiring is exercised in tests and so a caller who genuinely
 * has no restart to survive — a one-shot script, a request handler behind its
 * own dedupe — can say that in code rather than by omission.
 */
export function createMemoryIntentStore(): IntentStore {
  return new MemoryIntentStore();
}

export interface FileIntentStoreOptions {
  /** File mode for the ledger. Default `0o600`. */
  readonly mode?: number;
  /**
   * How long to wait for a LIVE holder before refusing. Default 5 s.
   *
   * Note what this is not: a point at which the lock is taken. A live holder is
   * never stolen from, whatever this is set to.
   */
  readonly lockTimeoutMs?: number;
  /**
   * Override the liveness check used in the REFUSAL MESSAGE.
   *
   * Nothing acts on its answer — a lock is never removed on the strength of it —
   * so a wrong answer here misinforms an operator and cannot let two sections
   * run. Testing seam; there is no reason to pass one.
   */
  readonly isHolderAlive?: (pid: number) => boolean;
}

/**
 * The ledger on disk, rewritten atomically.
 *
 * Atomic because a torn write here is the worst outcome available: a truncated
 * JSON file reads back as empty, every reserved key is forgotten, and the next
 * attempt at a pending intent mints a fresh one. So a write goes to a sibling
 * temp file and is renamed over the target, which is atomic within a directory
 * on every filesystem this runtime supports (ADR-0002).
 *
 * A file that cannot be parsed is NOT silently replaced. See `load`.
 */
/** The lock file's contents. Everything a later caller needs to judge it. */
interface LockHolder {
  readonly host: string;
  readonly pid: number;
  readonly token: string;
  readonly at: string;
}

/**
 * Is this pid a running process on this machine?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `EPERM` means it exists and belongs to somebody else — alive.
 * `ESRCH` means no such process — gone.
 */
const defaultIsHolderAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

class FileIntentStore extends BaseIntentStore {
  private readonly mode: number;
  private readonly lockTimeoutMs: number;
  private readonly lockPath: string;
  private readonly isHolderAlive: (pid: number) => boolean;
  /** The token of the lock this instance currently holds, if it holds one. */
  private held: string | undefined;

  constructor(
    private readonly path: string,
    options: FileIntentStoreOptions = {},
  ) {
    super();
    this.mode = options.mode ?? 0o600;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.isHolderAlive = options.isHolderAlive ?? defaultIsHolderAlive;
    this.lockPath = `${path}.lock`;
  }

  /**
   * The whole read-modify-write, under an exclusive lock.
   *
   * `wx` is `O_CREAT | O_EXCL`: it succeeds for exactly one caller and fails
   * `EEXIST` for every other, which is the only primitive here that works across
   * processes. Released in a `finally`, so a throw inside the section does not
   * wedge the next one.
   */
  protected override async exclusive<T>(operation: () => T): Promise<T> {
    const token = await this.acquire();
    this.held = token;
    try {
      return operation();
    } finally {
      this.held = undefined;
      this.release(token);
    }
  }

  private async acquire(): Promise<string> {
    mkdirSync(dirname(this.path), { recursive: true });
    const token = randomUUID();
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const handle = openSync(this.lockPath, 'wx', 0o600);
        try {
          const holder: LockHolder = {
            host: hostname(),
            pid: process.pid,
            token,
            at: new Date().toISOString(),
          };
          writeFileSync(handle, `${JSON.stringify(holder)}\n`);
        } finally {
          closeSync(handle);
        }
        return token;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      // Held by somebody. Wait — and only wait. Removing it here is the
      // takeover the header rules out.
      if (Date.now() >= deadline) throw this.refusal(this.describeHolder());
      await sleep(20);
    }
  }

  /** Remove the lock ONLY while it is still ours. Never another caller's. */
  private release(token: string): void {
    if (this.readHolder()?.token !== token) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Already gone. Nothing to undo.
    }
  }

  private readHolder(): LockHolder | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.lockPath, 'utf8')) as Partial<LockHolder>;
      if (typeof parsed.token !== 'string' || typeof parsed.pid !== 'number') return undefined;
      return { host: String(parsed.host), pid: parsed.pid, token: parsed.token, at: String(parsed.at) };
    } catch {
      return undefined;
    }
  }

  /**
   * Who holds it, and whether they are still running.
   *
   * The liveness answer is REPORTED and never acted on: it is what turns "a
   * lock file exists" into an instruction a person can follow without guessing
   * whether deleting it is safe.
   */
  private describeHolder(): string {
    const holder = this.readHolder();
    if (holder === undefined) {
      return 'its holder could not be read, so nothing can be said about whether it is still running';
    }
    const who = `pid ${String(holder.pid)} on ${holder.host}, held since ${holder.at}`;
    if (holder.host !== hostname()) {
      return `${who} — a pid on another host cannot be checked from here`;
    }
    return this.isHolderAlive(holder.pid)
      ? `${who} — that process IS still running, so do not remove the lock`
      : `${who} — that process is NOT running, so the lock is safe to remove`;
  }

  private refusal(because: string): Error {
    return new Error(
      `Could not take the intent ledger lock at ${this.lockPath}: ${because}. Nothing here removes a lock it did not create — a takeover is two steps and two callers can both take it, which is how one intent becomes two orders. If the holder is gone, remove ${this.lockPath} and re-run.`,
    );
  }

  protected load(): Map<string, IntentRecord> {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      // Deliberately fatal. Starting fresh here would be the same defect as a
      // torn write: keys for orders that may be in flight, discarded, and the
      // next attempt free to place a second one. A person has to look.
      throw new Error(
        `The intent ledger at ${this.path} is not readable JSON, and this store will not start a new one over it — a reserved key that is discarded is a second order waiting to be placed. Inspect the file, recover the keys, then move it aside.`,
        { cause: error },
      );
    }
    const document = parsed as { version?: unknown; intents?: unknown } | null;
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw this.unreadable('its root is not an object');
    }
    // A version this cannot read means the shape may have changed under every
    // assumption below. Reading it anyway is how a record is misinterpreted
    // rather than merely missed.
    if (document.version !== LEDGER_VERSION) {
      throw this.unreadable(
        `it is version ${JSON.stringify(document.version)} and this build reads version ${String(LEDGER_VERSION)}`,
      );
    }
    // NOT "absent means empty". An empty ledger is a file that does not exist;
    // a file that exists without `intents` is a file this does not understand,
    // and treating it as empty mints a fresh key for every intent it was
    // holding one for.
    const entries = document.intents;
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
      throw this.unreadable('it has no `intents` object');
    }

    const records = new Map<string, IntentRecord>();
    for (const [digest, value] of Object.entries(entries as Record<string, unknown>)) {
      records.set(digest, this.validate(digest, value));
    }
    return records;
  }

  /**
   * A record, or an error naming it.
   *
   * Every field a reader will reach for is checked here, because the readers are
   * the recovery paths and they run at the worst moment. A record with an
   * `idempotencyKey` and no `intent` used to load fine and then take the
   * reconciliation recipe down on a property access — an uncaught throw, an
   * empty `--json` stdout, and an operator none the wiser about the order the
   * record was there to tell them about.
   *
   * Malformed is FATAL rather than skipped, for the same reason an unparseable
   * ledger is: a record this cannot read may be the one naming an execution
   * that exists, and quietly dropping it frees the next attempt to mint a new
   * key. A person has to look.
   */
  private unreadable(because: string): Error {
    return new Error(
      `The intent ledger at ${this.path} cannot be read: ${because}. This will not carry on over a ledger it does not understand — every record it fails to see is a key it will mint again, and a key minted twice is an order placed twice. Inspect the file, recover what it names, then move it aside.`,
    );
  }

  private validate(digest: string, value: unknown): IntentRecord {
    const record = value as Partial<IntentRecord> | null;
    const bad = (field: string): never => {
      throw new Error(
        `The intent ledger at ${this.path} has a record under ${digest} whose \`${field}\` is missing or the wrong type. This will not load a record it cannot read, and will not skip one either — a record it cannot read may be the one naming an order that exists, and dropping it frees the next attempt to mint a new key. Inspect the file, recover what it names, then move it aside.`,
      );
    };
    if (record === null || typeof record !== 'object') bad('record');
    if (typeof record?.idempotencyKey !== 'string') bad('idempotencyKey');
    if (record?.intent === null || typeof record?.intent !== 'object') bad('intent');
    if (record?.status !== 'PENDING' && record?.status !== 'SETTLED') bad('status');
    if (typeof record?.createdAt !== 'string') bad('createdAt');
    for (const field of ['executionId', 'enforcedWorstPrice', 'settledAt', 'outcome'] as const) {
      if (record?.[field] !== undefined && typeof record[field] !== 'string') bad(field);
    }

    // The key IS the content, so a record must hash to where it is filed. This
    // is the check that makes the index self-verifying, and it is the one that
    // matters most: a record under the wrong key is invisible to `reserve`,
    // which finds nothing for that intent, mints a second key, and places a
    // second order — while the first key, and possibly a live execution, sit
    // under a name nothing will look up. Truncation, a hand edit, a merge of
    // two ledgers, a partially rewritten field: all of them land here.
    const computed = intentDigest(record?.intent as Record<string, unknown>);
    if (computed !== digest) {
      throw new Error(
        `The intent ledger at ${this.path} has a record filed under ${digest} whose intent hashes to ${computed}. A record under the wrong key is invisible to the lookup that prevents a second order, so this refuses to load rather than mint a fresh key for an intent that already has one. Inspect the file — the intent it holds is intact, and it belongs under ${computed}.`,
      );
    }
    return { ...(record as IntentRecord), digest };
  }

  protected save(records: Map<string, IntentRecord>): void {
    // The fence. A section that somehow lost its lock must not commit — and
    // "somehow" is not hypothetical, because the lock file is a file and a
    // person or a script can remove it while this is running.
    if (this.held !== undefined && this.readHolder()?.token !== this.held) {
      throw new Error(
        `The intent ledger lock at ${this.lockPath} is no longer held by this process; refusing to write. Nothing was changed. Something removed or replaced the lock mid-write — re-run, and check what else is touching ${this.path}.`,
      );
    }
    const document = {
      version: LEDGER_VERSION,
      intents: Object.fromEntries([...records].map(([digest, record]) => [digest, record])),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.${randomUUID()}.intent-tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: this.mode });
      renameSync(temporary, this.path);
    } catch (error: unknown) {
      try {
        unlinkSync(temporary);
      } catch {
        // The rename may already have consumed it, and a leftover temp file is
        // not worth masking the real failure with.
      }
      throw error;
    }
  }
}

/**
 * The durable store: one JSON ledger, digest-indexed, atomically rewritten.
 *
 * Put it inside the project rather than in a temp directory — it is the record
 * of what this agent has money in, and it has to still be there after a reboot.
 * `.waterx/intents.json` beside the project is the shape this SDK documents.
 */
export function createFileIntentStore(
  path: string,
  options: FileIntentStoreOptions = {},
): IntentStore {
  return new FileIntentStore(path, options);
}
