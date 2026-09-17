/**
 * Shared fixtures for direct mode: the mainnet deployment document, and bytes
 * built by the same `@waterx/sdk` 5.0.0 builder the backend uses.
 */
import { readFileSync } from 'node:fs';

import { Inputs, Transaction } from '@mysten/sui/transactions';
import { PredictClient, placeOrder, requestClose, requestPartialClose } from '@waterx/sdk/prediction';

import { parseDeployment } from '../src/direct/deployment.ts';
import { normalizeSuiAddress } from '../src/sui-tx.ts';

export const CONFIG = JSON.parse(
  readFileSync(new URL('./fixtures/waterx-config-mainnet.json', import.meta.url), 'utf8'),
) as Record<string, any>;
export const deployment = parseDeployment(CONFIG, 'mainnet');
export const builder = new PredictClient('MAINNET', CONFIG as never);

export const SPONSOR = normalizeSuiAddress(`0x${'b'.repeat(64)}`);
const DIGEST = '11111111111111111111111111111111';

/** Resolve the builder's object inputs offline and serialize with gas. */
export async function finish(
  tx: Transaction,
  options: { sender: string; gasOwner?: string; owned?: boolean },
): Promise<Uint8Array> {
  const data = tx.getData();
  data.inputs.forEach((input, index) => {
    if (input.$kind !== 'UnresolvedObject') return;
    const objectId = input.UnresolvedObject.objectId;
    data.inputs[index] =
      options.owned === true && objectId === deployment.objects.marketRegistry
        ? Inputs.ObjectRef({ objectId, version: '1', digest: DIGEST })
        : Inputs.SharedObjectRef({ objectId, initialSharedVersion: 1, mutable: true });
  });
  const built = Transaction.from(
    JSON.stringify(data, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)),
  );
  built.setSender(options.sender);
  built.setGasOwner(options.gasOwner ?? SPONSOR);
  built.setGasPrice(1000);
  built.setGasBudget(50_000_000);
  built.setGasPayment([{ objectId: normalizeSuiAddress('0x9a5'), version: '1', digest: DIGEST }]);
  return await built.build();
}

export async function buildPlace(params: Record<string, unknown>, sender: string): Promise<Uint8Array> {
  const tx = new Transaction();
  placeOrder(builder, tx, params as never);
  return await finish(tx, { sender });
}

export async function buildSell(
  params: Record<string, unknown> & { closeShares?: unknown },
  sender: string,
): Promise<Uint8Array> {
  const tx = new Transaction();
  if (params.closeShares === undefined) requestClose(builder, tx, params as never);
  else requestPartialClose(builder, tx, params as never);
  return await finish(tx, { sender });
}

export { Transaction, placeOrder };
