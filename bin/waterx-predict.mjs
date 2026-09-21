#!/usr/bin/env node
// The `waterx-predict` binary of a git install (ADR-0019). The CLI's own entry
// sets `process.exitCode` and writes one document; this only points at it —
// unless the build it points at is not there, which is ADR-0021's case below.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { reportMissingBuild } from './missing-build.mjs';

const entry = new URL('../dist/install/cli/main.js', import.meta.url);

if (existsSync(fileURLToPath(entry))) {
  await import(entry);
} else {
  reportMissingBuild({
    argv: process.argv.slice(2),
    // One JSON document on stdout, in the envelope every other answer uses, so
    // the promise a caller relies on survives the failure a first install is
    // most likely to meet. `command` is the raw invocation: the build that
    // could resolve a contract name is exactly what is missing.
    envelope: (invocation) => ({
      schemaVersion: '1',
      ok: false,
      command: invocation === '' ? 'waterx-predict' : invocation,
      requestId: randomUUID(),
      error: {
        code: 'BUILD_MISSING',
        message:
          'This package installed without its build, so there is nothing to run. The compile happens in the `prepare` script at install time and it did not run here. Re-run the install with scripts permitted — `npm install github:WaterXProtocol/waterx-predict-agent` — or use the release artifacts, which ship built. `npm rebuild` does NOT fix this: it reports success and runs no `prepare`.',
        retryable: false,
        source: 'CLI',
        details: { expected: 'dist/install/cli/main.js' },
      },
    }),
  });
}
