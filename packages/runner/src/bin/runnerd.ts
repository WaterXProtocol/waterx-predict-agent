#!/usr/bin/env node
/**
 * The Runner as a process you can start from a shell.
 *
 * Deliberately thin: everything of consequence is in `RunnerDaemon`, `config.ts`
 * and `runtime.ts`, all of which are testable in-process. This file resolves the
 * configuration, asks for a driver, and hands the signals over.
 *
 * **It refuses to start a partial driver.** `resolveRunnerConfig` yields a driver
 * configuration only when the base URL, the agent wallet and the keystore command
 * are all present; anything missing is named in `gaps`, passed straight through to
 * the daemon, and reported by `runner.status` as something an operator can fix. A
 * Runner with a gateway and no signer would watch a market, meet a target, create
 * an execution and only then find it cannot authorize it — an order on the server
 * with a local job that can never resolve it. Starting nothing costs a strategy
 * nothing: the job stays where recovery put it, and the next correctly configured
 * Runner picks it up under the same key.
 *
 * It runs in the foreground and it does not daemonize. That is not an omission —
 * the Runner is self-hosted, and a process that detached itself would be a
 * strategy still "running" after the terminal that owned it went away, which is
 * precisely the impression ADR-0001 §6 says not to give. Backgrounding it, and
 * keeping the device awake, is the operator's decision to make explicitly.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  createNodeRunnerConfigSources,
  describeRunnerConfig,
  resolveRunnerConfig,
} from '../config.ts';
import { installShutdownHandlers, RunnerDaemon } from '../daemon.ts';
import { buildRunnerDriver, type RunnerDriverBundle } from '../runtime.ts';
import { createChildProcessSignerRunner } from '../signer.ts';
import { SqliteJobStore } from '../sqlite/store.ts';

/**
 * stderr, and never the token: stdout belongs to whatever is parsing this
 * process's output, and the token is the credential the socket is protected by.
 */
const say = (line: Readonly<Record<string, unknown>>): void => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

const config = resolveRunnerConfig(createNodeRunnerConfigSources(process.env, readFileSync));
// The keystore executable by base name only, and no token anywhere: a full argv
// may hold a path that identifies the operator or a hardware token slot, and this
// line goes wherever a service manager archives stderr.
say({ kind: 'config', ...describeRunnerConfig(config) });
for (const warning of config.warnings) say({ kind: 'warning', message: warning });

let bundle: RunnerDriverBundle | undefined;
if (config.driver !== undefined) {
  bundle = buildRunnerDriver(config.driver, {
    run: createChildProcessSignerRunner(spawn),
    // The keystore child's stderr, so an operator can see its own configuration
    // problems. Never its stdout, never the bytes, never the signature.
    onDiagnostic: (text) => {
      say({ kind: 'signer-diagnostic', message: text });
    },
  });
}

const store = new SqliteJobStore({ path: config.storePath });
const daemon = new RunnerDaemon({
  store,
  runtimeDir: config.runtimeDir,
  // The mandate, from this host's configuration. A socket peer never contributes
  // to it, and an operator who set nothing gets `interactive`, which refuses to
  // arm anything.
  policy: config.policy,
  ...(bundle === undefined
    ? // Named configuration, not absent collaborators: `signer-command` tells an
      // operator what to set; `signer` would only restate that nothing was passed.
      { driverGaps: config.gaps }
    : { driver: bundle.driver, priceTopics: () => bundle?.prices.topics() ?? [] }),
  ...(config.tickIntervalMs === undefined ? {} : { tickIntervalMs: config.tickIntervalMs }),
  ...(config.maxJobs === undefined ? {} : { maxJobs: config.maxJobs }),
  onEvent: (event) => {
    say(event);
  },
});

installShutdownHandlers(daemon);
// The socket and the subscriptions are released in the opposite order they were
// taken. Without this the process would keep the event loop alive after a clean
// stop, which for a Runner whose whole disclosure is "this stops when you stop
// it" is the wrong impression to leave.
process.once('exit', () => {
  bundle?.close();
});

const handle = await daemon.start();
say({
  kind: 'listening',
  instanceId: handle.instanceId,
  socketPath: handle.socketPath,
  tokenPath: handle.tokenPath,
  // The one thing a reader must not misunderstand about a Runner that just said
  // it is listening. Read from the handle rather than written as a constant, so
  // this line cannot go on claiming an answer the process no longer gives.
  driving: handle.driving,
});
