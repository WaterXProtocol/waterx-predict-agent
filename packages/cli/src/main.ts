#!/usr/bin/env node
/**
 * The `waterx-predict` binary.
 *
 * Deliberately almost empty: everything worth testing lives in `run.ts` behind
 * an injected IO surface, so this file is the only part of the CLI that a test
 * cannot exercise — and there is nothing here to get wrong.
 *
 * `process.exitCode` rather than `process.exit()`: the latter can truncate a
 * stdout write that has not flushed, which would hand the caller half a JSON
 * document. The envelope is the product; it gets to finish writing.
 */
import { createNodeIo, run } from './run.ts';
import { EXIT_CODES } from './exit-codes.ts';

const io = createNodeIo();

run(io)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // `run` is written not to reach here: it catches everything and still emits
    // an envelope. If it ever does, the failure is in the emitter itself, so
    // stdout is untrustworthy and only stderr is used.
    io.streams.writeError(
      `waterx-predict: fatal internal error: ${error instanceof Error ? error.message : 'unknown'}\n`,
    );
    process.exitCode = EXIT_CODES.INTERNAL;
  });
