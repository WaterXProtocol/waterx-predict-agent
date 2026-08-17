/**
 * Cross-package invariants.
 *
 * A directory layout is not a boundary. What makes `packages/*` mean something
 * is that a violation fails a test: the SDK staying free of daemon, CLI and
 * adapter dependencies is the whole reason for the split (ADR-0001 §4), and
 * nothing inside a single package can check it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CAPABILITIES } from '../packages/cli/src/capabilities.ts';
import { AGENT_COMMANDS } from '../packages/schema/src/index.ts';
import { PredictAgentClient } from '../packages/sdk/src/index.ts';

/** Repository root, with a trailing slash. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));

const read = (relativePath: string): string => readFileSync(`${ROOT}${relativePath}`, 'utf8');
const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(read(relativePath)) as Record<string, unknown>;

const PACKAGE_DIRS = readdirSync(`${ROOT}packages`).filter((entry) =>
  statSync(`${ROOT}packages/${entry}`).isDirectory(),
);

/** Packages that ship to a registry. Everything else must be `private`. */
const PUBLISHED = new Set(['sdk', 'schema']);

/**
 * Implemented, but deliberately unreleased: real code, real tests, `private`
 * until the release work in the backlog is done. The distinction from RESERVED
 * matters — these have to look like packages, and must still not be publishable
 * by accident.
 */
const INTERNAL = new Set(['cli', 'runner']);

/** Reserved boundaries with no implementation. They must not look like one. */
const RESERVED = new Set(['mcp']);

/**
 * Test harnesses. They drive the shipped artifacts and are never shipped
 * themselves, so they may depend on anything in the workspace — including the
 * unpublished CLI — and must never be publishable.
 */
const HARNESS = new Set(['e2e']);

interface PackageManifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly type?: string;
  readonly main?: string;
  readonly types?: string;
  readonly bin?: unknown;
  readonly exports?: unknown;
  readonly files?: readonly string[];
  readonly license?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

const manifest = (dir: string): PackageManifest =>
  readJson(`packages/${dir}/package.json`) as PackageManifest;

describe('workspace layout', () => {
  it('accounts for every package directory', () => {
    expect(new Set(PACKAGE_DIRS)).toEqual(
      new Set([...PUBLISHED, ...INTERNAL, ...RESERVED, ...HARNESS]),
    );
  });

  it('is covered by the pnpm workspace glob', () => {
    expect(read('pnpm-workspace.yaml')).toContain("'packages/*'");
  });

  it('keeps the workspace root private and unpublishable', () => {
    const root = readJson('package.json') as PackageManifest;
    expect(root.private).toBe(true);
    expect(root.main).toBeUndefined();
    expect(root.exports).toBeUndefined();
  });

  it('gives every package a README that names it', () => {
    for (const dir of PACKAGE_DIRS) {
      expect(read(`packages/${dir}/README.md`), dir).toContain(manifest(dir).name ?? dir);
    }
  });
});

describe('dependency direction', () => {
  const WORKSPACE_NAMES = new Set(PACKAGE_DIRS.map((dir) => manifest(dir).name));

  const workspaceEdges = (dir: string): string[] => {
    const pkg = manifest(dir);
    return [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ].filter((name) => WORKSPACE_NAMES.has(name));
  };

  it('keeps the SDK at the bottom, depending on nothing else in the workspace', () => {
    // The SDK is the execution core. A dependency on the schema, the CLI or the
    // Runner would drag their dependencies into the published library.
    expect(workspaceEdges('sdk')).toEqual([]);
  });

  it('keeps the schema independent of the SDK', () => {
    // The command contract has to be readable by a surface that cannot import a
    // Node client — that is why it is published as plain JSON at all.
    expect(workspaceEdges('schema')).toEqual([]);
  });

  it('lets a published package take only a runtime dependency that was argued for', () => {
    // Every dependency here is installed into every consumer of this library, so
    // the list is an allowlist rather than a limit: adding one means editing this
    // test, which means saying why. `socket.io-client` is the official client for
    // the protocol the server's stream actually speaks, and re-implementing it
    // over raw `ws` would be a second, worse copy of it — the argument is written
    // out at the top of `packages/sdk/src/execution-stream.ts`.
    const ALLOWED = new Map([['sdk', ['socket.io-client']]]);
    for (const dir of PUBLISHED) {
      expect(Object.keys(manifest(dir).dependencies ?? {}).sort(), dir).toEqual(
        ALLOWED.get(dir) ?? [],
      );
    }
  });

  it('keeps the one runtime dependency behind a lazy import', () => {
    // A top-level `import 'socket.io-client'` would load the transport for every
    // caller — including a CLI that only reads a market — and would turn a pruned
    // or unavailable dependency into a crash at module load instead of a stream
    // that degrades to polling.
    for (const file of sourceFiles('packages/sdk/src')) {
      expect(read(file), file).not.toMatch(/^import .*'socket\.io-client'/mu);
    }
    for (const file of ['execution-stream.ts', 'quote-stream.ts']) {
      expect(read(`packages/sdk/src/${file}`), file).toContain("await import('socket.io-client')");
    }
  });

  it('points the CLI at both published packages and nothing else', () => {
    // The CLI is a surface over the core, not a peer of it. Its only workspace
    // edges are the two packages it compiles the same intent through.
    expect(workspaceEdges('cli').sort()).toEqual([
      '@waterx/predict-agent-schema',
      '@waterx/predict-agent-sdk',
    ]);
  });

  it('never lets a published package import an unpublished one, in source', () => {
    // A published package importing `@waterx/predict-agent-cli` would name a
    // dependency that does not exist on any registry.
    const unpublishedNames = [...RESERVED, ...INTERNAL, ...HARNESS].map(
      (dir) => manifest(dir).name ?? dir,
    );
    for (const dir of PUBLISHED) {
      for (const file of sourceFiles(`packages/${dir}/src`)) {
        for (const name of unpublishedNames) {
          expect(read(file), `${file} imports ${name}`).not.toContain(`from '${name}'`);
        }
      }
    }
  });

  it('never lets the schema reach into another package by relative path', () => {
    for (const file of sourceFiles('packages/schema/src')) {
      expect(read(file), file).not.toMatch(/from '\.\.\/\.\.\//u);
    }
  });
});

describe('published package hygiene', () => {
  it('keeps the SDK import surface exactly where it was before the split', () => {
    // Moving the sources must not move the published entry points. A consumer's
    // `import { PredictAgentClient } from '@waterx/predict-agent-sdk'` has to
    // resolve to the same file it did before.
    const pkg = manifest('sdk');
    expect(pkg.name).toBe('@waterx/predict-agent-sdk');
    expect(pkg.main).toBe('dist/src/index.js');
    expect(pkg.types).toBe('dist/src/index.d.ts');
    expect(pkg.exports).toEqual({
      '.': { types: './dist/src/index.d.ts', import: './dist/src/index.js' },
    });
  });

  it('declares a coherent, ESM, Node 20+ surface for each published package', () => {
    for (const dir of PUBLISHED) {
      const pkg = manifest(dir);
      expect(pkg.private, dir).toBeUndefined();
      expect(pkg.type, dir).toBe('module');
      expect(pkg.license, dir).toBe('MIT');
      expect(pkg.engines?.node, dir).toBe('>=20');
      expect(pkg.files, dir).toContain('dist');
      expect(pkg.files, dir).toContain('LICENSE');
      // A `files` list that promises a LICENSE the package does not have ships a
      // package without one.
      expect(() => read(`packages/${dir}/LICENSE`), dir).not.toThrow();
      for (const script of ['build', 'typecheck', 'test']) {
        expect(pkg.scripts?.[script], `${dir}: ${script}`).toBeTypeOf('string');
      }
    }
  });
});

describe('the CLI package', () => {
  it('is implemented but stays unpublishable', () => {
    // `private` is the release gate. The CLI is real code with real tests, but
    // an accidental `npm publish` would ship a binary the backlog has not
    // finished (release is 3.6), under a name nobody has claimed.
    const pkg = manifest('cli');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.engines?.node).toBe('>=20');
    for (const script of ['build', 'typecheck', 'test']) {
      expect(pkg.scripts?.[script], script).toBeTypeOf('string');
    }
  });

  it('exposes one binary, from built output rather than source', () => {
    // A `bin` pointing at a `.ts` file works on the author's machine and
    // nowhere else.
    expect(manifest('cli').bin).toEqual({ 'waterx-predict': 'dist/src/main.js' });
  });

  it('never writes to stdout outside the one writer that owns it', () => {
    // stdout carries exactly one JSON document per invocation (plan §6.3). A
    // stray `console.log` anywhere in the CLI silently corrupts every caller's
    // parse, so the ban is structural rather than a review habit.
    for (const file of sourceFiles('packages/cli/src')) {
      if (file.endsWith('/output.ts')) continue;
      const source = read(file);
      expect(source, `${file} writes to stdout`).not.toMatch(/console\.log|process\.stdout/u);
    }
  });
});

describe('the Runner package', () => {
  it('is unpublishable, and depends on nothing outside the workspace', () => {
    // This package will hold the signer, so a runtime dependency here is a
    // decision to widen the trust boundary around the keys (ADR-0007). Adding one
    // means editing this test, which means saying why.
    const pkg = manifest('runner');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@waterx/predict-agent-sdk']);
    for (const script of ['build', 'typecheck', 'test']) {
      expect(pkg.scripts?.[script], script).toBeTypeOf('string');
    }
  });

  it('declares the higher Node floor its store engine costs', () => {
    // `node:sqlite` instead of a native binding, so no compiler and no postinstall
    // script runs inside the process that holds the keys. The price is Node 24
    // here while the published packages stay at 20 — checked rather than
    // commented, because a floor that drifts is a floor nobody can rely on.
    expect(manifest('runner').engines?.node).toBe('>=24');
    expect(manifest('sdk').engines?.node).toBe('>=20');
  });

  it('keeps the SQLite engine behind the store interface', () => {
    // The JobStore interface exists so a managed Runner could implement the same
    // semantics on a different database. An engine import above `src/sqlite/`
    // would quietly make that impossible.
    for (const file of sourceFiles('packages/runner/src')) {
      if (file.startsWith('packages/runner/src/sqlite/')) continue;
      expect(read(file), `${file} imports the engine`).not.toContain("'node:sqlite'");
    }
  });

  it('says in its README which half of the Runner exists', () => {
    // The daemon and the IPC are not built. A README that described this package
    // as "the Runner" would be claiming a job progresses on its own, which is the
    // one thing it cannot yet do.
    const readme = read('packages/runner/README.md');
    expect(readme).toContain('**not implemented**');
    expect(readme.toLowerCase()).toContain('daemon');
  });
});

describe('the e2e harness package', () => {
  it('stays unpublishable and depends only on what it drives', () => {
    const pkg = manifest('e2e');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.engines?.node).toBe('>=20');
    // It drives the CLI as a subprocess, so it resolves the CLI package. It has
    // no business reaching past that to the SDK: a harness that called the
    // client directly would stop testing the surface a user actually runs.
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      '@waterx/predict-agent-cli',
      '@waterx/predict-agent-schema',
    ]);
    for (const script of ['build', 'typecheck', 'test']) {
      expect(pkg.scripts?.[script], script).toBeTypeOf('string');
    }
  });

  it('never imports the SDK, in source', () => {
    for (const file of sourceFiles('packages/e2e/src')) {
      expect(read(file), file).not.toContain("from '@waterx/predict-agent-sdk'");
    }
  });

  it('says in its README that it is not a production runner', () => {
    const readme = read('packages/e2e/README.md').toLowerCase();
    expect(readme).toContain('not');
    expect(readme).toContain('production');
  });
});

describe('reserved boundaries', () => {
  it('publishes nothing and claims nothing', () => {
    // A reserved directory exists so a dependency cannot leak into the SDK
    // later. It must not read as a shipped capability in the meantime.
    for (const dir of RESERVED) {
      const pkg = manifest(dir);
      expect(pkg.private, dir).toBe(true);
      expect(pkg.main, dir).toBeUndefined();
      expect(pkg.exports, dir).toBeUndefined();
      expect(pkg.bin, dir).toBeUndefined();
      expect(pkg.dependencies, dir).toBeUndefined();
      const tracked = readdirSync(`${ROOT}packages/${dir}`)
        .filter((entry) => entry !== 'node_modules' && !entry.startsWith('.'))
        .sort();
      expect(tracked, dir).toEqual(['README.md', 'package.json']);
    }
  });

  it('says so in the README', () => {
    for (const dir of RESERVED) {
      expect(read(`packages/${dir}/README.md`).toLowerCase(), dir).toContain('not implemented');
    }
  });
});

describe('the command contract compiles to the SDK', () => {
  it('names a method that actually exists on the client', () => {
    // The contract's promise is that every surface issuing the same intent makes
    // the same call (ADR-0001 §1). An `implementation` naming a method that was
    // renamed or never existed breaks that silently, at the adapter.
    const client = PredictAgentClient.prototype as unknown as Record<string, unknown>;
    for (const command of AGENT_COMMANDS) {
      if (command.implementation.kind !== 'sdk') continue;
      const { method } = command.implementation;
      expect(typeof client[method], `${command.name} -> ${method}`).toBe('function');
    }
  });

  it('maps each command to a distinct method', () => {
    const methods = AGENT_COMMANDS.flatMap((command) =>
      command.implementation.kind === 'sdk' ? [command.implementation.method] : [],
    );
    expect(new Set(methods).size).toBe(methods.length);
  });

  it('backs every command the CLI advertises as available', () => {
    // The inventory in `describe` is what a host reads to decide what it may
    // call. A capability advertised there with no command behind it is exactly
    // the fabricated support this repository's rules forbid.
    const contractNames = new Set(AGENT_COMMANDS.map((command) => command.name));
    const advertised = CAPABILITIES.filter(
      (capability) => capability.status === 'AVAILABLE' && capability.command !== undefined,
    );
    expect(advertised.length).toBeGreaterThan(0);
    for (const capability of advertised) {
      expect(contractNames.has(capability.command ?? ''), capability.id).toBe(true);
    }
    // …and the converse: a command in the contract that the CLI cannot run
    // would be advertised by an adapter and then refused.
    const availableCommands = new Set(advertised.map((capability) => capability.command));
    for (const name of contractNames) {
      expect(availableCommands.has(name), name).toBe(true);
    }
  });
});

function sourceFiles(relativeDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(`${ROOT}${relativeDir}`, { withFileTypes: true })) {
    const path = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}
