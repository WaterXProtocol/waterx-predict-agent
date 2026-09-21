#!/usr/bin/env node
// The keystore signer's binary of a git install (ADR-0019). Same key handling
// as the standalone artifact: the key stays in this process and nowhere else.
// An install with no build in it is reported here rather than as a module
// stack (ADR-0021) — in this binary's own voice, because the keystore speaks
// no envelope: `sign` writes one line of JSON and everything else is stderr.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { reportMissingBuild } from './missing-build.mjs';

const entry = new URL('../dist/install/keystore/bin/keystore.js', import.meta.url);

if (existsSync(fileURLToPath(entry))) {
  await import(entry);
} else {
  reportMissingBuild({ argv: process.argv.slice(2), binary: 'waterx-predict-keystore' });
}
