import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Mirrors `tsconfig.json`: static imports resolve to sibling SOURCE, so the
 * suite does not depend on whether someone remembered to build first.
 *
 * The one thing this alias does NOT redirect is `createRequire(...).resolve` in
 * `cli-process.ts`, which still walks `node_modules` to find the installed
 * binary. That is deliberate — a test of the harness's process transport has to
 * find the real artifact or honestly report that it is not built.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    // Spawning the CLI is slower than an in-process call, and a machine under
    // load should not turn that into a flake.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@waterx/predict-agent-cli': fileURLToPath(new URL('../cli/src/index.ts', import.meta.url)),
      '@waterx/predict-agent-schema': fileURLToPath(
        new URL('../schema/src/index.ts', import.meta.url),
      ),
    },
  },
});
