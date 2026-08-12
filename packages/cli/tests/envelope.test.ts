/**
 * The contract every caller depends on before it depends on anything else:
 * stdout is exactly one JSON document, on every path, and the exit code says
 * what happened without the caller having to read the document at all.
 *
 * If these fail, nothing else in this package is trustworthy — a caller that
 * cannot parse stdout cannot even read the error explaining why.
 */
import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/index.ts';
import { ALLOWANCE_OK, AUTH_OK, ACCOUNT_ID, CONFIGURED_ENV, invoke } from './harness.ts';

describe('the stdout envelope', () => {
  it('writes exactly one parseable document when a command succeeds', async () => {
    const result = await invoke(['describe']);

    expect(result.writes).toBe(1);
    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.schemaVersion).toBe('1');
    expect(result.envelope.command).toBe('runtime.describe');
    expect(result.envelope.error).toBeUndefined();
  });

  it('keeps the same shape when the command fails', async () => {
    const result = await invoke(['market', 'list']);

    expect(result.writes).toBe(1);
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.schemaVersion).toBe('1');
    expect(result.envelope.command).toBe('market.list');
    expect(result.envelope.error?.source).toBe('CLI');
    expect(result.envelope.data).toBeUndefined();
  });

  it('still writes one document when no command was given at all', async () => {
    const result = await invoke([]);

    expect(result.writes).toBe(1);
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error?.code).toBe('USAGE');
    expect(result.exit).toBe(EXIT_CODES.USAGE);
  });

  it('puts usage prose on stderr and never on stdout', async () => {
    const result = await invoke(['--help']);

    expect(result.stderr).toContain('Usage: waterx-predict');
    expect(result.stdout).not.toContain('Usage:');
    // Parses cleanly: the whole stream is the document, with no banner around it.
    expect(result.envelope.ok).toBe(false);
  });

  it('carries a request id that ties stdout to stderr', async () => {
    const result = await invoke(['describe']);
    expect(result.envelope.requestId).toBe('req-fixed-0001');
  });

  it('reports every default it applied rather than applying it silently', async () => {
    const result = await invoke(['account', 'allowance'], {
      env: { ...CONFIGURED_ENV, WATERX_PREDICT_ACCOUNT_ID: ACCOUNT_ID },
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        [`GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/allowance`]: ALLOWANCE_OK,
      },
    });

    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.meta?.defaultsApplied).toEqual({ accountId: ACCOUNT_ID });
  });

  it('warns about plaintext transport instead of quietly using it', async () => {
    const result = await invoke(['describe'], {
      env: { ...CONFIGURED_ENV, WATERX_PREDICT_BASE_URL: 'http://api.example.com' },
    });

    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.meta?.warnings?.join(' ')).toMatch(/http/iu);
  });

  it('omits meta entirely when there is nothing to report', async () => {
    const result = await invoke(['describe']);
    expect(result.envelope.meta).toBeUndefined();
  });
});

describe('exit codes', () => {
  it('separates a malformed invocation from a rejected input', async () => {
    const usage = await invoke(['market', 'list', '--nonsense', 'x']);
    expect(usage.exit).toBe(EXIT_CODES.USAGE);
    expect(usage.envelope.error?.code).toBe('USAGE');

    // Well-formed flag, value the schema refuses.
    const invalid = await invoke(['market', 'get', '--marketId', ''], { env: CONFIGURED_ENV });
    expect(invalid.exit).toBe(EXIT_CODES.INVALID_INPUT);
    expect(invalid.envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('exits on configuration before it opens a socket', async () => {
    const result = await invoke(['market', 'list']);

    expect(result.exit).toBe(EXIT_CODES.CONFIG);
    expect(result.envelope.error?.code).toBe('NOT_CONFIGURED');
    expect(result.fetches).toHaveLength(0);
  });

  it('derives the exit code from the server code, not from the HTTP status', async () => {
    const result = await invoke(['market', 'list'], {
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': {
          status: 403,
          body: { error: { code: 'RISK_LIMIT_EXCEEDED', message: 'over limit', retryable: false } },
        },
      },
    });

    expect(result.envelope.error?.source).toBe('SERVER');
    expect(result.envelope.error?.code).toBe('RISK_LIMIT_EXCEEDED');
    expect(result.exit).toBe(EXIT_CODES.POLICY);
  });

  it('copies the server’s retryable flag rather than re-deriving one', async () => {
    const result = await invoke(['market', 'list'], {
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': {
          status: 429,
          body: { error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true } },
        },
      },
    });

    expect(result.envelope.error?.retryable).toBe(true);
    expect(result.exit).toBe(EXIT_CODES.RATE_LIMITED);
  });

  it('reports a transport failure as TRANSPORT, because nothing refused anything', async () => {
    const result = await invoke(['market', 'list'], {
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': { throws: new TypeError('fetch failed') },
      },
    });

    expect(result.envelope.error?.source).toBe('TRANSPORT');
    expect(result.exit).toBe(EXIT_CODES.TRANSPORT);
  });
});
