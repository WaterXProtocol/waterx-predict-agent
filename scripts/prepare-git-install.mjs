#!/usr/bin/env node
/**
 * The root `prepare`, which exists for ONE case: `npm install
 * github:WaterXProtocol/waterx-predict-agent` (ADR-0019).
 *
 * npm clones the repository, installs the root's own devDependencies and runs
 * this. The repository is a pnpm workspace, so the build npm cannot do itself
 * is done here: pnpm installs the workspace, `pnpm build` compiles every
 * package, and `install:assemble` lays the four built packages out as the tree
 * the two binaries point at. npm then packs what `files` names.
 *
 * It does nothing for a developer. `pnpm install` in this repository runs the
 * same hook, and rebuilding the world on every install would be a slow
 * surprise — so anything that is not npm returns immediately. `pnpm build` is
 * still the command that builds here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const agent = process.env['npm_config_user_agent'] ?? '';
const flag = process.env['WATERX_PREPARE_GIT_INSTALL'];
// `0` is how this hook turns itself off for everything it starts. Without it
// the build below recurses: `pnpm install` runs this same hook, which runs
// `pnpm install` again. `1` is how `install:check` asks for the real path even
// though pnpm, not npm, is what invoked `npm pack`.
if (flag === '0' || (flag !== '1' && !agent.startsWith('npm/'))) {
  process.stderr.write(`prepare: nothing to do for ${agent === '' ? 'this runner' : agent.split(' ')[0]}; \`pnpm build\` builds this workspace\n`);
  process.exit(0);
}

const { packageManager } = createRequire(import.meta.url)('../package.json');
const pinned = String(packageManager ?? 'pnpm@10').replace(/^pnpm@/u, '');

/**
 * How to run pnpm here. A pnpm already on PATH is used as it is; otherwise
 * corepack, which ships with Node, fetches the pinned version. `npx` is the
 * last resort, for a Node whose corepack was removed by a distribution.
 */
const runners = [
  ['pnpm', []],
  ['corepack', ['pnpm@' + pinned]],
  ['npx', ['--yes', 'pnpm@' + pinned]],
];

const childEnv = { ...process.env, WATERX_PREPARE_GIT_INSTALL: '0' };

const run = (args) => {
  let lastError;
  for (const [command, prefix] of runners) {
    try {
      execFileSync(command, [...prefix, ...args], { stdio: 'inherit', env: childEnv });
      return;
    } catch (error) {
      lastError = error;
      // A failure of the command itself (not "no such program") is real: a
      // second runner would fail the same way, and hiding it would leave a
      // half-built install.
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`no pnpm available to run \`pnpm ${args.join(' ')}\`: ${String(lastError)}`);
};

process.stderr.write('prepare: building the workspace for a git install; this takes a minute\n');
run(['install', existsSync(new URL('../pnpm-lock.yaml', import.meta.url)) ? '--frozen-lockfile' : '--no-frozen-lockfile']);
run(['build']);
run(['run', 'install:assemble']);
