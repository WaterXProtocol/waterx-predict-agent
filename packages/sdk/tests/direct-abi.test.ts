/**
 * The pinned call shapes (ADR-0015): the verifier binds arguments by position,
 * so a package whose shapes moved must refuse the order, not verify it wrongly.
 */
import { describe, expect, it } from 'vitest';

import { BOUND_FUNCTIONS, findAbiMismatches, symbolicType, type FunctionReader, type FunctionShape } from '../src/direct/abi.ts';
import { deployment } from './direct-fixtures.ts';

const originalOf = (key: string): string => {
  for (const [id, name] of deployment.packageNames) if (name === key) return id;
  throw new Error(`no ${key}`);
};

/** A shape as the chain prints it: real original ids, `0x2` written out in full. */
const onChain = (shape: FunctionShape): FunctionShape => ({
  typeParameters: shape.typeParameters,
  parameters: shape.parameters.map((parameter) =>
    parameter
      .replace(/\{([a-z_]+)\}/gu, (_whole, key: string) => originalOf(key))
      .replace(/\b0x2::/gu, `0x${'0'.repeat(63)}2::`),
  ),
});

function reader(overrides: Record<string, FunctionShape | undefined | 'THROW'> = {}): FunctionReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    functionShape: (packageId, module, name) => {
      const key = Object.keys(BOUND_FUNCTIONS).find((k) => k.endsWith(`::${module}::${name}`))!;
      calls.push(`${packageId}::${module}::${name}`);
      if (key in overrides) {
        const override = overrides[key];
        if (override === 'THROW') return Promise.reject(new Error('read failed'));
        return Promise.resolve(override === undefined ? undefined : onChain(override));
      }
      return Promise.resolve(onChain(BOUND_FUNCTIONS[key]!));
    },
  };
}

describe('the pinned call shapes', () => {
  it('reads chain types back in the snapshot’s own terms', () => {
    const printed = `&mut ${originalOf('waterx_account')}::account::AccountRegistry`;
    expect(symbolicType(printed, deployment)).toBe('&mut {waterx_account}::account::AccountRegistry');
    expect(symbolicType(`&0x${'0'.repeat(63)}2::clock::Clock`, deployment)).toBe('&0x2::clock::Clock');
    // An address the deployment does not name stays an address, and so never matches.
    expect(symbolicType(`0x${'9'.repeat(64)}::x::Y`, deployment)).toBe(`0x${'9'.repeat(64)}::x::Y`);
  });

  it('finds nothing wrong with the deployment it was captured from', async () => {
    const read = reader();
    expect(await findAbiMismatches(deployment, read)).toEqual([]);
    // Each call is read at the package the verifier requires calls to target.
    expect(read.calls).toContain(`${deployment.callable.prediction}::waterx_prediction::place_order`);
    expect(read.calls).toContain(`${deployment.callable.framework}::account::request`);
  });

  it('reports a moved argument, a changed arity and a function that is gone', async () => {
    const place = BOUND_FUNCTIONS['waterx_prediction::waterx_prediction::place_order']!;
    const swapped = [...place.parameters];
    [swapped[6], swapped[7]] = [swapped[7]!, swapped[6]!];
    const mismatches = await findAbiMismatches(
      deployment,
      reader({
        'waterx_prediction::waterx_prediction::place_order': { ...place, parameters: swapped },
        'waterx_prediction::waterx_prediction::request_close': { typeParameters: 1, parameters: [] },
        'waterx_account::direct_rule::consume_deposit_direct': undefined,
      }),
    );
    expect(mismatches.map((m) => m.function).sort()).toEqual([
      'waterx_account::direct_rule::consume_deposit_direct',
      'waterx_prediction::waterx_prediction::place_order',
      'waterx_prediction::waterx_prediction::request_close',
    ]);
    expect(mismatches.find((m) => m.function.endsWith('consume_deposit_direct'))?.actual).toBeUndefined();
  });

  it('skips a package the deployment does not call', async () => {
    const read = reader();
    await findAbiMismatches({ ...deployment, callable: { ...deployment.callable, custody: '' } }, read);
    expect(read.calls.some((call) => call.includes('custody_vault'))).toBe(false);
  });

  it('lets a failed read fail, rather than read as a match', async () => {
    await expect(
      findAbiMismatches(deployment, reader({ 'waterx_prediction::waterx_prediction::place_order': 'THROW' })),
    ).rejects.toThrow('read failed');
  });
});
