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

/** Repository root, with a trailing slash. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));

const read = (relativePath: string): string => readFileSync(`${ROOT}${relativePath}`, 'utf8');
const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(read(relativePath)) as Record<string, unknown>;

const PACKAGE_DIRS = readdirSync(`${ROOT}packages`).filter((entry) =>
  statSync(`${ROOT}packages/${entry}`).isDirectory(),
);

/** Packages that ship to a registry. Everything else must be `private`. */
const PUBLISHED = new Set(['sdk']);

/** Reserved boundaries with no implementation. They must not look like one. */
const RESERVED = new Set(['cli', 'runner', 'mcp']);

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
    expect(new Set(PACKAGE_DIRS)).toEqual(new Set([...PUBLISHED, ...RESERVED]));
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

  it('keeps the published packages free of runtime dependencies', () => {
    for (const dir of PUBLISHED) {
      expect(manifest(dir).dependencies, dir).toBeUndefined();
    }
  });

  it('never lets a published package import a reserved one, in source', () => {
    const reservedNames = [...RESERVED].map((dir) => manifest(dir).name ?? dir);
    for (const dir of PUBLISHED) {
      for (const file of sourceFiles(`packages/${dir}/src`)) {
        for (const name of reservedNames) {
          expect(read(file), `${file} imports ${name}`).not.toContain(`from '${name}'`);
        }
      }
    }
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

function sourceFiles(relativeDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(`${ROOT}${relativeDir}`, { withFileTypes: true })) {
    const path = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}
