import { defineConfig } from 'vitest/config';

/**
 * Workspace-level tests only. These assert cross-package invariants (package
 * boundaries, dependency direction, published-package hygiene) that no single
 * package can check about itself. Per-package suites live under each package's
 * own `tests` directory and run via `pnpm -r test`.
 */
export default defineConfig({
  test: { globals: true, include: ['tests/**/*.test.ts'] },
});
