/**
 * The Runner in direct mode (ADR-0016): no session, no server mandate, prices
 * polled from the public board, and a gateway that signs nothing itself.
 */
import { readFileSync } from 'node:fs';

import type { GetMarketResponseBody } from '@waterx/predict-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { RunnerDriverConfig } from '../src/config.ts';
import { PollingPriceObserver } from '../src/prices.ts';
import { buildRunnerDriver } from '../src/runtime.ts';
import { classifyAuthorization } from '../src/strategy/preflight.ts';
import { T0, later } from './harness.ts';
import { limits, market } from './strategy-fakes.ts';

const DEPLOYMENT = JSON.parse(
  readFileSync(new URL('../../sdk/tests/fixtures/waterx-config-mainnet.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('authorization without a server mandate', () => {
  const needs = { place: true, close: false };

  it('does not wait for a mandate that cannot exist', () => {
    const none = limits({ limits: null, allowance: null });
    expect(classifyAuthorization(none, needs)).toMatchObject({ kind: 'PAUSE', reason: 'NO_MANDATE' });
    expect(classifyAuthorization(none, needs, 'NONE')).toBeUndefined();
  });

  it('still stops on a revoked delegation, and pauses on an unreadable one', () => {
    const revoked = limits({ limits: null, delegation: { mayPlaceOrder: false, mayRequestClose: true, checkedAt: T0 } });
    expect(classifyAuthorization(revoked, needs, 'NONE')).toMatchObject({ kind: 'STOP', reason: 'DELEGATION_REVOKED' });
    const unknown = limits({ limits: null, delegation: { mayPlaceOrder: null, mayRequestClose: null, checkedAt: T0 } });
    expect(classifyAuthorization(unknown, needs, 'NONE')).toMatchObject({ kind: 'PAUSE', reason: 'DELEGATION_UNREADABLE' });
  });
});

describe('prices polled from the public board', () => {
  const quoted = (tradeable = true): GetMarketResponseBody => ({
    market: market({
      tradeable,
      outcomes: [{ outcomeId: 'YES', name: 'up', impliedProbability: null, indicativeBid: '0.41', indicativeAsk: '0.43' }],
    }),
  });

  it('answers the watched side, and reads the board at most once per interval', async () => {
    let reads = 0;
    let at = T0;
    const observer = new PollingPriceObserver({
      source: { getMarket: async () => ((reads += 1), quoted()) },
      now: () => at,
      minPollMs: 5_000,
    });
    expect(await observer.observe({ marketId: 'm', outcomeId: 'YES', side: 'BUY' })).toBe('0.43');
    expect(await observer.observe({ marketId: 'm', outcomeId: 'YES', side: 'SELL' })).toBe('0.41');
    expect(reads).toBe(1);
    at = later(T0, 5_000);
    await observer.observe({ marketId: 'm', outcomeId: 'YES', side: 'BUY' });
    expect(reads).toBe(2);
    expect(observer.topics()).toMatchObject([{ marketId: 'm', outcomeId: 'YES', unavailable: undefined }]);
  });

  it('observes nothing from a closed market, a missing outcome or a failed read', async () => {
    const closed = new PollingPriceObserver({ source: { getMarket: async () => quoted(false) }, now: () => T0 });
    expect(await closed.observe({ marketId: 'm', outcomeId: 'YES', side: 'BUY' })).toBeNull();
    expect(closed.topics()[0]?.unavailable).toBe('MARKET_CLOSED');

    const missing = new PollingPriceObserver({ source: { getMarket: async () => quoted() }, now: () => T0 });
    expect(await missing.observe({ marketId: 'm', outcomeId: 'NO', side: 'BUY' })).toBeNull();

    const notes: string[] = [];
    const failing = new PollingPriceObserver({
      source: { getMarket: async () => Promise.reject(new Error('boom')) },
      now: () => T0,
      onDiagnostic: (text) => notes.push(text),
    });
    expect(await failing.observe({ marketId: 'm', outcomeId: 'YES', side: 'BUY' })).toBeNull();
    expect(failing.topics()[0]?.unavailable).toBe('DISCONNECTED');
    expect(notes.join(' ')).toMatch(/boom/u);

    failing.close();
    expect(await failing.observe({ marketId: 'm', outcomeId: 'YES', side: 'BUY' })).toBeNull();
  });
});

describe('the direct-mode driver', () => {
  const CONFIG: RunnerDriverConfig = {
    mode: 'direct',
    network: 'mainnet',
    baseUrl: 'https://waterx.test.invalid',
    agentWallet: `0x${'a'.repeat(64)}`,
    signerCommand: ['/opt/keystore/bin/waterx-sign'],
    signerTimeoutMs: 4_000,
  };

  it('opens no session, declares no server mandate, and reads the delegation for authorization', async () => {
    const calls: string[] = [];
    const fetch = (async (input: URL | string) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === '/mainnet.json') return new Response(JSON.stringify(DEPLOYMENT));
      if (url.pathname === '/graphql') {
        // The account object as the chain prints it: this agent, mask 9, under
        // the deployment's own prediction key.
        const packages = DEPLOYMENT['packages'] as Record<string, { original_id: string }>;
        return new Response(
          JSON.stringify({
            data: {
              object: {
                asMoveObject: {
                  contents: {
                    type: { repr: `${packages['waterx_account']!.original_id}::account::Account` },
                    json: {
                      owner_address: `0x${'e'.repeat(64)}`,
                      delegates: [
                        {
                          delegate_address: CONFIG.agentWallet,
                          protocol_permissions: {
                            contents: [
                              { key: `${packages['waterx_prediction']!.original_id.slice(2)}::account_data::WaterXPrediction`, value: 9 },
                            ],
                          },
                          expires_at_ms: null,
                        },
                      ],
                    },
                  },
                },
              },
            },
          }),
        );
      }
      if (url.pathname === '/account/delegated') {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              accounts: [
                {
                  accountId: `0x${'c'.repeat(64)}`,
                  ownerAddress: `0x${'e'.repeat(64)}`,
                  delegate: { delegateAddress: CONFIG.agentWallet, predictPermissions: 9, expiresAtMs: null },
                },
              ],
              unverifiedAccounts: [],
              truncated: false,
            },
          }),
        );
      }
      throw new Error(`no ${url.pathname}`);
    }) as unknown as typeof globalThis.fetch;
    const runs: unknown[] = [];
    const bundle = buildRunnerDriver(CONFIG, {
      run: async (...args) => {
        runs.push(args);
        return { code: 0, stdout: '{}', stderr: '', timedOut: false };
      },
      now: () => T0,
      fetch,
      marketCatalog: { get: () => undefined, put: () => undefined },
    });
    try {
      expect(bundle.driver.gateway.mandate).toBe('NONE');
      const facts = await bundle.driver.gateway.getEffectiveLimits(`0x${'c'.repeat(64)}`);
      expect(facts).toMatchObject({ limits: null, blockers: [], delegation: { mayPlaceOrder: true, mayRequestClose: true } });
      expect(calls.some((path) => path.includes('/agent-api'))).toBe(false);
      // Building the driver signed nothing and spawned nothing.
      expect(runs).toHaveLength(0);
      expect(bundle.prices.topics()).toEqual([]);
    } finally {
      bundle.close();
    }
  });
});
