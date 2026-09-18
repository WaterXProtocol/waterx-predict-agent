#!/usr/bin/env node
/**
 * `pnpm install:assemble` — build `dist/install/`, the tree a git install runs
 * from (ADR-0019). Called by the root `prepare`, after `pnpm build`.
 */
import { assembleInstallTree } from '../install-tree.ts';
import { findRepoRoot } from '../workspace.ts';

const result = assembleInstallTree(findRepoRoot());
process.stderr.write(
  `assembled ${result.root}: ${String(result.files)} file(s), ${String(result.rewrites)} cross-package specifier(s) rewritten\n`,
);
