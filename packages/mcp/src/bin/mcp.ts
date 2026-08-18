#!/usr/bin/env node
/**
 * `waterx-predict-mcp` — the MCP stdio server an MCP client spawns.
 *
 *   waterx-predict-mcp [--config <path>] [--policy <mode>] [--runner-dir <path>]
 *                      [--timeout-ms <n>]
 *
 * Every flag here belongs to the OPERATOR who configured the client, is pinned
 * for the whole session, and is passed to the command core unchanged. There is
 * no approval flag: an approval authorises one exact intent and is given per
 * order, at the core, by a person. See the adapters README.
 *
 * The process exits when its client closes stdin. It spawns nothing that
 * outlives that, holds no key, and starts no daemon — the local Runner, if a
 * strategy needs one, is started by the operator separately.
 */
import { createCliInvoker, createToolDispatcher } from '@waterx/predict-agent-adapters';

import { createMcpServer } from '../server.ts';
import { serveStdio } from '../stdio.ts';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write(
    [
      'waterx-predict-mcp — MCP stdio adapter over the WaterX Predict command core.',
      '',
      'Operator flags, pinned for the session and passed to the core unchanged:',
      '  --config <path>  --policy <mode>  --timeout-ms <n>  --runner-dir <path>',
      '',
      'There is no approval flag. A write under the default interactive policy is',
      'refused, and the refusal names the approval an operator must supply at the CLI.',
      '',
      'Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. Tools only.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

// `createCliInvoker` validates these against its allowlist and throws on
// anything an operator should not be able to pin — before a client has sent a
// single frame, rather than in the middle of an order.
const dispatcher = createToolDispatcher({
  invoke: createCliInvoker({ env: process.env, operatorArgs: argv }),
});

const server = createMcpServer({ dispatcher });

serveStdio({ input: process.stdin, output: process.stdout, handle: server.handle }).then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 70;
  },
);
