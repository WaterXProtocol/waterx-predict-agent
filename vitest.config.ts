import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Workspace-level tests only. These assert cross-package invariants (package
 * boundaries, dependency direction, published-package hygiene) that no single
 * package can check about itself. Per-package suites live under each package's
 * own `tests` directory and run via `pnpm -r test`.
 *
 * Every package is reached by relative path, so these aliases exist only for
 * the two workspace names an adapter's own source imports. Resolving them to
 * SOURCE keeps this suite independent of whether `dist` has been built.
 */
export default defineConfig({
  test: { globals: true, include: ['tests/**/*.test.ts'] },
  resolve: {
    alias: {
      '@waterx/predict-agent-adapters': fileURLToPath(
        new URL('./packages/adapters/src/index.ts', import.meta.url),
      ),
      '@waterx/predict-agent-schema': fileURLToPath(
        new URL('./packages/schema/src/index.ts', import.meta.url),
      ),
    },
  },
});
