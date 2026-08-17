/**
 * What this runtime refuses, and how it refuses.
 *
 * `market history` is the test that matters most here. It is a thing an agent
 * will obviously ask for, and it has no server endpoint behind it. The
 * temptation is to fake it by diffing two quote snapshots, which would make this
 * CLI a second source of truth for prices nothing honoured.
 *
 * So the refusal itself is the feature under test: it must name the capability,
 * give a symbolic reason, point somewhere useful, and never touch the network.
 *
 * `market search` used to be the other one, and its test is now the opposite
 * assertion — that a capability leaves the refusal list only because the SERVER
 * grew an endpoint, never because the client learned to approximate one.
 */
import { describe, expect, it } from 'vitest';

import { CAPABILITIES, EXIT_CODES, listRefusals } from '../src/index.ts';
import {
  ACCOUNT_ID,
  AUTH_OK,
  CONFIGURED_ENV,
  EFFECTIVE_LIMITS_OK,
  invoke,
} from './harness.ts';

describe('capability negotiation', () => {
  it('runs `market search` now that the SERVER resolves the text', async () => {
    const result = await invoke(['market', 'search', '--search', 'election'], {
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': {
          status: 200,
          body: {
            markets: [],
            resolution: {
              status: 'NOT_FOUND',
              normalizedQuery: 'election',
              marketId: null,
              matchCount: 0,
            },
          },
        },
      },
    });

    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.command).toBe('market.search');
    // The decisive assertion is unchanged in spirit: no id was produced locally.
    // The server said NOT_FOUND, and NOT_FOUND is what comes back.
    expect((result.envelope.data as { marketId: string | null }).marketId).toBeNull();
    expect(result.exit).toBe(EXIT_CODES.AMBIGUOUS);
  });

  it('runs `account risk-limits` now that an agent credential may read the mandate', async () => {
    const result = await invoke(['account', 'risk-limits', '--accountId', ACCOUNT_ID], {
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        [`GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/effective-limits`]: EFFECTIVE_LIMITS_OK,
      },
    });

    expect(result.envelope.ok).toBe(true);
    expect(result.exit).toBe(EXIT_CODES.OK);
    // Readable, and still not writable: nothing in this build can raise a limit.
    expect((result.envelope.data as { limits: { available: boolean } }).limits.available).toBe(true);
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
    // supervising the daemon itself is specified and unbuilt. Both refuse before
    // the network, and a caller can branch on which of the two it hit.
    const noEndpoint = await invoke(['order', 'cancel'], { env: CONFIGURED_ENV });
    expect(noEndpoint.envelope.error?.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(noEndpoint.envelope.error?.details).toMatchObject({
      capability: 'order cancel',
      reason: 'NO_SERVER_ENDPOINT',
    });

    // The strategy family left this test when the Runner grew a socket. What
    // remains unbuilt is starting and stopping one from here — and the two must
    // stay distinguishable, because `strategy list` failing means "no Runner is
    // running" while `runner start` failing means "this CLI cannot start one".
    const notBuilt = await invoke(['runner', 'start'], { env: CONFIGURED_ENV });
    expect(notBuilt.envelope.error?.code).toBe('COMMAND_NOT_IMPLEMENTED');
    expect(notBuilt.envelope.error?.details).toMatchObject({
      capability: 'runner',
      reason: 'NOT_BUILT',
    });

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
