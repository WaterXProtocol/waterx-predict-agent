/**
 * The zero-dependency decoder, held to `@mysten/sui`'s own encoder.
 *
 * Every fixture here is built by the real Sui SDK (a dev dependency only), so a
 * layout this decoder reads differently from the chain fails here rather than
 * in a signature.
 */
import { bcs } from '@mysten/sui/bcs';
import { Inputs, Transaction } from '@mysten/sui/transactions';
import { describe, expect, it } from 'vitest';

import {
  decodeSuiTransaction,
  normalizeSuiAddress,
  pureAddress,
  pureByteVector,
  pureU64,
  pureU8,
  SuiTransactionDecodeError,
} from '../src/sui-tx.ts';

const SENDER = normalizeSuiAddress('0xa11ce');
const SPONSOR = normalizeSuiAddress('0x5b0');
const PKG = normalizeSuiAddress('0x972184710f3ea2d54973d325ca4035c8d44d1a9571da7ee42a34cf8da72facbd');
const SHARED = normalizeSuiAddress('0x5ea7');
const DIGEST = '11111111111111111111111111111111';

async function build(configure: (tx: Transaction) => void): Promise<Uint8Array> {
  const tx = new Transaction();
  configure(tx);
  tx.setSender(SENDER);
  tx.setGasOwner(SPONSOR);
  tx.setGasPrice(1000);
  tx.setGasBudget(50_000_000);
  tx.setGasPayment([{ objectId: normalizeSuiAddress('0x9a5'), version: '7', digest: DIGEST }]);
  return await tx.build();
}

describe('decodeSuiTransaction', () => {
  it('reads a move call with shared objects, pure arguments and a type argument', async () => {
    const bytes = await build((tx) => {
      tx.moveCall({
        target: `${PKG}::waterx_prediction::place_order`,
        typeArguments: [`${PKG}::usd::USD`],
        arguments: [
          tx.object(Inputs.SharedObjectRef({ objectId: SHARED, initialSharedVersion: 42, mutable: true })),
          tx.pure.u64(123_456_789n),
          tx.pure.vector('u8', [1, 2, 3]),
          tx.pure.address(SENDER),
          tx.pure.u8(1),
        ],
      });
    });

    const decoded = decodeSuiTransaction(bytes);
    expect(decoded.sender).toBe(SENDER);
    expect(decoded.gasData).toEqual({
      payment: [expect.objectContaining({ objectId: normalizeSuiAddress('0x9a5'), version: 7n })],
      owner: SPONSOR,
      price: 1000n,
      budget: 50_000_000n,
    });
    expect(decoded.expiration).toEqual({ kind: 'None' });
    expect(decoded.commands).toHaveLength(1);
    const call = decoded.commands[0];
    expect(call).toMatchObject({
      kind: 'MoveCall',
      package: PKG,
      module: 'waterx_prediction',
      function: 'place_order',
      typeArguments: [{ kind: 'struct', address: PKG, module: 'usd', name: 'USD', typeParams: [] }],
    });
    if (call?.kind !== 'MoveCall') throw new Error('unreachable');

    const input = (position: number) => {
      const argument = call.arguments[position];
      if (argument?.kind !== 'Input') throw new Error(`argument ${String(position)} is not an input`);
      return decoded.inputs[argument.index];
    };
    expect(input(0)).toEqual({ kind: 'SharedObject', objectId: SHARED, initialSharedVersion: 42n, mutable: true });
    const pure = (position: number): Uint8Array => {
      const arg = input(position);
      if (arg?.kind !== 'Pure') throw new Error('not pure');
      return arg.bytes;
    };
    expect(pureU64(pure(1))).toBe(123_456_789n);
    expect([...pureByteVector(pure(2))]).toEqual([1, 2, 3]);
    expect(pureAddress(pure(3))).toBe(SENDER);
    expect(pureU8(pure(4))).toBe(1);
  });

  it('reads every command a hostile builder could smuggle in', async () => {
    const bytes = await build((tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(5)]);
      tx.mergeCoins(tx.gas, [coin!]);
      const vec = tx.makeMoveVec({ type: 'u64', elements: [tx.pure.u64(1)] });
      tx.transferObjects([vec], tx.pure.address(normalizeSuiAddress('0xbad')));
      tx.moveCall({ target: `${PKG}::m::f`, arguments: [tx.object(Inputs.ObjectRef({ objectId: normalizeSuiAddress('0x0b1'), version: '3', digest: DIGEST }))] });
      tx.moveCall({ target: `${PKG}::m::g`, arguments: [tx.object(Inputs.ReceivingRef({ objectId: normalizeSuiAddress('0x0b2'), version: '4', digest: DIGEST }))] });
    });
    const decoded = decodeSuiTransaction(bytes);
    expect(decoded.commands.map((command) => command.kind)).toEqual([
      'SplitCoins',
      'MergeCoins',
      'MakeMoveVec',
      'TransferObjects',
      'MoveCall',
      'MoveCall',
    ]);
    expect(decoded.commands[0]).toMatchObject({ coin: { kind: 'GasCoin' } });
    expect(decoded.commands[2]).toMatchObject({ type: { kind: 'u64' } });
    expect(decoded.inputs.map((input) => input.kind)).toEqual(
      expect.arrayContaining(['ImmOrOwnedObject', 'Receiving', 'Pure']),
    );
  });

  it('reads an epoch expiration', async () => {
    const tx = new Transaction();
    tx.moveCall({ target: `${PKG}::m::f` });
    tx.setSender(SENDER);
    tx.setGasOwner(SENDER);
    tx.setGasPrice(1);
    tx.setGasBudget(1);
    tx.setGasPayment([]);
    tx.setExpiration({ Epoch: 99 });
    expect(decodeSuiTransaction(await tx.build()).expiration).toEqual({ kind: 'Epoch', epoch: 99n });
  });

  it('refuses kind-only bytes, a non-programmable kind, and trailing garbage', async () => {
    const tx = new Transaction();
    tx.moveCall({ target: `${PKG}::m::f` });
    const kindOnly = await tx.build({ onlyTransactionKind: true });
    expect(() => decodeSuiTransaction(kindOnly)).toThrow(SuiTransactionDecodeError);

    // V1 with the ChangeEpoch kind tag.
    expect(() => decodeSuiTransaction(Uint8Array.from([0, 1, 0]))).toThrow(/not a programmable transaction/u);

    const full = await build((t) => t.moveCall({ target: `${PKG}::m::f` }));
    expect(() => decodeSuiTransaction(Uint8Array.from([...full, 0]))).toThrow(/trailing bytes/u);
    expect(() => decodeSuiTransaction(full.subarray(0, full.length - 3))).toThrow(/truncated/u);
  });

  it('agrees with the Sui SDK on the decoded structure of a real build', async () => {
    const bytes = await build((tx) => {
      tx.moveCall({ target: `${PKG}::waterx_prediction::request_close`, arguments: [tx.pure.u64(9), tx.pure.u64(10)] });
    });
    const theirs = bcs.TransactionData.parse(bytes);
    const ours = decodeSuiTransaction(bytes);
    expect(ours.sender).toBe(theirs.V1.sender);
    expect(ours.gasData.owner).toBe(theirs.V1.gasData.owner);
    expect(ours.inputs).toHaveLength(theirs.V1.kind.ProgrammableTransaction!.inputs.length);
    expect(ours.commands).toHaveLength(theirs.V1.kind.ProgrammableTransaction!.commands.length);
  });

  it('refuses pure bytes that do not match the type they are read as', () => {
    expect(() => pureU64(Uint8Array.from([1, 2, 3]))).toThrow(SuiTransactionDecodeError);
    expect(() => pureU8(Uint8Array.from([1, 2]))).toThrow(/trailing/u);
  });
});
