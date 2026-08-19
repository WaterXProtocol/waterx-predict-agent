/**
 * One signature should not be one command.
 *
 * Every invocation is a fresh process, so without a cache the CLI authenticates
 * every time — and with a browser-wallet or hardware signer that is a human
 * interaction per `market list`. That makes `interactive` unusable in practice,
 * which is a correctness problem for the mode rather than a nicety.
 *
 * The assertions that matter are the ones about NOT using the cache: a token
 * from another deployment, another wallet, an expired one, or a file anyone else
 * on the machine can read. A cache that is wrong in those cases is worse than no
 * cache, because it sends a live credential somewhere nobody chose.
 */
import { describe, expect, it } from 'vitest';

import { AGENT_WALLET, AUTH_OK, BASE_URL, CONFIGURED_ENV, invoke, type InvokeOptions } from './harness.ts';

const HOME = '/home/tester';
const CACHE = `${HOME}/.waterx/cli/session.json`;
const UID = 501;
const WALLET = AGENT_WALLET;
const NOW = '2026-08-12T00:00:00.000Z';

/** A directory and file private to this uid, which is the cache's precondition. */
const privateStat = (overrides: Record<string, { kind: 'directory' | 'file'; mode: number }> = {}) =>
  (path: string) => {
    const preset = overrides[path];
    if (preset !== undefined) return { ...preset, uid: UID };
    if (path === `${HOME}/.waterx/cli`) return { kind: 'directory' as const, uid: UID, mode: 0o700 };
    if (path === CACHE) return { kind: 'file' as const, uid: UID, mode: 0o600 };
    return null;
  };

const stored = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    baseUrl: BASE_URL,
    agentWallet: WALLET,
    token: 'cached-session-token',
    expiresAt: Date.parse(NOW) + 600_000,
    ...over,
  });

const listMarkets = ({ noUid, ...options }: Partial<InvokeOptions> & { noUid?: boolean } = {}) =>
  invoke(['market', 'list', '--limit', '1'], {
    env: CONFIGURED_ENV,
    homeDir: HOME,
    ...(noUid === true ? {} : { uid: UID }),
    nowIso: NOW,
    routes: {
      'POST /agent-api/v1/auth': AUTH_OK,
      'GET /agent-api/v1/predict/markets': { status: 200, body: { markets: [{ marketId: 'm' }] } },
    },
    ...options,
  });

describe('reusing a session', () => {
  it('spends no signature when a valid session is cached', async () => {
    const result = await listMarkets({
      files: { [CACHE]: stored() },
      pathStat: privateStat(),
    });

    expect(result.envelope.ok).toBe(true);
    // The point of the whole feature: no signer process, so no human.
    expect(result.signerRuns).toEqual([]);
    expect(result.fetches.some((f) => f.url.endsWith('/auth'))).toBe(false);
  });

  it('records the session it just minted, so the next command is free', async () => {
    const result = await listMarkets({ pathStat: privateStat({}) });

    expect(result.signerRuns).toHaveLength(1);
    const write = result.secretWrites.find((w) => w.path === CACHE);
    expect(write).toBeDefined();
    const saved = JSON.parse(write?.contents ?? '{}') as Record<string, unknown>;
    expect(saved['token']).toBe(AUTH_OK.body.token);
    expect(saved['baseUrl']).toBe(BASE_URL);
    expect(saved['agentWallet']).toBe(WALLET);
    // The server's own lifetime, turned into an instant. A token whose expiry we
    // invented would be reused until the server rejected it, mid-command.
    expect(saved['expiresAt']).toBe(Date.parse(NOW) + AUTH_OK.body.expiresIn * 1_000);
  });

  it('never lets the cached token reach either stream', async () => {
    const result = await listMarkets({
      files: { [CACHE]: stored() },
      pathStat: privateStat(),
    });
    expect(result.stdout).not.toContain('cached-session-token');
    expect(result.stderr).not.toContain('cached-session-token');
  });
});

describe('refusing to reuse one', () => {
  const mustReauthenticate = async (options: Partial<InvokeOptions>): Promise<void> => {
    const result = await listMarkets(options);
    expect(result.envelope.ok).toBe(true);
    expect(result.signerRuns).toHaveLength(1);
  };

  it('ignores a token minted against a different deployment', async () => {
    await mustReauthenticate({
      files: { [CACHE]: stored({ baseUrl: 'https://other.test.invalid' }) },
      pathStat: privateStat(),
    });
  });

  it('ignores a token minted for a different wallet', async () => {
    await mustReauthenticate({
      files: { [CACHE]: stored({ agentWallet: '0xsomebody-else' }) },
      pathStat: privateStat(),
    });
  });

  it('ignores one that has expired, and one about to', async () => {
    await mustReauthenticate({
      files: { [CACHE]: stored({ expiresAt: Date.parse(NOW) - 1 }) },
      pathStat: privateStat(),
    });
    // Inside the margin: a command that started with seconds left would spend
    // them mid-request and re-authenticate anyway, having paid for the trip.
    await mustReauthenticate({
      files: { [CACHE]: stored({ expiresAt: Date.parse(NOW) + 5_000 }) },
      pathStat: privateStat(),
    });
  });

  it('ignores one whose expiry it cannot read', async () => {
    await mustReauthenticate({
      files: { [CACHE]: stored({ expiresAt: 'soon' }) },
      pathStat: privateStat(),
    });
    await mustReauthenticate({ files: { [CACHE]: 'not json' }, pathStat: privateStat() });
  });

  it('ignores a file another local account can read', async () => {
    await mustReauthenticate({
      files: { [CACHE]: stored() },
      pathStat: privateStat({ [CACHE]: { kind: 'file', mode: 0o644 } }),
    });
  });

  it('ignores a cache directory another local account can reach', async () => {
    await mustReauthenticate({
      files: { [CACHE]: stored() },
      pathStat: privateStat({ [`${HOME}/.waterx/cli`]: { kind: 'directory', mode: 0o755 } }),
    });
  });

  it('writes nothing into a directory it cannot prove private', async () => {
    const result = await listMarkets({
      pathStat: privateStat({ [`${HOME}/.waterx/cli`]: { kind: 'directory', mode: 0o777 } }),
    });
    expect(result.envelope.ok).toBe(true);
    expect(result.secretWrites).toEqual([]);
  });

  it('stays disabled when there is no uid to check ownership against', async () => {
    // The uid is simply not supplied — the shape a runtime without `getuid`
    // produces, and the one that must leave the cache off rather than trusting.
    const result = await listMarkets({
      files: { [CACHE]: stored() },
      pathStat: privateStat(),
      noUid: true,
    });
    expect(result.signerRuns).toHaveLength(1);
    expect(result.secretWrites).toEqual([]);
  });
});
