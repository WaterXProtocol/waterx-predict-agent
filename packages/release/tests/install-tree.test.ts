/**
 * The tree a git install runs from (ADR-0019). What matters is that it REFUSES:
 * a tree that resolves nothing at runtime must not be packed and shipped.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assembleInstallTree, CROSS_PACKAGE_SPECIFIERS, INSTALL_PARTS } from '../src/install-tree.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repository with every package built, as `pnpm build` leaves it. */
function repo(overrides: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'wxtree-'));
  roots.push(root);
  const files: Record<string, string> = {
    'cli/dist/src/main.js': "import { thing } from '@waterx/predict-agent-sdk';\nimport { spec } from '@waterx/predict-agent-schema';\nexport { thing, spec };\n",
    'cli/dist/src/commands/order.js': "import { x } from '@waterx/predict-agent-sdk';\nexport { x };\n",
    'cli/dist/src/main.d.ts': 'export declare const nope: string;\n',
    'sdk/dist/src/index.js': "import { io } from 'socket.io-client';\nexport { io };\n",
    'schema/dist/src/index.js': 'export const spec = 1;\n',
    'signer-keystore/dist/src/bin/keystore.js': "import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';\nexport { Ed25519Keypair };\n",
    ...overrides,
  };
  for (const [path, contents] of Object.entries(files)) {
    if (contents === '') continue;
    const full = join(root, 'packages', path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

describe('the install tree', () => {
  it('lays the built packages out and rewrites what crosses a package', () => {
    const root = repo();
    const result = assembleInstallTree(root);

    expect(result.files).toBe(5);
    expect(result.rewrites).toBe(3);
    const main = readFileSync(join(root, 'dist/install/cli/main.js'), 'utf8');
    expect(main).toContain("from '../sdk/index.js'");
    expect(main).toContain("from '../schema/index.js'");
    // A nested file's path is its own, not the entry's.
    expect(readFileSync(join(root, 'dist/install/cli/commands/order.js'), 'utf8')).toContain("from '../../sdk/index.js'");
    // Third-party specifiers stay bare: npm installs them from the registry.
    expect(readFileSync(join(root, 'dist/install/sdk/index.js'), 'utf8')).toContain("from 'socket.io-client'");
    expect(readFileSync(join(root, 'dist/install/keystore/bin/keystore.js'), 'utf8')).toContain("from '@mysten/sui/keypairs/ed25519'");
    // Declarations are for a library consumer, not for what runs.
    expect(() => readFileSync(join(root, 'dist/install/cli/main.d.ts'), 'utf8')).toThrow();
    expect(Object.keys(CROSS_PACKAGE_SPECIFIERS)).toHaveLength(2);
    expect(INSTALL_PARTS.map((part) => part.to)).toEqual(['cli', 'sdk', 'schema', 'keystore']);
  });

  it('refuses a package that was never built', () => {
    const root = repo();
    rmSync(join(root, 'packages/sdk'), { recursive: true, force: true });
    expect(() => assembleInstallTree(root)).toThrow(/run `pnpm build`/u);
  });

  it('refuses a specifier it does not know how to resolve', () => {
    const root = repo({ 'cli/dist/src/main.js': "import { x } from '@waterx/predict-agent-runner';\nexport { x };\n" });
    expect(() => assembleInstallTree(root)).toThrow(/still imports/u);
  });

  it('refuses a tree whose binary would point at nothing', () => {
    const root = repo({ 'signer-keystore/dist/src/bin/keystore.js': '' });
    mkdirSync(join(root, 'packages/signer-keystore/dist/src'), { recursive: true });
    writeFileSync(join(root, 'packages/signer-keystore/dist/src/other.js'), 'export const x = 1;\n');
    expect(() => assembleInstallTree(root)).toThrow(/keystore\/bin\/keystore\.js/u);
  });
});
