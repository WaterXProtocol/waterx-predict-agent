#!/usr/bin/env node
/**
 * `pnpm install:check` — the one-sentence setup in its GIT-INSTALL shape,
 * walked for real before anyone is told to run it (ADR-0019).
 *
 *   node dist/src/bin/install-check.js [--keep]
 *
 * What `npm install github:WaterXProtocol/waterx-predict-agent` does is: clone,
 * run the root `prepare` (which builds this workspace and assembles
 * `dist/install/`), pack what `files` names, and install that. This packs the
 * working tree the same way — `npm pack` runs the same `prepare` — installs the
 * tarball into a throwaway project with lifecycle scripts OFF, and then:
 *
 *   1. `npx --no waterx-predict describe`  → a runtime that answers with no
 *                                            configuration and no network
 *   2. `npx --no waterx-predict next --json` → SETUP_INCOMPLETE, and the steps
 *                                            it may run itself are the keystore
 *                                            and `configure`
 *   3. those steps, run verbatim            → a wallet, and a config file that
 *                                            points at it
 *   4. `next` again                        → past setup, with no person and no
 *                                            resident agent involved
 *
 * Steps 2–4 are the walk a model host actually does, run as it would run it:
 * the commands come out of `agentSteps` rather than being spelled here, so a
 * hand-over that stops being runnable fails this check (ADR-0020).
 *
 * WHAT IT DOES NOT PROVE: that GitHub serves it. Nothing here clones over the
 * network; the packed tree is identical to the one a clone would pack, but a
 * real `npm install github:…` also needs the caller's git credentials for a
 * private repository. No key of this machine is touched: the keystore runs
 * against a throwaway HOME and its own directory.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findRepoRoot } from '../workspace.ts';

interface Envelope {
  ok?: boolean;
  command?: string;
  error?: { code?: string; message?: string };
  data?: {
    state?: string;
    handOver?: { steps?: { run?: string }[] };
    agentSteps?: { run?: string }[];
    facts?: { signer?: { kind?: string }; agentWallet?: string | null };
  };
}

const problems: string[] = [];
const expect = (condition: boolean, problem: string): void => {
  if (!condition) problems.push(problem);
};

/**
 * One command in the installed project.
 *
 * Both streams are captured rather than inherited, because two of the
 * assertions below are about stderr — a warning nobody can see is a warning
 * that is not there. A non-zero exit is returned rather than thrown: this walk
 * wants to report every problem it found, not the first.
 */
function run(
  project: string,
  env: Record<string, string>,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['--no', ...args], {
    cwd: project,
    env: { PATH: process.env['PATH'] ?? '', npm_config_update_notifier: 'false', ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const parse = (stdout: string, label: string): Envelope => {
  try {
    return JSON.parse(stdout) as Envelope;
  } catch {
    problems.push(`${label}: stdout was not one JSON document`);
    return {};
  }
};

const main = (argv: readonly string[]): number => {
  const keep = argv.includes('--keep');
  const repoRoot = findRepoRoot();
  const staging = mkdtempSync(join(tmpdir(), 'wxgit-'));
  const project = join(staging, 'consumer');
  // Short, because the keystore agent's socket path has a ~100-byte OS limit.
  const keystoreDir = mkdtempSync('/tmp/wxgk-');

  try {
    // A tree left by an earlier build must not be able to make this pass: the
    // point is that `prepare` assembles one. That is also why `prepare` is
    // forced — `npm pack` run from pnpm inherits pnpm's user agent, and the
    // hook would take this for a developer's install and return.
    rmSync(join(repoRoot, 'dist', 'install'), { recursive: true, force: true });
    process.stderr.write('packing the repository the way a git install packs it (this runs the root prepare)…\n');
    execFileSync('npm', ['pack', '--pack-destination', staging], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, WATERX_PREPARE_GIT_INSTALL: '1' },
    });
    if (!existsSync(join(repoRoot, 'dist', 'install', 'cli', 'main.js'))) {
      throw new Error('`npm pack` did not run the root prepare: nothing assembled dist/install');
    }
    const tarball = readdirSync(staging).find((name) => name.endsWith('.tgz'));
    if (tarball === undefined) throw new Error('npm pack produced no tarball');

    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'package.json'),
      `${JSON.stringify({ name: 'agent-workspace', private: true, version: '0.0.0' }, null, 2)}\n`,
      'utf8',
    );
    process.stderr.write(`installing ${tarball}, scripts disabled…\n`);
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(staging, tarball)], {
      cwd: project,
      stdio: 'ignore',
    });

    const home = join(staging, 'home');
    mkdirSync(home, { recursive: true });
    const bare = { HOME: home, WATERX_KEYSTORE_DIR: keystoreDir };

    // 1. It answers with nothing configured, and sends nothing.
    const described = run(project, bare, ['waterx-predict', 'describe']);
    const describe = parse(described.stdout, 'describe');
    expect(describe.command === 'runtime.describe' && describe.ok === true, 'describe did not answer as itself');

    // 2. The loop an agent host runs, with the steps it may run itself.
    const first = parse(run(project, bare, ['waterx-predict', 'next', '--json']).stdout, 'next');
    expect(first.data?.state === 'SETUP_INCOMPLETE', `bare: next answered ${String(first.data?.state)}`);
    const own = (first.data?.agentSteps ?? []).map((step) => step.run ?? '');
    expect(
      own[0] === 'npx --no waterx-predict-keystore init --no-passphrase',
      `bare: the first step the agent may run was ${JSON.stringify(own[0])} — a host cannot finish setup from that`,
    );
    expect(
      own[1] === 'waterx-predict configure --fromKeystore',
      `bare: the second step the agent may run was ${JSON.stringify(own[1])}`,
    );
    expect(
      (first.data?.handOver?.steps ?? []).every((step) => !(step.run ?? '').includes('export ')),
      'bare: a hand-over step told the operator to `export` something, which no tool host can do',
    );

    // 3. Those steps, verbatim, exactly as a host would run them. `npx --no` is
    //    prepended where the step does not carry it, which is what a host does
    //    with a local binary.
    let address = '';
    for (const step of own) {
      const argv = step.startsWith('npx --no ') ? step.slice('npx --no '.length).split(' ') : step.split(' ');
      const done = run(project, bare, argv);
      expect(done.status === 0, `\`${step}\` exited ${String(done.status)}: ${done.stderr.trim().split('\n').pop() ?? ''}`);
      if (argv[1] === 'init') {
        try {
          address = String((JSON.parse(done.stdout) as { address?: unknown }).address ?? '');
        } catch {
          problems.push('keystore init did not print its address');
        }
        expect(/^0x[0-9a-f]{64}$/u.test(address), `keystore init printed ${JSON.stringify(address)}`);
        // The one thing this posture must never do quietly.
        expect(
          done.stderr.includes('plaintext'),
          'keystore init --no-passphrase did not say on stderr that the key is stored in plaintext',
        );
      }
      if (argv[1] === 'configure') {
        const answer = parse(done.stdout, 'configure');
        expect(answer.ok === true, `configure failed: ${String(answer.error?.message)}`);
      }
    }

    // 4. `next` reads what those steps left behind — no person, no agent.
    const second = parse(run(project, bare, ['waterx-predict', 'next', '--json']).stdout, 'next after setup');
    expect(
      second.data?.facts?.agentWallet === address,
      `after setup: next reported agentWallet ${String(second.data?.facts?.agentWallet)}, not the ${address} the keystore holds`,
    );
    expect(
      second.data?.state !== 'SETUP_INCOMPLETE',
      `after setup: next still answered SETUP_INCOMPLETE — a host running its own steps cannot get past setup`,
    );

    if (problems.length > 0) {
      process.stderr.write(`\n${String(problems.length)} problem(s):\n`);
      for (const problem of problems) process.stderr.write(`  ${problem}\n`);
      return 1;
    }
    process.stderr.write(
      '\nPacked as a git install packs it, installed with npm alone and scripts off; `describe` answered, and the steps `next` said the agent could run itself took it from nothing to a configured wallet with no person and no resident agent.\n',
    );
    return 0;
  } finally {
    if (keep) {
      process.stderr.write(`kept: ${staging} and ${keystoreDir}\n`);
    } else {
      rmSync(staging, { recursive: true, force: true });
      rmSync(keystoreDir, { recursive: true, force: true });
    }
  }
};

process.exitCode = main(process.argv.slice(2));
