import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Tests run against the sibling packages' SOURCE, mirroring `tsconfig.json`.
 * Resolving to `dist` instead would make the suite pass or fail depending on
 * whether someone remembered to build first.
 */
export default defineConfig({
  test: { globals: true, include: ['tests/**/*.test.ts'] },
  resolve: {
    alias: {
      '@waterx/predict-agent-sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)),
      '@waterx/predict-agent-schema': fileURLToPath(
        new URL('../schema/src/index.ts', import.meta.url),
      ),
    },
  },
});
