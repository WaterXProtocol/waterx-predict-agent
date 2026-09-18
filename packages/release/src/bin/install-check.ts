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
 *   2. `npx --no waterx-predict next --json` → SETUP_INCOMPLETE, and the first
 *                                            step is the keystore
 *   3. `npx --no waterx-predict-keystore init` → the second binary works, and
 *                                            holds a key it just made
 *   4. `next` again                        → the agent wallet it now knows
 *
 * WHAT IT DOES NOT PROVE: that GitHub serves it. Nothing here clones over the
 * network; the packed tree is identical to the one a clone would pack, but a
 * real `npm install github:…` also needs the caller's git credentials for a
 * private repository. No key of this machine is touched: the keystore runs
 * against a throwaway HOME and its own directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findRepoRoot } from '../workspace.ts';

interface Envelope {
  ok?: boolean;
  command?: string;
  data?: { state?: string; handOver?: { steps?: { run?: string }[] }; facts?: { signer?: { kind?: string } } };
}

const problems: string[] = [];
const expect = (condition: boolean, problem: string): void => {
  if (!condition) problems.push(problem);
};

function run(project: string, env: Record<string, string>, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = execFileSync('npx', ['--no', ...args], {
    cwd: project,
    env: { PATH: process.env['PATH'] ?? '', npm_config_update_notifier: 'false', ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: 0, stdout: result, stderr: '' };
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
    const passphraseFile = join(staging, 'passphrase');
    writeFileSync(passphraseFile, 'install-check-passphrase\n', { mode: 0o600 });
    const bare = { HOME: home, WATERX_KEYSTORE_DIR: keystoreDir };

    // 1. It answers with nothing configured, and sends nothing.
    const described = run(project, bare, ['waterx-predict', 'describe']);
    const describe = parse(described.stdout, 'describe');
    expect(describe.command === 'runtime.describe' && describe.ok === true, 'describe did not answer as itself');

    // 2. The loop an agent host runs.
    const first = parse(run(project, bare, ['waterx-predict', 'next', '--json']).stdout, 'next');
    expect(first.data?.state === 'SETUP_INCOMPLETE', `bare: next answered ${String(first.data?.state)}`);
    const steps = (first.data?.handOver?.steps ?? []).map((step) => step.run ?? '');
    expect(
      steps[0] === 'npx --no waterx-predict-keystore init',
      `bare: the first step was ${JSON.stringify(steps[0])}, not keystore init — the installed signer was not found`,
    );

    // 3. The second binary, from the same install.
    const init = run(project, { ...bare, WATERX_KEYSTORE_PASSPHRASE_FILE: passphraseFile }, ['waterx-predict-keystore', 'init']);
    let address = '';
    try {
      address = String((JSON.parse(init.stdout) as { address?: unknown }).address ?? '');
    } catch {
      problems.push('keystore init did not print its address');
    }
    expect(/^0x[0-9a-f]{64}$/u.test(address), `keystore init printed ${JSON.stringify(address)}`);

    // 4. `next` reads the keystore it just made.
    const second = parse(run(project, bare, ['waterx-predict', 'next', '--json']).stdout, 'next after init');
    expect(
      (second.data?.handOver?.steps ?? []).some((step) => (step.run ?? '').includes(address)),
      'after init: next did not fill in the wallet the keystore holds',
    );

    if (problems.length > 0) {
      process.stderr.write(`\n${String(problems.length)} problem(s):\n`);
      for (const problem of problems) process.stderr.write(`  ${problem}\n`);
      return 1;
    }
    process.stderr.write(
      '\nPacked as a git install packs it, installed with npm alone and scripts off; `describe` answered, `next` asked for the keystore, `keystore init` made a wallet, and `next` read it back.\n',
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
