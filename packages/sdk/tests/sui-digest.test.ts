/**
 * The digest a direct-mode order is journaled and reconciled under, computed
 * locally. Held to three authorities: the RFC 7693 vector, Node's own
 * BLAKE2b-512 at every block-boundary length, and `@mysten/sui`'s digest of
 * real order bytes.
 */
import { createHash, randomBytes } from 'node:crypto';

import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { describe, expect, it } from 'vitest';

import { blake2b, suiTransactionDigest, toBase58 } from '../src/sui-digest.ts';
import { normalizeSuiAddress } from '../src/sui-tx.ts';
import { buildPlace, deployment } from './direct-fixtures.ts';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('blake2b', () => {
  it('matches the RFC 7693 test vector', () => {
    expect(hex(blake2b(new TextEncoder().encode('abc'), 64))).toBe(
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    );
  });

  it('matches Node’s BLAKE2b-512 across block boundaries', () => {
    for (const length of [0, 1, 63, 64, 127, 128, 129, 255, 256, 257, 1_000, 4_096]) {
      const input = randomBytes(length);
      expect(hex(blake2b(input, 64)), `length ${String(length)}`).toBe(
        createHash('blake2b512').update(input).digest('hex'),
      );
    }
  });

  it('refuses an output length BLAKE2b does not define', () => {
    expect(() => blake2b(new Uint8Array(), 0)).toThrow(RangeError);
    expect(() => blake2b(new Uint8Array(), 65)).toThrow(RangeError);
  });
});

describe('suiTransactionDigest', () => {
  it('agrees with @mysten/sui on real order bytes', async () => {
    const bytes = await buildPlace(
      {
        accountId: normalizeSuiAddress(`0x${'c'.repeat(64)}`),
        marketId: normalizeSuiAddress(`0x${'2'.repeat(64)}`),
        selection: 'YES',
        maxSpend: 5_000_000n,
        minShares: 11_512_779n,
        priceCapBps: 4_343n,
        expiryTs: 1_800_000_000_000n,
      },
      normalizeSuiAddress(`0x${'a'.repeat(64)}`),
    );
    expect(suiTransactionDigest(bytes)).toBe(TransactionDataBuilder.getDigestFromBytes(bytes));
    expect(deployment.network).toBe('mainnet');
  });

  it('keeps leading zero bytes as leading ones', () => {
    expect(toBase58(Uint8Array.from([0, 0, 1]))).toBe('112');
  });
});
