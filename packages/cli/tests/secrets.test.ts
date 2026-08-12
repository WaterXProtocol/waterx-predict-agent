/**
 * Nothing that could authorize a spend may leave this process.
 *
 * The threat is not one careless `console.log`. It is that an agent archives the
 * CLI's stdout, and a token, a signature or a key path that appeared there once
 * is then in a transcript, a log aggregator and a model's context forever. So
 * these tests check the OUTPUT, not the intent: whatever the code does, the
 * secret must not be in the bytes.
 */
import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/index.ts';
import {
  ACCOUNT_ID,
  ALLOWANCE_OK,
  AUTH_OK,
  BASE_URL,
  CONFIGURED_ENV,
  invoke,
} from './harness.ts';

const TOKEN = 'supplied-token-that-must-never-be-printed';

describe('secrets', () => {
  it('never prints a supplied token, on the success path', async () => {
    const result = await invoke(['account', 'allowance', '--accountId', ACCOUNT_ID], {
      env: { ...CONFIGURED_ENV, WATERX_PREDICT_TOKEN: TOKEN },
      routes: {
        [`GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/allowance`]: ALLOWANCE_OK,
      },
    });

    expect(result.envelope.ok).toBe(true);
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stderr).not.toContain(TOKEN);
  });

  it('never prints a supplied token when the server quotes it back in an error', async () => {
    const result = await invoke(['account', 'allowance', '--accountId', ACCOUNT_ID], {
      env: { ...CONFIGURED_ENV, WATERX_PREDICT_TOKEN: TOKEN },
      routes: {
        // The SDK replaces a rejected token once before giving up; the retry
        // meets the same 401, so the server's refusal is what surfaces.
        'POST /agent-api/v1/auth': AUTH_OK,
        [`GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/allowance`]: {
          status: 401,
          body: {
            error: {
              code: 'UNAUTHENTICATED',
              // A server that echoes the credential is exactly the case the
              // redactor exists for: the CLI did not choose to print this.
              message: `token ${TOKEN} is not valid`,
              retryable: false,
            },
          },
        },
      },
    });

    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error?.code).toBe('UNAUTHENTICATED');
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stdout).toContain('[redacted]');
    expect(result.exit).toBe(EXIT_CODES.AUTH);
  });

  it('never prints a token minted from the signer handshake', async () => {
    const result = await invoke(['market', 'list'], {
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': { status: 200, body: { markets: [] } },
      },
    });

    expect(result.envelope.ok).toBe(true);
    expect(result.stdout).not.toContain(AUTH_OK.body.token);
    expect(result.stderr).not.toContain(AUTH_OK.body.token);
  });

  it('keeps the signer’s own stderr off stdout', async () => {
    const noise = 'signer: loaded key from /Users/someone/.keys/agent.key';
    const result = await invoke(['market', 'list'], {
      env: CONFIGURED_ENV,
      signer: () => ({
        stdout: JSON.stringify({ signature: 'sig' }),
        stderr: noise,
      }),
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': { status: 200, body: { markets: [] } },
      },
    });

    expect(result.stderr).toContain(noise);
    expect(result.stdout).not.toContain('agent.key');
  });

  it('never puts a signature in the envelope', async () => {
    const signature = 'AAAAsignature-material-that-should-not-be-archived';
    const result = await invoke(['market', 'list'], {
      env: CONFIGURED_ENV,
      signer: () => ({ stdout: JSON.stringify({ signature }) }),
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': { status: 200, body: { markets: [] } },
      },
    });

    expect(result.stdout).not.toContain(signature);
    // It did reach the wire, which is the point: it is sent, not printed.
    const auth = result.fetches.find((call) => call.url.endsWith('/auth'));
    expect((auth?.body as { signature?: string } | undefined)?.signature).toBe(signature);
  });

  it('refuses a config file that holds a credential, and names the key, not the value', async () => {
    const path = '/tmp/waterx-cli-test-config.json';
    const result = await invoke(['describe'], {
      env: { WATERX_PREDICT_CONFIG: path },
      files: {
        [path]: JSON.stringify({
          baseUrl: BASE_URL,
          privateKey: 'suiprivkey1qq-never-put-this-in-a-file',
        }),
      },
    });

    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error?.code).toBe('CONFIG_CONTAINS_SECRET');
    expect(result.stdout).toContain('privateKey');
    expect(result.stdout).not.toContain('suiprivkey1qq');
    expect(result.exit).toBe(EXIT_CODES.CONFIG);
  });

  it('reports the signer executable by name and never the whole argv', async () => {
    const result = await invoke(['describe'], {
      env: {
        ...CONFIGURED_ENV,
        WATERX_PREDICT_SIGNER_COMMAND: JSON.stringify([
          '/opt/waterx/sign',
          '--keystore',
          '/Users/someone/.keys/agent.key',
        ]),
      },
    });

    expect(result.stdout).toContain('sign');
    expect(result.stdout).not.toContain('agent.key');
  });
});
