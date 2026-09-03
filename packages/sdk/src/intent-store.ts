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
 * WHAT THIS STORE IS NOT. It is not a lock. `createFileIntentStore` serializes
 * its own reads and writes and rewrites the file atomically, so one agent
 * process cannot lose its own record; two processes sharing one file can still
 * interleave a read-modify-write, and the residual window is stated rather than
 * papered over with a lockfile whose stale-lock recovery would be a worse
 * failure than the race it prevents. One store per process, one file per
 * project, which is how an agent runtime actually runs.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

  private async serialize<T>(operation: () => T): Promise<T> {
    const run = this.queue.then(operation, operation);
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
class FileIntentStore extends BaseIntentStore {
  private readonly mode: number;

  constructor(
    private readonly path: string,
    options: FileIntentStoreOptions = {},
  ) {
    super();
    this.mode = options.mode ?? 0o600;
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
    const records = new Map<string, IntentRecord>();
    const entries = (parsed as { intents?: unknown }).intents;
    if (entries !== null && typeof entries === 'object') {
      for (const [digest, value] of Object.entries(entries as Record<string, unknown>)) {
        const record = value as IntentRecord;
        if (typeof record?.idempotencyKey !== 'string') continue;
        records.set(digest, { ...record, digest });
      }
    }
    return records;
  }

  protected save(records: Map<string, IntentRecord>): void {
    const document = {
      /** Bumped only if the on-disk shape changes meaning. */
      version: 1,
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
