import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Tests run against the schema package's SOURCE, mirroring `tsconfig.json`.
 * The CLI is not aliased here on purpose: this package never imports it, and
 * the tests that assert delegation drive an injected `CoreInvoker` instead of
 * a real subprocess, so no test in this suite spawns a binary or touches a
 * network.
 */
export default defineConfig({
  test: { globals: true, include: ['tests/**/*.test.ts'] },
  resolve: {
    alias: {
      '@waterx/predict-agent-schema': fileURLToPath(
        new URL('../schema/src/index.ts', import.meta.url),
      ),
    },
  },
});
