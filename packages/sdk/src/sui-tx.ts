/**
 * Read a Sui `TransactionData` from its BCS bytes, without the Sui SDK.
 *
 * WHY THIS EXISTS. In direct mode (ADR-0013) the bytes this agent signs are
 * built by a public WaterX endpoint that asks nothing of the caller. Signing
 * them unread would make the backend — or anything able to alter its response —
 * the author of every order. So the bytes are decoded here and checked against
 * the intent formed locally before the request left (`direct-verify.ts`).
 *
 * WHY NOT `@mysten/sui`. This package allows one runtime dependency and the CLI
 * must never load the Sui SDK (it is the dependency that CLI's budget exists to
 * keep out). The subset needed to READ a programmable transaction is small and
 * stable, so it is written out here and held byte-for-byte to `@mysten/sui`'s own
 * encoder by the test suite, which builds real transactions with it.
 *
 * WHAT IT READS. `TransactionData::V1` whose kind is `ProgrammableTransaction`,
 * and nothing else: every other kind is a system transaction no agent signs, and
 * is refused rather than skipped. Unknown enum tags are refused too — a decoder
 * that guessed at a layout it does not know would be reading something other
 * than what gets executed.
 */

export class SuiTransactionDecodeError extends Error {
  override readonly name = 'SuiTransactionDecodeError';
}

export type SuiArgument =
  | { readonly kind: 'GasCoin' }
  | { readonly kind: 'Input'; readonly index: number }
  | { readonly kind: 'Result'; readonly index: number }
  | { readonly kind: 'NestedResult'; readonly index: number; readonly result: number };

export type SuiTypeTag =
  | { readonly kind: 'bool' | 'u8' | 'u16' | 'u32' | 'u64' | 'u128' | 'u256' | 'address' | 'signer' }
  | { readonly kind: 'vector'; readonly of: SuiTypeTag }
  | {
      readonly kind: 'struct';
      readonly address: string;
      readonly module: string;
      readonly name: string;
      readonly typeParams: readonly SuiTypeTag[];
    };

export interface SuiObjectRef {
  readonly objectId: string;
  readonly version: bigint;
  /** 32 bytes, hex. */
  readonly digest: string;
}

export type SuiCallArg =
  | { readonly kind: 'Pure'; readonly bytes: Uint8Array }
  | { readonly kind: 'ImmOrOwnedObject'; readonly ref: SuiObjectRef }
  | {
      readonly kind: 'SharedObject';
      readonly objectId: string;
      readonly initialSharedVersion: bigint;
      readonly mutable: boolean;
    }
  | { readonly kind: 'Receiving'; readonly ref: SuiObjectRef }
  | {
      readonly kind: 'FundsWithdrawal';
      readonly maxAmount: bigint;
      readonly typeArg: SuiTypeTag;
      readonly from: 'Sender' | 'Sponsor';
    };

export type SuiCommand =
  | {
      readonly kind: 'MoveCall';
      readonly package: string;
      readonly module: string;
      readonly function: string;
      readonly typeArguments: readonly SuiTypeTag[];
      readonly arguments: readonly SuiArgument[];
    }
  | { readonly kind: 'TransferObjects'; readonly objects: readonly SuiArgument[]; readonly address: SuiArgument }
  | { readonly kind: 'SplitCoins'; readonly coin: SuiArgument; readonly amounts: readonly SuiArgument[] }
  | { readonly kind: 'MergeCoins'; readonly destination: SuiArgument; readonly sources: readonly SuiArgument[] }
  | { readonly kind: 'Publish' }
  | { readonly kind: 'MakeMoveVec'; readonly type: SuiTypeTag | null; readonly elements: readonly SuiArgument[] }
  | { readonly kind: 'Upgrade' };

export interface SuiGasData {
  readonly payment: readonly SuiObjectRef[];
  readonly owner: string;
  readonly price: bigint;
  readonly budget: bigint;
}

export type SuiExpiration =
  | { readonly kind: 'None' }
  | { readonly kind: 'Epoch'; readonly epoch: bigint }
  | { readonly kind: 'ValidDuring' };

export interface SuiTransaction {
  readonly sender: string;
  readonly gasData: SuiGasData;
  readonly expiration: SuiExpiration;
  readonly inputs: readonly SuiCallArg[];
  readonly commands: readonly SuiCommand[];
}

/* ── The reader ──────────────────────────────────────────────────────────── */

const HEX = '0123456789abcdef';

const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
};

/** A normalized Sui address: `0x` + 64 lowercase hex digits. */
export const normalizeSuiAddress = (address: string): string => {
  const bare = address.toLowerCase().replace(/^0x/u, '');
  if (!/^[0-9a-f]{1,64}$/u.test(bare)) throw new SuiTransactionDecodeError(`not a Sui address: ${address}`);
  return `0x${bare.padStart(64, '0')}`;
};

class Reader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  private take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new SuiTransactionDecodeError(`truncated: wanted ${String(length)} bytes at ${String(this.offset)}`);
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  u16(): number {
    const b = this.take(2);
    return b[0]! | (b[1]! << 8);
  }

  u32(): number {
    const b = this.take(4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16)) + b[3]! * 0x1000000;
  }

  u64(): bigint {
    const b = this.take(8);
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(b[i]!);
    return value;
  }

  bool(): boolean {
    const value = this.u8();
    if (value > 1) throw new SuiTransactionDecodeError(`not a bool: ${String(value)}`);
    return value === 1;
  }

  /** ULEB128, capped at u32 as BCS lengths and enum tags are. */
  uleb(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new SuiTransactionDecodeError('ULEB128 length exceeds u32');
    }
    return value;
  }

  bytesWithLength(): Uint8Array {
    return this.take(this.uleb()).slice();
  }

  string(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.bytesWithLength());
  }

  address(): string {
    return `0x${toHex(this.take(32))}`;
  }

  vector<T>(item: () => T): T[] {
    const length = this.uleb();
    const out: T[] = [];
    for (let i = 0; i < length; i += 1) out.push(item());
    return out;
  }

  option<T>(item: () => T): T | null {
    const tag = this.uleb();
    if (tag === 0) return null;
    if (tag === 1) return item();
    throw new SuiTransactionDecodeError(`bad Option tag ${String(tag)}`);
  }
}

const unknownTag = (what: string, tag: number): never => {
  throw new SuiTransactionDecodeError(`unknown ${what} variant ${String(tag)}`);
};

function readObjectRef(r: Reader): SuiObjectRef {
  const objectId = r.address();
  const version = r.u64();
  const digest = r.bytesWithLength();
  if (digest.length !== 32) throw new SuiTransactionDecodeError('object digest is not 32 bytes');
  return { objectId, version, digest: toHex(digest) };
}

function readTypeTag(r: Reader, depth = 0): SuiTypeTag {
  if (depth > 16) throw new SuiTransactionDecodeError('type tag nested too deeply');
  const tag = r.uleb();
  switch (tag) {
    case 0: return { kind: 'bool' };
    case 1: return { kind: 'u8' };
    case 2: return { kind: 'u64' };
    case 3: return { kind: 'u128' };
    case 4: return { kind: 'address' };
    case 5: return { kind: 'signer' };
    case 6: return { kind: 'vector', of: readTypeTag(r, depth + 1) };
    case 7: {
      const address = r.address();
      const module = r.string();
      const name = r.string();
      const typeParams = r.vector(() => readTypeTag(r, depth + 1));
      return { kind: 'struct', address, module, name, typeParams };
    }
    case 8: return { kind: 'u16' };
    case 9: return { kind: 'u32' };
    case 10: return { kind: 'u256' };
    default: return unknownTag('TypeTag', tag);
  }
}

function readCallArg(r: Reader): SuiCallArg {
  const tag = r.uleb();
  if (tag === 0) return { kind: 'Pure', bytes: r.bytesWithLength() };
  if (tag === 1) {
    const objectTag = r.uleb();
    if (objectTag === 0) return { kind: 'ImmOrOwnedObject', ref: readObjectRef(r) };
    if (objectTag === 1) {
      return {
        kind: 'SharedObject',
        objectId: r.address(),
        initialSharedVersion: r.u64(),
        mutable: r.bool(),
      };
    }
    if (objectTag === 2) return { kind: 'Receiving', ref: readObjectRef(r) };
    return unknownTag('ObjectArg', objectTag);
  }
  if (tag === 2) {
    const reservation = r.uleb();
    if (reservation !== 0) unknownTag('Reservation', reservation);
    const maxAmount = r.u64();
    const withdrawal = r.uleb();
    if (withdrawal !== 0) unknownTag('WithdrawalType', withdrawal);
    const typeArg = readTypeTag(r);
    const from = r.uleb();
    if (from > 1) unknownTag('WithdrawFrom', from);
    return { kind: 'FundsWithdrawal', maxAmount, typeArg, from: from === 0 ? 'Sender' : 'Sponsor' };
  }
  return unknownTag('CallArg', tag);
}

function readArgument(r: Reader): SuiArgument {
  const tag = r.uleb();
  switch (tag) {
    case 0: return { kind: 'GasCoin' };
    case 1: return { kind: 'Input', index: r.u16() };
    case 2: return { kind: 'Result', index: r.u16() };
    case 3: return { kind: 'NestedResult', index: r.u16(), result: r.u16() };
    default: return unknownTag('Argument', tag);
  }
}

function readCommand(r: Reader): SuiCommand {
  const tag = r.uleb();
  switch (tag) {
    case 0: {
      const pkg = r.address();
      const module = r.string();
      const fn = r.string();
      const typeArguments = r.vector(() => readTypeTag(r));
      const args = r.vector(() => readArgument(r));
      return { kind: 'MoveCall', package: pkg, module, function: fn, typeArguments, arguments: args };
    }
    case 1: {
      const objects = r.vector(() => readArgument(r));
      return { kind: 'TransferObjects', objects, address: readArgument(r) };
    }
    case 2: {
      const coin = readArgument(r);
      return { kind: 'SplitCoins', coin, amounts: r.vector(() => readArgument(r)) };
    }
    case 3: {
      const destination = readArgument(r);
      return { kind: 'MergeCoins', destination, sources: r.vector(() => readArgument(r)) };
    }
    case 4: {
      r.vector(() => r.bytesWithLength());
      r.vector(() => r.address());
      return { kind: 'Publish' };
    }
    case 5: {
      const type = r.option(() => readTypeTag(r));
      return { kind: 'MakeMoveVec', type, elements: r.vector(() => readArgument(r)) };
    }
    case 6: {
      r.vector(() => r.bytesWithLength());
      r.vector(() => r.address());
      r.address();
      readArgument(r);
      return { kind: 'Upgrade' };
    }
    default:
      return unknownTag('Command', tag);
  }
}

function readExpiration(r: Reader): SuiExpiration {
  const tag = r.uleb();
  if (tag === 0) return { kind: 'None' };
  if (tag === 1) return { kind: 'Epoch', epoch: r.u64() };
  if (tag === 2) {
    for (let i = 0; i < 4; i += 1) r.option(() => r.u64());
    r.bytesWithLength();
    r.u32();
    return { kind: 'ValidDuring' };
  }
  return unknownTag('TransactionExpiration', tag);
}

/** Decode `TransactionData` BCS bytes. Throws on anything but a V1 programmable transaction. */
export function decodeSuiTransaction(bytes: Uint8Array): SuiTransaction {
  const r = new Reader(bytes);
  const version = r.uleb();
  if (version !== 0) unknownTag('TransactionData', version);
  const kind = r.uleb();
  if (kind !== 0) {
    throw new SuiTransactionDecodeError(`transaction kind ${String(kind)} is not a programmable transaction`);
  }
  const inputs = r.vector(() => readCallArg(r));
  const commands = r.vector(() => readCommand(r));
  const sender = r.address();
  const payment = r.vector(() => readObjectRef(r));
  const owner = r.address();
  const price = r.u64();
  const budget = r.u64();
  const expiration = readExpiration(r);
  if (!r.done) throw new SuiTransactionDecodeError('trailing bytes after TransactionData');
  return { sender, gasData: { payment, owner, price, budget }, expiration, inputs, commands };
}

/* ── Pure-argument readers, for the verifier ─────────────────────────────── */

const pureReader = (bytes: Uint8Array): Reader => new Reader(bytes);

const exhausted = <T>(r: Reader, value: T, what: string): T => {
  if (!r.done) throw new SuiTransactionDecodeError(`pure ${what} has trailing bytes`);
  return value;
};

export const pureU64 = (bytes: Uint8Array): bigint => {
  const r = pureReader(bytes);
  return exhausted(r, r.u64(), 'u64');
};

export const pureU8 = (bytes: Uint8Array): number => {
  const r = pureReader(bytes);
  return exhausted(r, r.u8(), 'u8');
};

export const pureAddress = (bytes: Uint8Array): string => {
  const r = pureReader(bytes);
  return exhausted(r, r.address(), 'address');
};

export const pureByteVector = (bytes: Uint8Array): Uint8Array => {
  const r = pureReader(bytes);
  return exhausted(r, r.bytesWithLength(), 'vector<u8>');
};

export const bytesToHex = toHex;

export const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'base64'));
