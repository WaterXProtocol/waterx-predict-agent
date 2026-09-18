/**
 * The verifier, against transactions built by the SAME builder the backend uses.
 *
 * `@waterx/sdk` 5.0.0 is the version `bucket-backend-mono` pins at the deployed
 * commit, and it is a dev dependency here only. The shared objects its builder
 * leaves unresolved are filled in offline, so these are the bytes the backend
 * would return minus the object versions — which the verifier does not read.
 *
 * Each refusal case changes ONE thing a hostile or buggy backend could change.
 */
import { readFileSync } from 'node:fs';

import { Inputs, Transaction } from '@mysten/sui/transactions';
import { PredictClient, placeOrder, requestClose, requestPartialClose } from '@waterx/sdk/prediction';
import { describe, expect, it } from 'vitest';

import { parseDeployment } from '../src/direct/deployment.ts';
import {
  DirectVerificationError,
  verifyDirectTransaction,
  type PlaceExpectation,
  type SellExpectation,
} from '../src/direct/verify.ts';
import { normalizeSuiAddress } from '../src/sui-tx.ts';

const CONFIG = JSON.parse(
  readFileSync(new URL('./fixtures/waterx-config-mainnet.json', import.meta.url), 'utf8'),
) as Record<string, any>;
const deployment = parseDeployment(CONFIG, 'mainnet');
const client = new PredictClient('MAINNET', CONFIG as never);

const AGENT = normalizeSuiAddress(`0x${'a'.repeat(64)}`);
const SPONSOR = normalizeSuiAddress(`0x${'b'.repeat(64)}`);
const ACCOUNT = normalizeSuiAddress(`0x${'c'.repeat(64)}`);
const MARKET = normalizeSuiAddress(`0x${'2'.repeat(64)}`);
const DIGEST = '11111111111111111111111111111111';

const PLACE: PlaceExpectation = {
  kind: 'place',
  agentWallet: AGENT,
  accountId: ACCOUNT,
  onchainMarketId: MARKET,
  selection: 'YES',
  maxSpend: 5_000_000n,
  minShares: 11_363_636n,
  priceCapBps: 4_400n,
  expiryTs: 1_789_600_000_000n,
};

const placeParams = (overrides: Record<string, unknown> = {}) => ({
  accountId: PLACE.accountId,
  marketId: PLACE.onchainMarketId,
  selection: PLACE.selection,
  maxSpend: PLACE.maxSpend,
  minShares: PLACE.minShares,
  priceCapBps: PLACE.priceCapBps,
  expiryTs: PLACE.expiryTs,
  ...overrides,
});

/** Resolve the builder's object inputs offline and serialize with gas. */
async function finish(
  tx: Transaction,
  options: { sender?: string; gasOwner?: string; owned?: boolean } = {},
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
  const built = Transaction.from(JSON.stringify(data, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)));
  built.setSender(options.sender ?? AGENT);
  built.setGasOwner(options.gasOwner ?? SPONSOR);
  built.setGasPrice(1000);
  built.setGasBudget(50_000_000);
  built.setGasPayment([{ objectId: normalizeSuiAddress('0x9a5'), version: '1', digest: DIGEST }]);
  return await built.build();
}

async function place(
  mutate: (tx: Transaction) => void = () => undefined,
  params: Record<string, unknown> = {},
  options: Parameters<typeof finish>[1] = {},
): Promise<Uint8Array> {
  const tx = new Transaction();
  mutate(tx);
  placeOrder(client, tx, placeParams(params) as never);
  return await finish(tx, options);
}

/** The deposit-direction legs the backend's consolidation prepends. */
function consolidate(tx: Transaction, accountId: string = ACCOUNT): void {
  const funds = tx.moveCall({
    target: `${deployment.callable.account}::account::request_deposit_from_funds`,
    typeArguments: [`${deployment.settlementCoin.address}::usd::USD`],
    arguments: [
      tx.object(deployment.objects.accountRegistry),
      tx.pure.id(accountId),
      tx.object(Inputs.SharedObjectRef({ objectId: '0xacc', initialSharedVersion: 1, mutable: true })),
      tx.pure.vector('u8', []),
    ],
  });
  const minted = tx.moveCall({
    target: `${deployment.callable.custody}::custody_vault::mint_from_request`,
    arguments: [
      tx.object(deployment.objects.custodyVault!),
      tx.object(deployment.objects.creditRegistry!),
      tx.object(deployment.objects.accountRegistry),
      funds,
    ],
  });
  tx.moveCall({
    target: `${deployment.callable.account}::direct_rule::consume_deposit_direct`,
    arguments: [tx.object(deployment.objects.accountRegistry), minted],
  });
}

const refused = (bytes: Uint8Array, expectation: PlaceExpectation | SellExpectation, rule: string): void => {
  let error: unknown;
  try {
    verifyDirectTransaction(bytes, expectation, deployment);
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error, `expected refusal ${rule}`).toBeInstanceOf(DirectVerificationError);
  expect((error as DirectVerificationError).rule).toBe(rule);
};

describe('verifyDirectTransaction — a buy', () => {
  it('accepts exactly the order that was asked for', async () => {
    expect(verifyDirectTransaction(await place(), PLACE, deployment)).toEqual({
      call: 'place_order',
      consolidationLegs: 0,
    });
  });

  it('accepts the backend’s deposit-direction consolidation into this account', async () => {
    expect(verifyDirectTransaction(await place(consolidate), PLACE, deployment).consolidationLegs).toBe(1);
  });

  it('refuses a consolidation that deposits into another account', async () => {
    refused(await place((tx) => consolidate(tx, normalizeSuiAddress('0xdead'))), PLACE, 'ACCOUNT');
  });

  it.each([
    ['the amount', { maxSpend: 5_000_001n }],
    ['the price cap', { priceCapBps: 10_000n }],
    ['the minimum shares', { minShares: 0n }],
    ['the expiry', { expiryTs: 1n }],
  ])('refuses a different %s', async (_name, params) => {
    refused(await place(undefined, params), PLACE, 'ARGUMENT');
  });

  it('refuses another market, another side, and another paying account', async () => {
    refused(await place(undefined, { marketId: normalizeSuiAddress('0x3') }), PLACE, 'MARKET');
    refused(await place(undefined, { selection: 'NO' }), PLACE, 'SELECTION');
    refused(await place(undefined, { accountId: normalizeSuiAddress('0xdead') }), PLACE, 'ACCOUNT');
    refused(
      await place(undefined, { receiverAccountId: normalizeSuiAddress('0xdead') }),
      PLACE,
      'ACCOUNT',
    );
  });

  it('refuses bytes signed by, or paid by, the wrong party', async () => {
    refused(await place(undefined, {}, { sender: normalizeSuiAddress('0xbad') }), PLACE, 'SENDER');
    refused(await place(undefined, {}, { gasOwner: AGENT }), PLACE, 'GAS');
  });

  it('refuses anything that moves an object or coin out', async () => {
    refused(
      await place((tx) => {
        const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);
        tx.transferObjects([coin!], tx.pure.address(normalizeSuiAddress('0xbad')));
      }),
      PLACE,
      'SHAPE',
    );
  });

  it('refuses a call outside the allowlist, a superseded package, and a second order', async () => {
    refused(
      await place((tx) => tx.moveCall({ target: `${deployment.callable.prediction}::waterx_prediction::claim` })),
      PLACE,
      'CALL',
    );
    const original = normalizeSuiAddress(CONFIG['packages']['waterx_prediction']['original_id']);
    refused(await place(undefined, { packageId: original }), PLACE, 'CALL');
    refused(await place((tx) => placeOrder(client, tx, placeParams() as never)), PLACE, 'SHAPE');
  });

  it('refuses an owned object where a shared registry belongs', async () => {
    refused(await place(undefined, {}, { owned: true }), PLACE, 'INPUT');
  });

  it('refuses a different settlement coin', async () => {
    refused(
      await place(undefined, { settlementCoinType: `${deployment.callable.prediction}::fake::USD` }),
      PLACE,
      'TYPE',
    );
  });

  it('refuses bytes it cannot read', async () => {
    const bytes = await place();
    refused(bytes.subarray(0, bytes.length - 2), PLACE, 'DECODE');
  });
});

describe('verifyDirectTransaction — a sell', () => {
  const SELL: SellExpectation = {
    kind: 'sell',
    agentWallet: AGENT,
    accountId: ACCOUNT,
    positionId: 42n,
    closeShares: 3_000_000n,
    minProceedsAtLeast: (closed) => (closed === 'FULL' ? 2_000_000n : 1_200_000n),
    expiryTs: 1_789_600_000_000n,
  };

  const sell = async (
    kind: 'full' | 'partial',
    overrides: Record<string, unknown> = {},
    mutate: (tx: Transaction) => void = () => undefined,
  ): Promise<Uint8Array> => {
    const tx = new Transaction();
    mutate(tx);
    const base = { accountId: ACCOUNT, positionId: 42n, expiryTs: SELL.expiryTs, ...overrides };
    if (kind === 'full') requestClose(client, tx, { minProceeds: 2_100_000n, ...base } as never);
    else requestPartialClose(client, tx, { closeShares: 3_000_000n, minProceeds: 1_300_000n, ...base } as never);
    return await finish(tx);
  };

  it('accepts a partial and a full close, and reports the backend’s floor', async () => {
    expect(verifyDirectTransaction(await sell('partial'), SELL, deployment)).toEqual({
      call: 'request_partial_close',
      minProceeds: 1_300_000n,
      consolidationLegs: 0,
    });
    expect(verifyDirectTransaction(await sell('full'), SELL, deployment)).toMatchObject({
      call: 'request_close',
      minProceeds: 2_100_000n,
    });
  });

  it('refuses a floor below this client’s, and a floor of zero', async () => {
    refused(await sell('partial', { minProceeds: 1_199_999n }), SELL, 'FLOOR');
    refused(await sell('full', { minProceeds: 0n }), SELL, 'FLOOR');
  });

  it('refuses another position, another size, and a consolidation leg', async () => {
    refused(await sell('partial', { positionId: 43n }), SELL, 'ARGUMENT');
    refused(await sell('partial', { closeShares: 3_000_001n }), SELL, 'ARGUMENT');
    refused(await sell('partial', {}, consolidate), SELL, 'CALL');
  });

  it('refuses a buy dressed as a sell', async () => {
    // Its selection call is the first thing a sell has no use for.
    refused(await place(), SELL, 'SHAPE');
  });
});
