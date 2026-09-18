/**
 * A Sui transaction's digest, computed here from the bytes about to be signed.
 *
 * Why it exists: in direct mode the backend returns the bytes AND their digest,
 * and every later step — the journal record written before submission, the
 * chain read that settles an ambiguous answer, `/sponsor/execute` itself — is
 * keyed by that digest. Taking it on trust would let a wrong one steer a
 * reconciliation to someone else's transaction. So it is recomputed from the
 * verified bytes, and a mismatch stops the order before anything is signed.
 *
 * Sui defines it as `base58(blake2b-256("TransactionData::" ‖ bcs))`. Node's
 * OpenSSL only offers BLAKE2b-512, whose output is not a prefix of the 256-bit
 * variant, so BLAKE2b is implemented here (RFC 7693) — dependency-free, like
 * the decoder beside it, and held to `@mysten/sui` in the tests.
 */

const MASK = (1n << 64n) - 1n;

const IV: readonly bigint[] = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & MASK;

function compress(h: bigint[], block: Uint8Array, counter: bigint, last: boolean): void {
  const view = new DataView(block.buffer, block.byteOffset, 128);
  const m: bigint[] = [];
  for (let i = 0; i < 16; i += 1) m.push(view.getBigUint64(i * 8, true));
  const v = [...h, ...IV];
  v[12] = v[12]! ^ (counter & MASK);
  v[13] = v[13]! ^ (counter >> 64n);
  if (last) v[14] = v[14]! ^ MASK;

  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
    v[a] = (v[a]! + v[b]! + x) & MASK;
    v[d] = rotr(v[d]! ^ v[a]!, 32n);
    v[c] = (v[c]! + v[d]!) & MASK;
    v[b] = rotr(v[b]! ^ v[c]!, 24n);
    v[a] = (v[a]! + v[b]! + y) & MASK;
    v[d] = rotr(v[d]! ^ v[a]!, 16n);
    v[c] = (v[c]! + v[d]!) & MASK;
    v[b] = rotr(v[b]! ^ v[c]!, 63n);
  };

  for (let round = 0; round < 12; round += 1) {
    const s = SIGMA[round % 10]!;
    g(0, 4, 8, 12, m[s[0]!]!, m[s[1]!]!);
    g(1, 5, 9, 13, m[s[2]!]!, m[s[3]!]!);
    g(2, 6, 10, 14, m[s[4]!]!, m[s[5]!]!);
    g(3, 7, 11, 15, m[s[6]!]!, m[s[7]!]!);
    g(0, 5, 10, 15, m[s[8]!]!, m[s[9]!]!);
    g(1, 6, 11, 12, m[s[10]!]!, m[s[11]!]!);
    g(2, 7, 8, 13, m[s[12]!]!, m[s[13]!]!);
    g(3, 4, 9, 14, m[s[14]!]!, m[s[15]!]!);
  }
  for (let i = 0; i < 8; i += 1) h[i] = h[i]! ^ v[i]! ^ v[i + 8]!;
}

/** Unkeyed BLAKE2b with an `outLength`-byte digest (1–64). */
export function blake2b(input: Uint8Array, outLength = 32): Uint8Array {
  if (!Number.isInteger(outLength) || outLength < 1 || outLength > 64) {
    throw new RangeError('blake2b output length must be 1–64 bytes');
  }
  const h = [...IV];
  h[0] = h[0]! ^ (0x01010000n | BigInt(outLength));

  const block = new Uint8Array(128);
  let counter = 0n;
  let offset = 0;
  // Every full block but the last is compressed as not-final; the last block —
  // full or partial, and an empty input's single zero block — is final.
  while (input.length - offset > 128) {
    block.set(input.subarray(offset, offset + 128));
    counter += 128n;
    compress(h, block, counter, false);
    offset += 128;
  }
  block.fill(0);
  block.set(input.subarray(offset));
  counter += BigInt(input.length - offset);
  compress(h, block, counter, true);

  const out = new Uint8Array(64);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) view.setBigUint64(i * 8, h[i]!, true);
  return out.slice(0, outLength);
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function toBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)]! + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const PREFIX = new TextEncoder().encode('TransactionData::');

/** The digest Sui assigns to these `TransactionData` bytes. */
export function suiTransactionDigest(transactionBytes: Uint8Array): string {
  const material = new Uint8Array(PREFIX.length + transactionBytes.length);
  material.set(PREFIX);
  material.set(transactionBytes, PREFIX.length);
  return toBase58(blake2b(material, 32));
}
