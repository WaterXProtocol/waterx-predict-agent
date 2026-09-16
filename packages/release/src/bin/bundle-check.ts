#!/usr/bin/env node
/**
 * `pnpm cli:bundle:check` — the one-sentence setup, walked for real, before
 * anyone is told to walk it.
 *
 *   node dist/src/bin/bundle-check.js [--keep]
 *
 * Builds both operator artifacts, installs them together into a throwaway
 * project the way the sentence says — one `npm install`, lifecycle scripts OFF —
 * and then does what `next` says, step by step, the way an agent host and its
 * operator would:
 *
 *   1. `next` on a bare machine          → SETUP_INCOMPLETE, and the first step
 *                                          is `keystore init` (the signer is
 *                                          found installed, so not "install it")
 *   2. `waterx-predict-keystore init`    → a new agent wallet
 *   3. `next`                            → the agent step, and the wallet
 *                                          address filled in from the keystore
 *   4. `waterx-predict-keystore agent`   → resident, holding the key
 *   5. `next`, configured, against a    → the login challenge is signed by the
 *      LOCAL stub API                      keystore; AWAITING_OWNER, with a link
 *   6. the stub now lists a granted     → READY, suggesting market search and
 *      account                            order preview
 *
 * and finally verifies the login signature the stub received with the Sui SDK
 * the install brought, against the address the keystore printed.
 *
 * WHAT IT DOES NOT PROVE: anything about a real server. The API here is a stub
 * on 127.0.0.1 that answers five routes; the owner's grant is a canned response.
 * No request leaves this machine except `npm install`'s registry fetches. The
 * trading path is backlog 1.11, and nothing here stands in for it.
 *
 * The environment every binary runs in is built from scratch — PATH, a
 * throwaway HOME, and only the settings a step says to set — so neither this
 * machine's configuration nor a real credential can make it pass.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBundle } from '../bundle.ts';
import { findRepoRoot } from '../workspace.ts';

interface NextData {
  state?: string;
  stop?: boolean;
  handOver?: { to?: string; authorizationUrl?: string; steps?: { run?: string }[] };
  suggestions?: { command?: string }[];
  facts?: { signer?: { kind?: string; agent?: string } };
}

interface Envelope {
  ok?: boolean;
  command?: string;
  data?: NextData;
}

const ACCOUNT_ID = `0x${'c'.repeat(63)}2`;

class Walk {
  readonly problems: string[] = [];

  expect(condition: boolean, problem: string): void {
    if (!condition) this.problems.push(problem);
  }
}

/**
 * Asynchronous on purpose: the stub API lives in this process, and a
 * `spawnSync` would hold its event loop while the CLI waits on it.
 */
function run(
  project: string,
  env: Record<string, string>,
  args: readonly string[],
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--no', ...args], {
      cwd: project,
      env: { PATH: process.env['PATH'] ?? '', npm_config_update_notifier: 'false', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (exit) => {
      clearTimeout(timer);
      resolve({ exit, stdout, stderr });
    });
  });
}

async function next(walk: Walk, project: string, env: Record<string, string>, label: string): Promise<NextData> {
  const result = await run(project, env, ['waterx-predict', 'next', '--json']);
  let envelope: Envelope | undefined;
  try {
    envelope = JSON.parse(result.stdout) as Envelope;
  } catch {
    walk.problems.push(`${label}: \`next --json\` did not print one JSON document: ${result.stderr.slice(0, 300)}`);
    return {};
  }
  walk.expect(result.exit === 0, `${label}: \`next --json\` exited ${String(result.exit)}`);
  walk.expect(envelope.ok === true && envelope.command === 'runtime.next', `${label}: not a runtime.next answer`);
  return envelope.data ?? {};
}

const stepRuns = (data: NextData): string[] => (data.handOver?.steps ?? []).map((step) => step.run ?? '');

/** The local API: five routes, and a record of the one request worth checking. */
function startStub(): Promise<{ server: Server; url: string; auth: { body?: Record<string, unknown> }; grant(): void }> {
  const auth: { body?: Record<string, unknown> } = {};
  let granted = false;
  const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
  const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  const route = async (request: IncomingMessage) => {
    const path = new URL(request.url ?? '/', 'http://stub').pathname;
    if (request.method === 'POST' && path === '/agent-api/v1/auth') {
      auth.body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      return json(200, { token: 'stub-session-token-0123456789', expiresIn: 900 });
    }
    if (request.method === 'GET' && path === '/agent-api/v1/predict/accounts') {
      const account = {
        accountId: ACCOUNT_ID,
        ownerAddress: `0x${'e'.repeat(63)}4`,
        isSuspended: false,
        policyVersion: 1,
        delegation: { mayPlaceOrder: true, mayRequestClose: true, checkedAt: new Date().toISOString() },
        grantedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return json(200, { accounts: granted ? [account] : [] });
    }
    if (request.method === 'GET' && path === `/agent-api/v1/predict/accounts/${ACCOUNT_ID}/effective-limits`) {
      const allowance = {
        apiAllowance: { limit: '100', reserved: '0', deployed: '0', available: '100' },
        accountSpendableBalance: '100',
        effectiveBuyCapacity: '100',
      };
      return json(200, {
        accountId: ACCOUNT_ID,
        agentWallet: String(auth.body?.['walletAddress'] ?? ''),
        limits: {
          allowanceLimit: '100', maxOrderAmount: '10', maxSlippageBps: 300, maxOrdersPerHour: 10,
          maxNotionalPerHour: '100', maxInFlightExecutions: 2, isSuspended: false, policyVersion: 1,
          updatedAt: new Date().toISOString(),
        },
        allowance,
        usage: { windowSeconds: 3600, ordersInWindow: 0, notionalInWindow: '0', inFlightExecutions: 0 },
        delegation: { mayPlaceOrder: true, mayRequestClose: true, checkedAt: new Date().toISOString() },
        blockers: [],
        asOf: new Date().toISOString(),
      });
    }
    if (request.method === 'GET' && path === `/agent-api/v1/predict/accounts/${ACCOUNT_ID}/executions`) {
      return json(200, { executions: [], nextCursor: null });
    }
    if (request.method === 'GET' && path === `/agent-api/v1/predict/accounts/${ACCOUNT_ID}/positions`) {
      return json(200, { positions: [], nextCursor: null });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `the stub has no ${request.method ?? ''} ${path}`, retryable: false } });
  };
  const server = createServer((request, response) => {
    void route(request).then(({ status, body }) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${String(port)}`, auth, grant: () => { granted = true; } });
    });
  });
}

async function waitFor(path: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function main(argv: readonly string[]): Promise<number> {
  const keep = argv.includes('--keep');
  const staging = mkdtempSync(join(tmpdir(), 'wxb-'));
  const project = join(staging, 'consumer');
  // Short on purpose: the agent's socket path has a ~100-byte OS limit.
  const keystoreDir = mkdtempSync('/tmp/wxk-');
  const walk = new Walk();
  let agent: ChildProcess | undefined;
  let stub: Awaited<ReturnType<typeof startStub>> | undefined;

  try {
    const bundle = buildBundle(findRepoRoot(), join(staging, 'out'));
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'package.json'),
      `${JSON.stringify({ name: 'agent-workspace', private: true, version: '0.0.0' }, null, 2)}\n`,
      'utf8',
    );

    process.stderr.write(`installing ${bundle.artifacts.map((artifact) => artifact.fileName).join(' and ')}, scripts disabled…\n`);
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...bundle.artifacts.map((artifact) => artifact.filePath)],
      { cwd: project, stdio: 'ignore' },
    );

    for (const artifact of bundle.artifacts) {
      for (const name of artifact.bundled) {
        // Inside the artifact only. A top-level copy means something asked for
        // it by range and went to a registry.
        walk.expect(
          !existsSync(join(project, 'node_modules', ...name.split('/'))),
          `${name} was installed beside ${artifact.name}, not from it`,
        );
      }
    }

    const home = join(staging, 'home');
    mkdirSync(home, { recursive: true });
    const passphraseFile = join(staging, 'passphrase');
    writeFileSync(passphraseFile, 'bundle-check-passphrase\n', { mode: 0o600 });
    const bare = { HOME: home, WATERX_KEYSTORE_DIR: keystoreDir };

    // 1. A bare machine.
    const first = await next(walk, project, bare, 'bare');
    walk.expect(first.state === 'SETUP_INCOMPLETE' && first.stop === true, `bare: answered ${String(first.state)}`);
    walk.expect(
      stepRuns(first)[0] === 'npx --no waterx-predict-keystore init',
      `bare: the first step was ${JSON.stringify(stepRuns(first)[0])}, not keystore init — the installed signer was not found`,
    );

    const describe = await run(project, bare, ['waterx-predict', 'describe']);
    walk.expect(describe.exit === 0 && describe.stdout.includes('"runtime.describe"'), `describe exited ${String(describe.exit)}`);

    // 2. The operator creates the agent wallet.
    const keystoreEnv = { ...bare, WATERX_KEYSTORE_PASSPHRASE_FILE: passphraseFile };
    const init = await run(project, keystoreEnv, ['waterx-predict-keystore', 'init']);
    let address = '';
    try {
      address = String((JSON.parse(init.stdout) as { address?: unknown }).address ?? '');
    } catch {
      walk.problems.push(`keystore init did not print its address: ${init.stderr.split('\n')[0] ?? ''}`);
    }
    walk.expect(/^0x[0-9a-f]{64}$/u.test(address), `keystore init printed ${JSON.stringify(address)}`);

    // 3. `next` now knows the address and wants the agent started.
    const second = await next(walk, project, bare, 'after init');
    walk.expect(
      JSON.stringify(stepRuns(second)) ===
        JSON.stringify([
          'npx --no waterx-predict-keystore agent',
          `export WATERX_PREDICT_AGENT_WALLET=${address}`,
          `export WATERX_PREDICT_SIGNER_COMMAND='["waterx-predict-keystore","sign"]'`,
        ]),
      `after init: steps were ${JSON.stringify(stepRuns(second))}`,
    );

    // 4. The operator starts the agent, once, and leaves it.
    // The linked binary itself rather than through `npx`, so the SIGTERM at the
    // end reaches the process holding the key and not only a wrapper.
    agent = spawn(join(project, 'node_modules', '.bin', 'waterx-predict-keystore'), ['agent'], {
      cwd: project,
      env: { PATH: process.env['PATH'] ?? '', npm_config_update_notifier: 'false', ...keystoreEnv },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    walk.expect(await waitFor(join(keystoreDir, 'keystore.sock'), 30_000), 'the keystore agent never opened its socket');

    // 5. Configured as `next` said, against a local stub.
    stub = await startStub();
    const configured = {
      ...bare,
      WATERX_PREDICT_BASE_URL: stub.url,
      WATERX_PREDICT_CONSOLE_URL: `${stub.url}/console`,
      WATERX_PREDICT_AGENT_WALLET: address,
      WATERX_PREDICT_SIGNER_COMMAND: '["waterx-predict-keystore","sign"]',
    };
    const third = await next(walk, project, configured, 'configured');
    walk.expect(
      third.state === 'AWAITING_OWNER' && third.handOver?.to === 'ACCOUNT_OWNER',
      `configured: answered ${String(third.state)}${third.state === 'SESSION_FAILED' ? ' — the keystore did not sign the login' : ''}`,
    );
    const link = third.handOver?.authorizationUrl ?? '';
    walk.expect(link.includes(`agent=${address}`), `configured: the authorization link does not name ${address}: ${link}`);
    walk.expect(third.facts?.signer?.kind === 'KEYSTORE', 'configured: the signer was not reported as the keystore');

    // 6. The owner grants; the loop reaches READY.
    stub.grant();
    const fourth = await next(walk, project, configured, 'granted');
    walk.expect(fourth.state === 'READY', `granted: answered ${String(fourth.state)}`);
    const commands = (fourth.suggestions ?? []).map((row) => row.command);
    walk.expect(
      commands.includes('market.search') && commands.includes('order.preview'),
      `granted: suggested ${JSON.stringify(commands)}`,
    );

    // The login the stub received was signed by the key the keystore holds.
    const body = stub.auth.body;
    walk.expect(body?.['walletAddress'] === address, 'the login named a different wallet than the keystore holds');
    if (body !== undefined) {
      const verify = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { verifyPersonalMessageSignature } = await import('@mysten/sui/verify');
           const b = JSON.parse(process.argv[1]);
           const key = await verifyPersonalMessageSignature(new TextEncoder().encode(b.message), b.signature);
           if (key.toSuiAddress() !== b.walletAddress) { console.error('signed by ' + key.toSuiAddress()); process.exit(1); }`,
          JSON.stringify(body),
        ],
        { cwd: project, encoding: 'utf8' },
      );
      walk.expect(verify.status === 0, `the login signature did not verify: ${(verify.stderr ?? '').split('\n')[0] ?? ''}`);
    }

    for (const artifact of bundle.artifacts) {
      process.stderr.write(`  ${artifact.name}@${artifact.version}  sha256 ${artifact.sha256}\n`);
    }
    if (walk.problems.length > 0) {
      process.stderr.write(`\n${String(walk.problems.length)} problem(s):\n`);
      for (const problem of walk.problems) process.stderr.write(`  ${problem}\n`);
      return 1;
    }
    process.stderr.write(
      '\nInstalled with npm alone and scripts off; followed `next` from SETUP_INCOMPLETE through keystore init and agent to AWAITING_OWNER and READY against a local stub, with the login signed by the keystore and verified.\n',
    );
    return 0;
  } finally {
    agent?.kill('SIGTERM');
    stub?.server.close();
    if (keep) {
      process.stderr.write(`kept: ${staging} and ${keystoreDir}\n`);
    } else {
      rmSync(staging, { recursive: true, force: true });
      rmSync(keystoreDir, { recursive: true, force: true });
    }
  }
}

process.exitCode = await main(process.argv.slice(2));
