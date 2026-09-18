/**
 * The call shapes the verifier binds, pinned — and checked against the chain
 * before anything is signed (ADR-0015).
 *
 * `verify.ts` binds arguments BY POSITION: argument 6 of `place_order` is the
 * amount, and so on. That is only true of the package it was written against.
 * An upgrade that moved an argument would leave every position check "passing"
 * against the wrong value. So each function the verifier accepts is read from
 * the deployment's current package and compared, parameter by parameter, with
 * the shape below. Any difference refuses the order: the build has to be
 * updated for the new package, deliberately.
 *
 * Package addresses are written as `{config key}` (the package's ORIGINAL id
 * in waterx-config) and `0x2` for the Sui framework, so one snapshot holds for
 * every network. Captured 2026-09-17 from mainnet and testnet, which agree.
 */
import type { DirectDeployment } from './deployment.ts';

export interface FunctionShape {
  readonly typeParameters: number;
  readonly parameters: readonly string[];
}

/** Keyed `config package key::module::function`. */
export const BOUND_FUNCTIONS: Readonly<Record<string, FunctionShape>> = {
  'waterx_prediction::waterx_prediction::place_order': {
    typeParameters: 1,
    parameters: [
      '&{waterx_prediction}::global_config::GlobalConfig',
      '&mut {waterx_prediction}::waterx_prediction::MarketRegistry<$0>',
      '&mut {waterx_account}::account::AccountRegistry',
      '&{bucket_framework}::account::AccountRequest',
      '0x2::object::ID',
      '0x2::object::ID',
      'u64',
      'vector<u8>',
      '{waterx_prediction}::position::Selection',
      'u64',
      'u64',
      'u64',
      '&0x2::clock::Clock',
      '&mut 0x2::tx_context::TxContext',
    ],
  },
  'waterx_prediction::waterx_prediction::request_close': {
    typeParameters: 1,
    parameters: [
      '&{waterx_prediction}::global_config::GlobalConfig',
      '&mut {waterx_prediction}::waterx_prediction::MarketRegistry<$0>',
      '&mut {waterx_account}::account::AccountRegistry',
      '&{bucket_framework}::account::AccountRequest',
      'u64',
      'u64',
      'u64',
      '&0x2::clock::Clock',
    ],
  },
  'waterx_prediction::waterx_prediction::request_partial_close': {
    typeParameters: 1,
    parameters: [
      '&{waterx_prediction}::global_config::GlobalConfig',
      '&mut {waterx_prediction}::waterx_prediction::MarketRegistry<$0>',
      '&mut {waterx_account}::account::AccountRegistry',
      '&{bucket_framework}::account::AccountRequest',
      'u64',
      'u64',
      'u64',
      'u64',
      '&0x2::clock::Clock',
      '&mut 0x2::tx_context::TxContext',
    ],
  },
  'waterx_prediction::position::selection_yes': {
    typeParameters: 0,
    parameters: [

    ],
  },
  'waterx_prediction::position::selection_no': {
    typeParameters: 0,
    parameters: [

    ],
  },
  'bucket_framework::account::request': {
    typeParameters: 0,
    parameters: [
      '&0x2::tx_context::TxContext',
    ],
  },
  'waterx_account::account::request_deposit_from_funds': {
    typeParameters: 1,
    parameters: [
      '&mut {waterx_account}::account::AccountRegistry',
      '0x2::object::ID',
      '&0x2::accumulator::AccumulatorRoot',
      'vector<u8>',
    ],
  },
  'waterx_account::account::request_deposit_from_receivings': {
    typeParameters: 1,
    parameters: [
      '&mut {waterx_account}::account::AccountRegistry',
      '0x2::object::ID',
      'vector<0x2::transfer::Receiving<0x2::coin::Coin<$0>>>',
      'vector<u8>',
      '&mut 0x2::tx_context::TxContext',
    ],
  },
  'waterx_account::direct_rule::consume_deposit_direct': {
    typeParameters: 1,
    parameters: [
      '&mut {waterx_account}::account::AccountRegistry',
      '{waterx_account}::account::DepositRequest<$0>',
    ],
  },
  'native_custody::custody_vault::mint_from_request': {
    typeParameters: 2,
    parameters: [
      '&mut {native_custody}::custody_vault::CustodyVault<$1>',
      '&mut {waterx_credit}::credit_registry::CreditRegistry<$1>',
      '&{waterx_account}::account::AccountRegistry',
      '{waterx_account}::account::DepositRequest<$0>',
      '&mut 0x2::tx_context::TxContext',
    ],
  },
};

export interface AbiMismatch {
  readonly function: string;
  readonly expected: FunctionShape;
  readonly actual: FunctionShape | undefined;
}

export interface FunctionReader {
  /** `undefined` when the package has no such function. Throws when the read fails. */
  functionShape(packageId: string, module: string, name: string, signal?: AbortSignal): Promise<FunctionShape | undefined>;
}

const SUI_FRAMEWORK = `0x${'0'.repeat(63)}2`;

/** Rewrite a chain-printed type so package ids read as the snapshot writes them. */
export function symbolicType(repr: string, deployment: DirectDeployment): string {
  return repr.replace(/0x([0-9a-fA-F]{64})/gu, (address: string) => {
    const lower = address.toLowerCase();
    if (lower === SUI_FRAMEWORK) return '0x2';
    const name = deployment.packageNames.get(lower);
    return name === undefined ? lower : `{${name}}`;
  });
}

/** Which current package each snapshot key is called at, or undefined when the deployment has none. */
function callableFor(key: string, deployment: DirectDeployment): string | undefined {
  const callable = deployment.callable;
  const id =
    key === 'waterx_prediction'
      ? callable.prediction
      : key === 'bucket_framework'
        ? callable.framework
        : key === 'waterx_account'
          ? callable.account
          : key === 'native_custody'
            ? callable.custody
            : '';
  return id === '' ? undefined : id;
}

/**
 * Every bound function whose on-chain shape differs from the snapshot. Empty
 * means the verifier's positions describe this deployment. A function the
 * deployment does not call at all (no custody package) is not checked.
 */
export async function findAbiMismatches(
  deployment: DirectDeployment,
  reader: FunctionReader,
  signal?: AbortSignal,
): Promise<AbiMismatch[]> {
  const checks = Object.entries(BOUND_FUNCTIONS).flatMap(([key, expected]) => {
    const [pkg, module, name] = key.split('::') as [string, string, string];
    const packageId = callableFor(pkg, deployment);
    return packageId === undefined ? [] : [{ key, expected, packageId, module, name }];
  });
  const results = await Promise.all(
    checks.map(async ({ key, expected, packageId, module, name }): Promise<AbiMismatch | undefined> => {
      const read = await reader.functionShape(packageId, module, name, signal);
      const actual: FunctionShape | undefined =
        read === undefined
          ? undefined
          : { typeParameters: read.typeParameters, parameters: read.parameters.map((p) => symbolicType(p, deployment)) };
      const same =
        actual !== undefined &&
        actual.typeParameters === expected.typeParameters &&
        actual.parameters.length === expected.parameters.length &&
        actual.parameters.every((parameter, index) => parameter === expected.parameters[index]);
      return same ? undefined : { function: key, expected, actual };
    }),
  );
  return results.filter((mismatch): mismatch is AbiMismatch => mismatch !== undefined);
}
