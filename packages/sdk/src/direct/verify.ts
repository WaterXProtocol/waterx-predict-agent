/**
 * Check what a backend-built transaction does before this agent signs it.
 *
 * Direct mode (ADR-0013) signs bytes built by a public route that authenticates
 * nobody. So every transaction is decoded (`sui-tx.ts`) and held to the intent
 * this client formed BEFORE the request left, on the model of the perp agent's
 * `verify.ts`: the command SHAPE is allowlisted, every call's PACKAGE is the
 * deployment's current one for the package it names, and every argument of the
 * trading call is BOUND — not "the arguments someone thought to check", which
 * does not converge.
 *
 * WHAT IS BOUND
 *  - sender = this agent; gas owner ≠ this agent (a delegate never pays gas);
 *  - commands: MoveCall and MakeMoveVec only;
 *  - inputs: pure values, the deployment's named shared objects, and Receiving
 *    refs used only inside a vector — no owned objects, no sender withdrawals;
 *  - calls: `account::request` once; `position::selection_*` matching the
 *    intent; exactly one trading call; and, for a buy only, the deposit-direction
 *    consolidation legs (`request_deposit_from_funds|receivings` into THIS
 *    account, `mint_from_request`, `consume_deposit_direct`);
 *  - the trading call: every argument position — shared objects by role, the
 *    request, the account (twice for a buy), amount, market bytes, selection,
 *    minimum, cap, expiry, clock — and its settlement coin type.
 *
 * WHAT IS NOT
 *  - A sell's `min_proceeds` is the backend's number. It is held to a floor this
 *    client computed from its own bid read (`minProceedsAtLeast`), not to an
 *    exact value.
 *  - The consolidation legs' non-account arguments (which parked assets, how
 *    much) are the backend's. They can only move value INTO the named account.
 *  - This runs inside the agent process. A compromised process can skip it;
 *    what it stops is a bug, a wrong or hostile response, and a poisoned HTTP
 *    layer — the same claim the perp agent makes, and no stronger.
 */
import {
  bytesToHex,
  decodeSuiTransaction,
  normalizeSuiAddress,
  pureAddress,
  pureByteVector,
  pureU64,
  SuiTransactionDecodeError,
  type SuiArgument,
  type SuiCallArg,
  type SuiCommand,
  type SuiTransaction,
  type SuiTypeTag,
} from '../sui-tx.ts';
import { SUI_ACCUMULATOR_ROOT, SUI_CLOCK, type DirectDeployment } from './deployment.ts';

export class DirectVerificationError extends Error {
  override readonly name = 'DirectVerificationError';
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(`refusing to sign: ${message}`);
    this.rule = rule;
  }
}

export interface PlaceExpectation {
  readonly kind: 'place';
  readonly agentWallet: string;
  readonly accountId: string;
  readonly onchainMarketId: string;
  readonly selection: 'YES' | 'NO';
  readonly maxSpend: bigint;
  readonly minShares: bigint;
  readonly priceCapBps: bigint;
  readonly expiryTs: bigint;
}

export interface SellExpectation {
  readonly kind: 'sell';
  readonly agentWallet: string;
  readonly accountId: string;
  readonly positionId: bigint;
  /** The shares requested. A partial close must name exactly this many. */
  readonly closeShares: bigint;
  /** Floor for `min_proceeds` given how many shares the transaction closes. */
  readonly minProceedsAtLeast: (sharesClosed: bigint | 'FULL') => bigint;
  readonly expiryTs: bigint;
}

export type DirectExpectation = PlaceExpectation | SellExpectation;

export interface VerifiedTransaction {
  readonly call: 'place_order' | 'request_close' | 'request_partial_close';
  /** A sell's backend-chosen floor, once it has been held to ours. */
  readonly minProceeds?: bigint;
  readonly consolidationLegs: number;
}

type MoveCall = Extract<SuiCommand, { kind: 'MoveCall' }>;

const fail = (rule: string, message: string): never => {
  throw new DirectVerificationError(rule, message);
};

const sameStruct = (tag: SuiTypeTag | undefined, coin: DirectDeployment['settlementCoin']): boolean =>
  tag?.kind === 'struct' &&
  normalizeSuiAddress(tag.address) === coin.address &&
  tag.module === coin.module &&
  tag.name === coin.name &&
  tag.typeParams.length === 0;

export function verifyDirectTransaction(
  txBytes: Uint8Array,
  expectation: DirectExpectation,
  deployment: DirectDeployment,
): VerifiedTransaction {
  let tx: SuiTransaction;
  try {
    tx = decodeSuiTransaction(txBytes);
  } catch (error: unknown) {
    const reason = error instanceof SuiTransactionDecodeError ? error.message : 'unreadable';
    return fail('DECODE', `the transaction could not be read (${reason})`);
  }

  const agent = normalizeSuiAddress(expectation.agentWallet);
  if (tx.sender !== agent) fail('SENDER', `it is sent by ${tx.sender}, not by this agent ${agent}`);
  if (tx.gasData.owner === agent) fail('GAS', 'it spends this agent’s own gas; a delegate order must be sponsored');

  const shared = new Map<string, string>([
    [deployment.objects.predictionGlobalConfig, 'prediction global config'],
    [deployment.objects.marketRegistry, 'market registry'],
    [deployment.objects.accountRegistry, 'account registry'],
    [SUI_CLOCK, 'clock'],
    [SUI_ACCUMULATOR_ROOT, 'accumulator root'],
  ]);
  if (deployment.objects.custodyVault !== undefined) shared.set(deployment.objects.custodyVault, 'custody vault');
  if (deployment.objects.creditRegistry !== undefined) shared.set(deployment.objects.creditRegistry, 'credit registry');

  tx.inputs.forEach((input, index) => {
    switch (input.kind) {
      case 'Pure':
        return;
      case 'SharedObject':
        if (!shared.has(input.objectId)) {
          fail('SHARED_OBJECT', `input ${String(index)} is shared object ${input.objectId}, which the deployment does not name`);
        }
        return;
      case 'Receiving':
        return;
      default:
        fail('INPUT', `input ${String(index)} is ${input.kind}, which no order needs`);
    }
  });

  // Receiving refs may appear only as elements of a vector, which is how the
  // consolidation leg takes them. Anywhere else they are a way to move an object.
  const receivingInputs = new Set(
    tx.inputs.flatMap((input, index) => (input.kind === 'Receiving' ? [index] : [])),
  );
  const refersToReceiving = (argument: SuiArgument): boolean =>
    argument.kind === 'Input' && receivingInputs.has(argument.index);

  const input = (argument: SuiArgument | undefined, where: string): SuiCallArg => {
    if (argument?.kind !== 'Input') return fail('ARGUMENT', `${where} is not a transaction input`);
    const found = tx.inputs[argument.index];
    if (found === undefined) return fail('ARGUMENT', `${where} names input ${String(argument.index)}, which does not exist`);
    return found;
  };
  const pure = (argument: SuiArgument | undefined, where: string): Uint8Array => {
    const found = input(argument, where);
    if (found.kind !== 'Pure') return fail('ARGUMENT', `${where} is not a pure value`);
    return found.bytes;
  };
  const expectShared = (argument: SuiArgument | undefined, objectId: string | undefined, where: string): void => {
    const found = input(argument, where);
    if (found.kind !== 'SharedObject' || objectId === undefined || found.objectId !== objectId) {
      fail('ARGUMENT', `${where} is not the deployment’s ${shared.get(objectId ?? '') ?? 'object'}`);
    }
  };
  const expectU64 = (argument: SuiArgument | undefined, value: bigint, where: string): void => {
    let actual: bigint;
    try {
      actual = pureU64(pure(argument, where));
    } catch (error: unknown) {
      if (error instanceof DirectVerificationError) throw error;
      return fail('ARGUMENT', `${where} is not a u64`);
    }
    if (actual !== value) fail('ARGUMENT', `${where} is ${actual.toString()}, not ${value.toString()}`);
  };
  const readU64 = (argument: SuiArgument | undefined, where: string): bigint => {
    try {
      return pureU64(pure(argument, where));
    } catch (error: unknown) {
      if (error instanceof DirectVerificationError) throw error;
      return fail('ARGUMENT', `${where} is not a u64`);
    }
  };
  const expectAccount = (argument: SuiArgument | undefined, where: string): void => {
    let actual: string;
    try {
      actual = pureAddress(pure(argument, where));
    } catch (error: unknown) {
      if (error instanceof DirectVerificationError) throw error;
      return fail('ARGUMENT', `${where} is not an id`);
    }
    if (actual !== normalizeSuiAddress(expectation.accountId)) {
      fail('ACCOUNT', `${where} is account ${actual}, not ${normalizeSuiAddress(expectation.accountId)}`);
    }
  };
  // A single-return call is referenced either as `Result(i)` or — the way the
  // builders destructure it, `const [x] = tx.moveCall(...)` — as `NestedResult(i, 0)`.
  const producedBy = (argument: SuiArgument | undefined, index: number, where: string): void => {
    const matches =
      (argument?.kind === 'Result' && argument.index === index) ||
      (argument?.kind === 'NestedResult' && argument.index === index && argument.result === 0);
    if (!matches) fail('ARGUMENT', `${where} is not the result of command ${String(index)}`);
  };

  const { callable } = deployment;
  const target = (call: MoveCall): string => `${call.module}::${call.function}`;
  let requestAt: number | undefined;
  let selectionAt: { index: number; selection: 'YES' | 'NO' } | undefined;
  let trading: { index: number; call: MoveCall } | undefined;
  let consolidationLegs = 0;

  tx.commands.forEach((command, index) => {
    if (command.kind === 'MakeMoveVec') {
      if (expectation.kind !== 'place') fail('SHAPE', 'a sell builds no vectors');
      return;
    }
    if (command.kind !== 'MoveCall') {
      return fail('SHAPE', `command ${String(index)} is ${command.kind}; an order moves nothing out of the account`);
    }
    for (const argument of command.arguments) {
      if (refersToReceiving(argument)) fail('INPUT', `command ${String(index)} takes a Receiving ref directly`);
      if ((argument.kind === 'Result' || argument.kind === 'NestedResult') && argument.index >= index) {
        fail('ARGUMENT', `command ${String(index)} reads a result that does not exist yet`);
      }
    }
    const name = target(command);

    if (command.package === callable.framework && name === 'account::request') {
      if (requestAt !== undefined) fail('SHAPE', 'it creates more than one account request');
      if (command.arguments.length !== 0 || command.typeArguments.length !== 0) fail('SHAPE', 'account::request takes arguments');
      requestAt = index;
      return;
    }
    if (command.package === callable.prediction && (name === 'position::selection_yes' || name === 'position::selection_no')) {
      if (expectation.kind !== 'place') fail('SHAPE', 'a sell names no selection');
      if (selectionAt !== undefined) fail('SHAPE', 'it names more than one selection');
      if (command.arguments.length !== 0) fail('SHAPE', `${name} takes arguments`);
      selectionAt = { index, selection: name.endsWith('_yes') ? 'YES' : 'NO' };
      return;
    }
    const tradingNames =
      expectation.kind === 'place'
        ? ['waterx_prediction::place_order']
        : ['waterx_prediction::request_close', 'waterx_prediction::request_partial_close'];
    if (command.package === callable.prediction && tradingNames.includes(name)) {
      if (trading !== undefined) fail('SHAPE', 'it places more than one order');
      trading = { index, call: command };
      return;
    }
    if (expectation.kind === 'place') {
      if (command.package === callable.account && (name === 'account::request_deposit_from_funds' || name === 'account::request_deposit_from_receivings')) {
        expectShared(command.arguments[0], deployment.objects.accountRegistry, `${name} registry`);
        expectAccount(command.arguments[1], `${name} account`);
        consolidationLegs += 1;
        return;
      }
      if (command.package === callable.account && name === 'direct_rule::consume_deposit_direct') {
        expectShared(command.arguments[0], deployment.objects.accountRegistry, `${name} registry`);
        return;
      }
      if (callable.custody !== '' && command.package === callable.custody && name === 'custody_vault::mint_from_request') {
        expectShared(command.arguments[0], deployment.objects.custodyVault, `${name} vault`);
        expectShared(command.arguments[1], deployment.objects.creditRegistry, `${name} credit registry`);
        expectShared(command.arguments[2], deployment.objects.accountRegistry, `${name} account registry`);
        return;
      }
    }
    return fail(
      'CALL',
      `command ${String(index)} calls ${command.package}::${name}, which is not part of ${expectation.kind === 'place' ? 'placing an order' : 'closing a position'} in this deployment`,
    );
  });

  if (trading === undefined) return fail('SHAPE', 'it places no order');
  if (requestAt === undefined) return fail('SHAPE', 'it creates no account request');
  const { call } = trading;
  const args = call.arguments;
  if (call.typeArguments.length !== 1 || !sameStruct(call.typeArguments[0], deployment.settlementCoin)) {
    fail('TYPE', 'the order does not settle in the deployment’s coin');
  }
  expectShared(args[0], deployment.objects.predictionGlobalConfig, 'global config');
  expectShared(args[1], deployment.objects.marketRegistry, 'market registry');
  expectShared(args[2], deployment.objects.accountRegistry, 'account registry');
  producedBy(args[3], requestAt, 'the account request');

  if (expectation.kind === 'place') {
    if (args.length !== 13) fail('ARITY', `place_order has ${String(args.length)} arguments, not 13`);
    expectAccount(args[4], 'the paying account');
    expectAccount(args[5], 'the receiving account');
    expectU64(args[6], expectation.maxSpend, 'the amount');
    const market = pureByteVector(pure(args[7], 'the market'));
    const expectedMarket = normalizeSuiAddress(expectation.onchainMarketId).slice(2);
    if (bytesToHex(market) !== expectedMarket) fail('MARKET', `the order is on market 0x${bytesToHex(market)}, not 0x${expectedMarket}`);
    if (selectionAt === undefined) return fail('SHAPE', 'it names no selection');
    producedBy(args[8], selectionAt.index, 'the selection');
    if (selectionAt.selection !== expectation.selection) {
      fail('SELECTION', `the order buys ${selectionAt.selection}, not ${expectation.selection}`);
    }
    expectU64(args[9], expectation.minShares, 'the minimum shares');
    expectU64(args[10], expectation.priceCapBps, 'the price cap');
    expectU64(args[11], expectation.expiryTs, 'the expiry');
    expectShared(args[12], SUI_CLOCK, 'the clock');
    return { call: 'place_order', consolidationLegs };
  }

  if (consolidationLegs > 0) fail('SHAPE', 'a sell deposits nothing');
  expectU64(args[4], expectation.positionId, 'the position');
  let minProceeds: bigint;
  let sharesClosed: bigint | 'FULL';
  let callName: VerifiedTransaction['call'];
  if (call.function === 'request_partial_close') {
    if (args.length !== 9) fail('ARITY', `request_partial_close has ${String(args.length)} arguments, not 9`);
    expectU64(args[5], expectation.closeShares, 'the shares to close');
    minProceeds = readU64(args[6], 'the minimum proceeds');
    expectU64(args[7], expectation.expiryTs, 'the expiry');
    expectShared(args[8], SUI_CLOCK, 'the clock');
    sharesClosed = expectation.closeShares;
    callName = 'request_partial_close';
  } else {
    if (args.length !== 8) fail('ARITY', `request_close has ${String(args.length)} arguments, not 8`);
    minProceeds = readU64(args[5], 'the minimum proceeds');
    expectU64(args[6], expectation.expiryTs, 'the expiry');
    expectShared(args[7], SUI_CLOCK, 'the clock');
    sharesClosed = 'FULL';
    callName = 'request_close';
  }
  const floor = expectation.minProceedsAtLeast(sharesClosed);
  if (minProceeds <= 0n) fail('FLOOR', 'the sell has no minimum proceeds');
  if (minProceeds < floor) {
    fail('FLOOR', `the sell’s minimum proceeds ${minProceeds.toString()} are below this client’s floor ${floor.toString()}`);
  }
  return { call: callName, minProceeds, consolidationLegs };
}
