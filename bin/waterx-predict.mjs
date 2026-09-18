#!/usr/bin/env node
// The `waterx-predict` binary of a git install (ADR-0019). The CLI's own entry
// sets `process.exitCode` and writes one document; this only points at it.
import './../dist/install/cli/main.js';
