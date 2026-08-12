/**
 * What this runtime refuses, and how it refuses.
 *
 * `market search` and `market history` are the tests that matter most here.
 * Both are things an agent will obviously ask for, and both have no server
 * endpoint behind them. The temptation is to fake them — fetch a page and match
 * text locally for `search`, diff two snapshots for `history`. Either would make
 * this CLI a second source of truth for market identity, and an agent that
 * traded on a locally-guessed market id would be trading the wrong market.
 *
 * So the refusal itself is the feature under test: it must name the capability,
 * give a symbolic reason, point somewhere useful, and never touch the network.
 */
import { describe, expect, it } from 'vitest';

import { CAPABILITIES, EXIT_CODES, listRefusals } from '../src/index.ts';
import { CONFIGURED_ENV, invoke } from './harness.ts';

describe('capability negotiation', () => {
  it('refuses `market search` without approximating it', async () => {
    const result = await invoke(['market', 'search', '--query', 'election'], {
      env: CONFIGURED_ENV,
      routes: { 'GET /agent-api/v1/predict/markets': { status: 200, body: { markets: [] } } },
    });

    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.command).toBe('market search');
    expect(result.envelope.error?.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(result.envelope.error?.details).toMatchObject({
      capability: 'market search',
      reason: 'NO_SERVER_ENDPOINT',
      tracking: 'B2',
    });
    expect(result.exit).toBe(EXIT_CODES.UNAVAILABLE);
    // The decisive assertion: no catalog was fetched, so no identity was guessed.
    expect(result.fetches).toHaveLength(0);
  });

  it('refuses `market history` and says what to use instead', async () => {
    const result = await invoke(['market', 'history'], { env: CONFIGURED_ENV });

    expect(result.envelope.error?.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(result.envelope.error?.details).toMatchObject({
      capability: 'market history',
      reason: 'NO_SERVER_ENDPOINT',
    });
    expect(
      (result.envelope.error?.details as { alternative?: string }).alternative,
    ).toBeTypeOf('string');
    expect(result.fetches).toHaveLength(0);
  });

  it('separates "no endpoint exists" from "not built yet"', async () => {
    // `order cancel` has no endpoint and never will for a market order;
    // `strategy` is specified and unbuilt. Both refuse before the network, and
    // a caller can branch on which of the two it hit.
    const noEndpoint = await invoke(['order', 'cancel'], { env: CONFIGURED_ENV });
    expect(noEndpoint.envelope.error?.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(noEndpoint.envelope.error?.details).toMatchObject({
      capability: 'order cancel',
      reason: 'NO_SERVER_ENDPOINT',
    });

    const notBuilt = await invoke(['strategy', 'create'], { env: CONFIGURED_ENV });
    expect(notBuilt.envelope.error?.code).toBe('COMMAND_NOT_IMPLEMENTED');

    for (const result of [noEndpoint, notBuilt]) {
      expect(result.exit).toBe(EXIT_CODES.UNAVAILABLE);
      expect(result.fetches).toHaveLength(0);
      expect(result.signerRuns).toHaveLength(0);
    }
  });

  it('answers an invented command with UNKNOWN_COMMAND, not a refusal', async () => {
    const result = await invoke(['teleport'], { env: CONFIGURED_ENV });

    expect(result.envelope.error?.code).toBe('UNKNOWN_COMMAND');
    expect(result.exit).toBe(EXIT_CODES.USAGE);
  });

  it('lists every refusal with a reason and something to do about it', () => {
    const refusals = listRefusals();
    expect(refusals.length).toBeGreaterThan(0);
    for (const capability of refusals) {
      expect(capability.status, capability.id).not.toBe('AVAILABLE');
      expect(capability.reason, capability.id).toBeTypeOf('string');
      expect(capability.detail, capability.id).toBeTypeOf('string');
    }
  });

  it('never marks a capability available without naming the command behind it', () => {
    for (const capability of CAPABILITIES) {
      if (capability.status !== 'AVAILABLE') continue;
      expect(capability.command, capability.id).toBeTypeOf('string');
    }
  });
});
