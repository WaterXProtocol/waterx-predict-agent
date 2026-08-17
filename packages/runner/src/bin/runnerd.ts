#!/usr/bin/env node
/**
 * The Runner as a process you can start from a shell.
 *
 * Deliberately thin: everything of consequence is in `RunnerDaemon`, which is
 * testable in-process. This file only decides where the store and the runtime
 * directory live, and hands the signals over.
 *
 * It runs in the foreground and it does not daemonize. That is not an omission —
 * the Runner is self-hosted, and a process that detached itself would be a
 * strategy still "running" after the terminal that owned it went away, which is
 * precisely the impression ADR-0001 §6 says not to give. Backgrounding it, and
 * keeping the device awake, is the operator's decision to make explicitly.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { installShutdownHandlers, RunnerDaemon } from '../daemon.ts';
import { SqliteJobStore } from '../sqlite/store.ts';

const runtimeDir = process.env['WATERX_RUNNER_DIR'] ?? join(homedir(), '.waterx', 'runner');
const storePath = process.env['WATERX_RUNNER_STORE'] ?? join(runtimeDir, 'jobs.sqlite');

const store = new SqliteJobStore({ path: storePath });
const daemon = new RunnerDaemon({
  store,
  runtimeDir,
  onEvent: (event) => {
    // stderr, and never the token: stdout belongs to whatever is parsing this
    // process's output, and the token is the credential the socket is protected
    // by.
    process.stderr.write(`${JSON.stringify(event)}\n`);
  },
});

installShutdownHandlers(daemon);

const handle = await daemon.start();
process.stderr.write(
  `${JSON.stringify({
    kind: 'listening',
    instanceId: handle.instanceId,
    socketPath: handle.socketPath,
    tokenPath: handle.tokenPath,
    // The one thing a reader must not misunderstand about a Runner that just
    // said it is listening.
    driving: false,
  })}\n`,
);
