import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Resolves the adapter core's SOURCE, mirroring `tsconfig.json`. No test here
 * opens a socket, spawns the command core, or reads a real stdin: the server
 * is driven frame by frame against an injected dispatcher.
 */
export default defineConfig({
  test: { globals: true, include: ['tests/**/*.test.ts'] },
  resolve: {
    alias: {
      '@waterx/predict-agent-adapters': fileURLToPath(
        new URL('../adapters/src/index.ts', import.meta.url),
      ),
      '@waterx/predict-agent-schema': fileURLToPath(
        new URL('../schema/src/index.ts', import.meta.url),
      ),
    },
  },
});
