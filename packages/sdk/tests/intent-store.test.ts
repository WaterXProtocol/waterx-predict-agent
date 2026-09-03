/**
 * The store that decides whether a second order gets placed.
 *
 * Almost everything here is about the digest: which fields make two intents the
 * same intent, which do not, and which way the design fails when the contract
 * grows a field nobody updated this module for. Getting that backwards is not a
 * bug that shows up in a log — it is a duplicate order, or an order silently
 * deduped away while the caller believes it traded.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { hostname } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';


import {
  canonicalJson,
  createFileIntentStore,
  createMemoryIntentStore,
  INTENT_DIGEST_EXCLUDED_FIELDS,
  intentDigest,
  type IntentStore,
  normalizeIntent,
} from '../src/intent-store.ts';

const INTENT = {
  accountId: '0xacct',
  marketId: '0xmarket',
  outcomeId: 'YES',
  side: 'BUY',
  size: { buyAmount: '5' },
  maxSlippageBps: 100,
};

let directory: string;
let ledger: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'waterx-intents-'));
  ledger = join(directory, 'nested', 'intents.json');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the intent digest', () => {
  it('is the same whatever order the caller built the object in', () => {
    // Otherwise the key depends on the shape of somebody's source code, and the
    // same order placed from two code paths gets two keys.
    const a = { accountId: '0xa', marketId: '0xm', side: 'BUY' };
    const b = { side: 'BUY', marketId: '0xm', accountId: '0xa' };

    expect(intentDigest(a)).toBe(intentDigest(b));
  });

  it('treats an explicitly-undefined optional as an absent one', () => {
    expect(intentDigest({ ...INTENT, positionId: undefined })).toBe(intentDigest(INTENT));
  });

  it('ignores the reference quote id, because a quote lives three seconds', () => {
    // Including it would mint a fresh key on every retry — the exact defect this
    // module exists to prevent, dressed up as caution.
    expect(intentDigest({ ...INTENT, referenceQuoteId: 'q-1' })).toBe(
      intentDigest({ ...INTENT, referenceQuoteId: 'q-2' }),
    );
    expect(INTENT_DIGEST_EXCLUDED_FIELDS).toContain('referenceQuoteId');
  });

  it('ignores the key itself, which is the output and not an input', () => {
    expect(intentDigest({ ...INTENT, idempotencyKey: 'k-1' })).toBe(intentDigest(INTENT));
  });

  it('discriminates on every field that changes what the order does', () => {
    const base = intentDigest(INTENT);
    for (const change of [
      { accountId: '0xother' },
      { marketId: '0xother' },
      { outcomeId: 'NO' },
      { side: 'SELL' },
      { size: { buyAmount: '6' } },
      { size: { sellShares: '5' } },
      { maxSlippageBps: 50 },
      { positionId: '1145' },
      { worstAcceptablePrice: '0.53' },
      { clientOrderId: 'second-time' },
    ]) {
      expect(intentDigest({ ...INTENT, ...change }), JSON.stringify(change)).not.toBe(base);
    }
  });

  it('discriminates on a field this module has never heard of', () => {
    // The denylist is the whole design. An allowlist would silently drop a field
    // the API adds later, two genuinely different orders would collide on one
    // key, and the second would be deduped away with the caller believing it
    // traded. This fails the other way, which is the way you can see.
    expect(intentDigest({ ...INTENT, someFutureField: 'matters' })).not.toBe(
      intentDigest(INTENT),
    );
  });

  it('refuses values it cannot represent rather than flattening them', () => {
    // JSON.stringify turns NaN into null, which would make a slippage bound of
    // NaN digest identically to one that was never set.
    expect(() => canonicalJson({ maxSlippageBps: Number.NaN })).toThrow(RangeError);
    expect(() => canonicalJson({ size: 5n })).toThrow(TypeError);
  });

  it('drops only the named exclusions when normalizing', () => {
    expect(normalizeIntent({ ...INTENT, idempotencyKey: 'k', referenceQuoteId: 'q' })).toEqual(
      INTENT,
    );
  });
});

/** Both implementations answer the same questions, so both are asked them. */
describe.each([
  ['memory', (): IntentStore => createMemoryIntentStore()],
  ['file', (): IntentStore => createFileIntentStore(ledger)],
])('%s store', (_name, make) => {
  it('mints once and replays forever for the same intent', async () => {
    const store = make();

    const first = await store.reserve(INTENT);
    const second = await store.reserve(INTENT);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('mints a different key for a different intent', async () => {
    const store = make();

    const five = await store.reserve(INTENT);
    const six = await store.reserve({ ...INTENT, size: { buyAmount: '6' } });

    expect(six.idempotencyKey).not.toBe(five.idempotencyKey);
  });

  it('returns one key when the same intent is reserved concurrently', async () => {
    // A read-modify-write over one file is racy by construction. Two callers
    // racing must not walk away with two keys for one order.
    const store = make();

    const reservations = await Promise.all(
      Array.from({ length: 8 }, async () => await store.reserve(INTENT)),
    );

    expect(new Set(reservations.map((entry) => entry.idempotencyKey)).size).toBe(1);
    expect(reservations.filter((entry) => !entry.replayed)).toHaveLength(1);
  });

  it('does not lose a concurrent write for a different intent', async () => {
    const store = make();

    await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) =>
        await store.reserve({ ...INTENT, clientOrderId: `order-${String(index)}` }),
      ),
    );

    expect(await store.pending()).toHaveLength(8);
  });

  it('lists what was reserved and never settled — and nothing else', async () => {
    const store = make();
    const open = await store.reserve(INTENT);
    const done = await store.reserve({ ...INTENT, clientOrderId: 'done' });

    await store.attach(open.idempotencyKey, 'exec-open');
    await store.settle(done.idempotencyKey, 'FILLED');

    const pending = await store.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.idempotencyKey).toBe(open.idempotencyKey);
    // The handle a restart reconciles WITH. A key alone says an order might
    // exist; an execution id says what to read back.
    expect(pending[0]?.executionId).toBe('exec-open');
  });

  it('finds a record by the intent rather than by the key', async () => {
    const store = make();
    const reserved = await store.reserve(INTENT);

    expect((await store.find(INTENT))?.idempotencyKey).toBe(reserved.idempotencyKey);
    expect(await store.find({ ...INTENT, size: { buyAmount: '9' } })).toBeUndefined();
  });

  it('ignores a settle for a key nobody reserved instead of throwing', async () => {
    // These calls sit on the success path of a write that already happened.
    // Failing one would turn a bookkeeping miss into a reported order failure.
    const store = make();

    await expect(store.settle('never-reserved', 'FILLED')).resolves.toBeUndefined();
    await expect(store.attach('never-reserved', 'exec-x')).resolves.toBeUndefined();
  });

  it('forgets a record when explicitly told to', async () => {
    const store = make();
    const reserved = await store.reserve(INTENT);

    await store.forget(reserved.idempotencyKey);

    expect(await store.find(INTENT)).toBeUndefined();
    expect((await store.reserve(INTENT)).replayed).toBe(false);
  });
});

describe('the file store', () => {
  it('replays the same key to a NEW store over the same file', async () => {
    // The whole point. A key that only survives inside one object survives
    // nothing that matters — the process going away is the failure it exists for.
    const first = await createFileIntentStore(ledger).reserve(INTENT);
    const second = await createFileIntentStore(ledger).reserve(INTENT);

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.replayed).toBe(true);
  });

  it('creates the directory it was pointed at', async () => {
    await createFileIntentStore(ledger).reserve(INTENT);

    expect(JSON.parse(readFileSync(ledger, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('leaves no temporary file behind', async () => {
    const store = createFileIntentStore(ledger);
    await store.reserve(INTENT);
    await store.settle((await store.reserve(INTENT)).idempotencyKey, 'FILLED');

    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(directory, 'nested')).filter((n) => n.includes('intent-tmp'))).toEqual(
      [],
    );
  });

  it('refuses to start a new ledger over one it cannot parse', async () => {
    // Starting fresh here discards keys for orders that may be in flight, and
    // the next attempt is then free to place a second one. A person has to look.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(directory, 'nested'), { recursive: true });
    writeFileSync(ledger, '{ this is not json');

    await expect(createFileIntentStore(ledger).reserve(INTENT)).rejects.toThrow(
      /not readable JSON/u,
    );
    // And it did not overwrite it on the way out.
    expect(readFileSync(ledger, 'utf8')).toBe('{ this is not json');
  });

  it('reads an empty file location as an empty ledger, not as an error', async () => {
    await expect(createFileIntentStore(ledger).pending()).resolves.toEqual([]);
  });
});

/**
 * The lock, which is the part an atomic rename does not cover.
 *
 * A torn file and a lost update are different failures. Rewriting atomically
 * fixes the first; only exclusion fixes the second, and the second is the one
 * that ends with two orders — two runs read a ledger with no record, each mints
 * a key, each writes over the other.
 *
 * Two independent store objects stand in for two processes throughout. That is
 * not a shortcut: the lock is an `O_EXCL` file, and a file does not know or care
 * which process opened it. What makes each store a separate party is that they
 * share no queue and no map — exactly what two processes share.
 */
describe('the ledger lock', () => {
  const lockPath = (): string => `${ledger}.lock`;

  /** A lock file written by somebody else, on this host, with a given token. */
  const holdForeignLock = (token = 'theirs', pid = 999_999): void => {
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(
      lockPath(),
      JSON.stringify({ host: hostname(), pid, token, at: '2026-09-03T00:00:00.000Z' }),
    );
  };

  it('gives one key to two stores racing for the same intent', async () => {
    const a = createFileIntentStore(ledger);
    const b = createFileIntentStore(ledger);

    const [first, second] = await Promise.all([a.reserve(INTENT), b.reserve(INTENT)]);

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
  });

  it('loses no reservation when two stores write different intents at once', async () => {
    // The lost-update failure in its purest form: both read an empty ledger,
    // both write, and whichever lands second erases the other's key.
    const stores = Array.from({ length: 6 }, () => createFileIntentStore(ledger));

    await Promise.all(
      stores.map(async (store, index) =>
        await store.reserve({ ...INTENT, clientOrderId: `order-${String(index)}` }),
      ),
    );

    expect(await createFileIntentStore(ledger).pending()).toHaveLength(6);
  });

  it('releases the lock even when the section throws', async () => {
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, '{ not json');
    const store = createFileIntentStore(ledger);

    await expect(store.reserve(INTENT)).rejects.toThrow(/not readable JSON/u);

    expect(existsSync(lockPath())).toBe(false);
  });

  it('refuses rather than proceeding unlocked when a LIVE holder has it', async () => {
    // The important half is the second assertion. Timing out and then writing
    // anyway would be worse than not locking at all: it would look safe and
    // behave exactly as no lock does.
    holdForeignLock();
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 60,
      isHolderAlive: () => true,
    });

    await expect(store.reserve(INTENT)).rejects.toThrow(/refuses rather than proceeding/u);
    expect(existsSync(ledger)).toBe(false);
  });

  it('never takes a lock from a holder that is merely slow', async () => {
    // The bug this replaced: a lock older than a timeout was taken on the
    // reasoning that the section is short. A paused holder then resumes into a
    // section somebody else owns. Age is not evidence of death.
    holdForeignLock();
    const ancient = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(lockPath(), ancient, ancient);
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 60,
      isHolderAlive: () => true,
    });

    await expect(store.reserve(INTENT)).rejects.toThrow(/refuses rather than proceeding/u);
  });

  it('takes a lock whose holder is gone, however recently it was taken', async () => {
    // A process killed mid-section must not wedge every later one — and the
    // question that settles it is whether the holder exists, not how long ago
    // it started.
    holdForeignLock();
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 200,
      isHolderAlive: () => false,
    });

    const reserved = await store.reserve(INTENT);

    expect(reserved.idempotencyKey).toBeTypeOf('string');
    expect(existsSync(lockPath())).toBe(false);
  });

  it('refuses to judge a holder on another host rather than guessing', async () => {
    // A pid on another machine says nothing about this one, so there is no
    // liveness signal and the only safe answer is to wait and then refuse.
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(
      lockPath(),
      JSON.stringify({ host: 'some-other-box', pid: 1, token: 'theirs', at: 'earlier' }),
    );
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 60,
      // Would say "dead" if it were ever asked. It must not be.
      isHolderAlive: () => false,
    });

    await expect(store.reserve(INTENT)).rejects.toThrow(/some-other-box/u);
  });

  it('leaves a lock it refused exactly as it found it', async () => {
    // The amplification in the version this replaced: a caller that gave up, or
    // one that resumed after being stolen from, removed a lock that was no
    // longer its own — letting a third walk in on top of a live section. A
    // release only ever removes a lock whose token still matches.
    holdForeignLock('someone-elses', 4242);
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 60,
      isHolderAlive: () => true,
    });

    await expect(store.reserve(INTENT)).rejects.toThrow(/refuses rather than proceeding/u);

    const holder = JSON.parse(readFileSync(lockPath(), 'utf8')) as { token: string; pid: number };
    expect(holder.token).toBe('someone-elses');
    expect(holder.pid).toBe(4242);
  });

  it('names the holder in the refusal, so a person can go and look', async () => {
    holdForeignLock('someone-elses', 4242);
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 60,
      isHolderAlive: () => true,
    });

    await expect(store.reserve(INTENT)).rejects.toThrow(/pid 4242/u);
  });

  it('leaves no lock behind on the ordinary path', async () => {
    const store = createFileIntentStore(ledger);
    const reserved = await store.reserve(INTENT);
    await store.settle(reserved.idempotencyKey, 'FILLED');

    expect(existsSync(lockPath())).toBe(false);
  });
});
