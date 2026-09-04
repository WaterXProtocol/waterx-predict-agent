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

/** Canonical shapes: a full Sui address, a real outcome, one size unit. */
const ACCOUNT = `0x${'10'.repeat(32)}`;
const MARKET = `0x${'22'.repeat(32)}`;

const INTENT = {
  accountId: ACCOUNT,
  marketId: MARKET,
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
      { accountId: `0x${'99'.repeat(32)}` },
      { marketId: `0x${'88'.repeat(32)}` },
      { outcomeId: 'NO' },
      { side: 'SELL', size: { sellShares: '5' }, positionId: '1145' },
      { size: { buyAmount: '6' } },
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

  it('refuses to attach an execution another intent already claims', async () => {
    // The load-time check alone let the duplicate be WRITTEN and discovered on
    // the next open — which failed the whole ledger. Recovery becoming
    // unreadable at the moment it is needed is the worst available outcome, and
    // it was self-inflicted.
    const store = make();
    const first = await store.reserve(INTENT);
    const second = await store.reserve({ ...INTENT, clientOrderId: 'second' });

    await store.attach(first.idempotencyKey, 'exec-1', '0.5');

    await expect(store.attach(second.idempotencyKey, 'exec-1', '0.5')).rejects.toThrow(
      /already recorded against a different intent/u,
    );
    // Nothing was written, so the ledger still opens.
    const pending = await store.pending();
    expect(pending).toHaveLength(2);
    expect(pending.filter((entry) => entry.executionId === 'exec-1')).toHaveLength(1);
  });

  it('lets the SAME intent re-attach the execution it already has', async () => {
    const store = make();
    const reserved = await store.reserve(INTENT);

    await store.attach(reserved.idempotencyKey, 'exec-1', '0.5');
    await expect(store.attach(reserved.idempotencyKey, 'exec-1', '0.5')).resolves.toBeUndefined();
  });

  it('refuses an execution id the API could not accept', async () => {
    const store = make();
    const reserved = await store.reserve(INTENT);

    await expect(store.attach(reserved.idempotencyKey, '', '0.5')).rejects.toThrow(TypeError);
    expect((await store.pending())[0]?.executionId).toBeUndefined();
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

  it('refuses a record it cannot read, rather than skipping it', async () => {
    // Skipping is the dangerous half. A record this cannot read may be the one
    // naming an order that exists, and dropping it frees the next attempt to
    // mint a new key — while the reader that reaches for `intent.size` takes the
    // recovery path down on a property access at the worst possible moment.
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        intents: {
          abc: { idempotencyKey: 'k', status: 'PENDING', createdAt: 'now' }, // no `intent`
        },
      }),
    );

    await expect(createFileIntentStore(ledger).pending()).rejects.toThrow(/`intent` is missing/u);
  });

  it('names the record and the field, so a person can go and fix it', async () => {
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        intents: { deadbeef: { idempotencyKey: 'k', intent: {}, createdAt: 'now', status: 'MAYBE' } },
      }),
    );

    await expect(createFileIntentStore(ledger).pending()).rejects.toThrow(/deadbeef/u);
    await expect(createFileIntentStore(ledger).pending()).rejects.toThrow(/`status`/u);
  });

  it('refuses a record filed under a key its own intent does not hash to', async () => {
    // The reproduction that mattered: put a real record under a wrong digest and
    // `reserve` finds nothing for that intent, mints a SECOND key, and places a
    // second order — while the first key, and possibly a live execution, sit
    // under a name nothing looks up. The index is the content, so a record has
    // to hash to where it is filed.
    const store = createFileIntentStore(ledger);
    const { idempotencyKey } = await store.reserve(INTENT);

    const document = JSON.parse(readFileSync(ledger, 'utf8')) as {
      intents: Record<string, unknown>;
    };
    const [rightDigest] = Object.keys(document.intents);
    document.intents = { wrong0000: document.intents[String(rightDigest)] };
    writeFileSync(ledger, JSON.stringify(document));

    // Caught by the three-way check first, which is the more precise answer: the
    // record still carries the digest it was written with, and it no longer
    // matches where the record sits.
    await expect(createFileIntentStore(ledger).reserve(INTENT)).rejects.toThrow(
      /filed under wrong0000/u,
    );
    expect(idempotencyKey).toBeTypeOf('string');
    expect(rightDigest).toBeTypeOf('string');
  });

  it('will not say which side of a digest mismatch is the right one', async () => {
    // The message used to call the stored intent intact and name the digest it
    // "belongs under". A mismatch proves the key and the intent disagree; it
    // proves nothing about which of them changed. If the INTENT is what was
    // damaged, re-filing under the computed digest attaches this record's key —
    // and the execution it names — to an order it was never minted for.
    const store = createFileIntentStore(ledger);
    await store.reserve(INTENT);

    const document = JSON.parse(readFileSync(ledger, 'utf8')) as {
      intents: Record<string, { digest: string; intent: Record<string, unknown> }>;
    };
    const [key] = Object.keys(document.intents);
    // Damage the INTENT, and keep the record internally consistent, so only the
    // key-versus-content check can see it.
    const record = document.intents[String(key)];
    if (record !== undefined) record.intent = { ...record.intent, marketId: '0xsomewhere-else' };
    writeFileSync(ledger, JSON.stringify(document));

    const failing = createFileIntentStore(ledger);
    await expect(failing.pending()).rejects.toThrow(/cannot tell which/u);
    await expect(failing.pending()).rejects.not.toThrow(/belongs under/u);
    // It points at the evidence instead: what the server says happened.
    await expect(failing.pending()).rejects.toThrow(/to establish what actually happened/u);
  });

  it('refuses a file with no `intents`, rather than reading it as empty', async () => {
    // "Absent means empty" mints a fresh key for every intent the file was
    // holding one for. An empty ledger is a file that does not EXIST.
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, JSON.stringify({ version: 1 }));

    await expect(createFileIntentStore(ledger).pending()).rejects.toThrow(/no `intents` object/u);
  });

  it('refuses a version it does not read', async () => {
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, JSON.stringify({ version: 2, intents: {} }));

    await expect(createFileIntentStore(ledger).pending()).rejects.toThrow(/version 2/u);
  });

  it('refuses a root that is not an object', async () => {
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, JSON.stringify([]));

    await expect(createFileIntentStore(ledger).pending()).rejects.toThrow(/root is not an object/u);
  });

  it('refuses an empty intent even when it is filed under its OWN digest', async () => {
    // Self-consistent and still useless. The digest check cannot see this — the
    // record hashes exactly to where it sits — and a PENDING record whose intent
    // cannot be re-sent is a key held against a write nothing can finish.
    const digest = intentDigest({});
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        intents: {
          [digest]: { idempotencyKey: 'k', digest, intent: {}, status: 'PENDING', createdAt: 'now' },
        },
      }),
    );

    await expect(createFileIntentStore(ledger).pending()).rejects.toThrow(/could not be re-sent/u);
    await expect(createFileIntentStore(ledger).pending()).rejects.toThrow(
      /`accountId` is not a full 0x-prefixed Sui address/u,
    );
  });

  it('refuses an intent the canonical order rules would reject', async () => {
    for (const [field, broken] of [
      ['marketId', { ...INTENT, marketId: undefined }],
      ['side', { ...INTENT, side: 'MAYBE' }],
      ['outcomeId', { ...INTENT, outcomeId: 'MAYBE' }],
      ['accountId', { ...INTENT, accountId: '0xacct' }],
      ['maxSlippageBps', { ...INTENT, maxSlippageBps: '100' }],
      ['maxSlippageBps', { ...INTENT, maxSlippageBps: 0.5 }],
      ['maxSlippageBps', { ...INTENT, maxSlippageBps: 10_000 }],
      ['maxSlippageBps', { ...INTENT, maxSlippageBps: -1 }],
      ['size', { ...INTENT, size: {} }],
      ['size', { ...INTENT, size: { buyAmount: '5', sellShares: '5' } }],
      ['size', { ...INTENT, size: { sellShares: '5' } }],
      ['size', { ...INTENT, size: { buyAmount: 'not-a-decimal' } }],
      ['size', { ...INTENT, size: { buyAmount: '0' } }],
      ['size', { ...INTENT, size: { buyAmount: '-1' } }],
      ['size', { ...INTENT, size: { buyAmount: '1e3' } }],
      ['size', { ...INTENT, size: { buyAmount: '0.1234567' } }],
      ['positionId', { ...INTENT, positionId: 7 }],
      ['positionId', { ...INTENT, positionId: '1145' }],
      ['worstAcceptablePrice', { ...INTENT, worstAcceptablePrice: '2.0' }],
      ['clientOrderId', { ...INTENT, clientOrderId: '' }],
    ] as const) {
      const intent = Object.fromEntries(
        Object.entries(broken).filter(([, value]) => value !== undefined),
      );
      mkdirSync(dirname(ledger), { recursive: true });
      writeFileSync(
        ledger,
        JSON.stringify({
          version: 1,
          intents: {
            [intentDigest(intent)]: {
              idempotencyKey: 'k',
              digest: intentDigest(intent),
              intent,
              status: 'PENDING',
              createdAt: 'now',
            },
          },
        }),
      );

      await expect(createFileIntentStore(ledger).pending(), field).rejects.toThrow(
        /could not be re-sent/u,
      );
    }
  });

  it('refuses to reserve a key for an intent it could not re-send', async () => {
    // At the door, rather than at the one moment the record had to work. A
    // record that holds a key and cannot finish its write is worse than none.
    const store = createFileIntentStore(ledger);
    const { marketId: _dropped, ...withoutMarket } = INTENT;

    await expect(store.reserve(withoutMarket)).rejects.toThrow(TypeError);
    await expect(store.reserve(withoutMarket)).rejects.toThrow(/`marketId` is not a string/u);
    expect(existsSync(ledger)).toBe(false);
  });

  it('refuses two records that share one idempotency key', async () => {
    // Different intents replaying one key: the server sends the second to the
    // first's execution, or swallows the trade that was actually asked for.
    const other = { ...INTENT, clientOrderId: 'second' };
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        intents: {
          [intentDigest(INTENT)]: {
            idempotencyKey: 'shared',
            digest: intentDigest(INTENT),
            intent: INTENT,
            status: 'PENDING',
            createdAt: 'now',
          },
          [intentDigest(other)]: {
            idempotencyKey: 'shared',
            digest: intentDigest(other),
            intent: other,
            status: 'PENDING',
            createdAt: 'now',
          },
        },
      }),
    );

    await expect(createFileIntentStore(ledger).pending()).rejects.toThrow(
      /one idempotency key on two records/u,
    );
  });

  it('refuses a record whose recorded digest disagrees with its key', async () => {
    // Three names for one thing. Silently preferring either would decide which
    // is right on no evidence.
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        intents: {
          [intentDigest(INTENT)]: {
            idempotencyKey: 'k',
            digest: 'something-else',
            intent: INTENT,
            status: 'PENDING',
            createdAt: 'now',
          },
        },
      }),
    );

    await expect(createFileIntentStore(ledger).pending()).rejects.toThrow(
      /records its own digest as something-else/u,
    );
  });

  it('round-trips a ledger it wrote itself', async () => {
    // The checks above are only worth having if the normal path satisfies them,
    // and the digest check is the one that would bite if `normalizeIntent` were
    // not idempotent.
    const store = createFileIntentStore(ledger);
    const first = await store.reserve(INTENT);
    await store.attach(first.idempotencyKey, 'exec-1', '0.5');

    const reopened = await createFileIntentStore(ledger).reserve(INTENT);

    expect(reopened.replayed).toBe(true);
    expect(reopened.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('refuses a record whose optional strings are present but empty', async () => {
    for (const field of ['executionId', 'enforcedWorstPrice', 'settledAt', 'outcome'] as const) {
      mkdirSync(dirname(ledger), { recursive: true });
      writeFileSync(
        ledger,
        JSON.stringify({
          version: 1,
          intents: {
            [intentDigest(INTENT)]: {
              idempotencyKey: 'k',
              digest: intentDigest(INTENT),
              intent: INTENT,
              status: 'PENDING',
              createdAt: 'now',
              [field]: '',
            },
          },
        }),
      );

      await expect(createFileIntentStore(ledger).pending(), field).rejects.toThrow(
        new RegExp(`\`${field}\``, 'u'),
      );
    }
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

  it('refuses rather than proceeding unlocked when a holder has it', async () => {
    // The important half is the second assertion. Timing out and then writing
    // anyway would be worse than not locking at all: it would look safe and
    // behave exactly as no lock does.
    holdForeignLock();
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 60,
      isHolderAlive: () => true,
    });

    await expect(store.reserve(INTENT)).rejects.toThrow(/Nothing here removes a lock/u);
    expect(existsSync(ledger)).toBe(false);
  });

  it('never takes a lock from a holder that is merely old', async () => {
    // The first version took a lock older than a timeout, reasoning that the
    // section is short. Age is not evidence of anything.
    holdForeignLock();
    const ancient = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(lockPath(), ancient, ancient);
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 60,
      isHolderAlive: () => true,
    });

    await expect(store.reserve(INTENT)).rejects.toThrow(/Nothing here removes a lock/u);
  });

  it('does not remove a lock whose holder is provably dead, either', async () => {
    // The version this replaced did, having checked liveness first — and that
    // is still unsound, for a reason that is not about liveness at all. `unlink`
    // then `open(O_EXCL)` is two steps: two callers read the same dead lock, the
    // first clears it and creates its own, and the second deletes THAT one and
    // creates a third. Both then run. No takeover, so no race.
    holdForeignLock('theirs', 4242);
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 60,
      isHolderAlive: () => false,
    });

    await expect(store.reserve(INTENT)).rejects.toThrow(/Nothing here removes a lock/u);
    expect(existsSync(lockPath()), 'removed a lock it did not create').toBe(true);
    expect(existsSync(ledger)).toBe(false);
  });

  it('says the lock is safe to remove when the holder is gone', async () => {
    holdForeignLock('theirs', 4242);
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 60,
      isHolderAlive: () => false,
    });

    await expect(store.reserve(INTENT)).rejects.toThrow(/is NOT running, so the lock is safe/u);
  });

  it('says the opposite when the holder is still running', async () => {
    holdForeignLock('theirs', 4242);
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 60,
      isHolderAlive: () => true,
    });

    await expect(store.reserve(INTENT)).rejects.toThrow(/IS still running, so do not remove/u);
  });

  it('will not claim to know about a holder on another host', async () => {
    // A pid on another machine says nothing about this one, so there is no
    // liveness answer to give — and none is invented.
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(
      lockPath(),
      JSON.stringify({ host: 'some-other-box', pid: 1, token: 'theirs', at: 'earlier' }),
    );
    const store = createFileIntentStore(ledger, {
      lockTimeoutMs: 60,
      // Would answer if it were ever asked. It must not be.
      isHolderAlive: () => false,
    });

    await expect(store.reserve(INTENT)).rejects.toThrow(/cannot be checked from here/u);
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

    await expect(store.reserve(INTENT)).rejects.toThrow(/Nothing here removes a lock/u);

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
