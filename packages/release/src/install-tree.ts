/**
 * The tree `npm install github:…/waterx-predict-agent` installs (ADR-0019).
 *
 * The repository is a pnpm workspace, and npm cannot install one: the CLI
 * depends on the SDK and the schema through `workspace:*`, which npm does not
 * resolve. The operator bundle (ADR-0010) answers that with two tarballs, and
 * still will — this is the second way in, for the hosts that expect the same
 * one sentence the perp agent uses.
 *
 * What it does is deliberately small. It copies the four built packages into
 * one tree and rewrites the only two bare specifiers that cross a package
 * boundary (`@waterx/predict-agent-sdk`, `@waterx/predict-agent-schema`) into
 * relative paths. Nothing is bundled, minified or transformed otherwise: what
 * runs from a git install is the same JavaScript `pnpm build` produced, so a
 * stack trace still names the file it came from.
 *
 * Third-party dependencies are NOT vendored. They stay bare specifiers and are
 * declared by the root package, so npm installs them from the registry exactly
 * as it does for the perp agent.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One workspace package, and where its build lands in the installed tree. */
interface Part {
  /** Package directory under `packages/`. */
  readonly from: string;
  /** Directory under `dist/install/`. */
  readonly to: string;
}

export const INSTALL_PARTS: readonly Part[] = [
  { from: 'cli', to: 'cli' },
  { from: 'sdk', to: 'sdk' },
  { from: 'schema', to: 'schema' },
  { from: 'signer-keystore', to: 'keystore' },
];

/** The bare specifiers that cross a package boundary, and what they become. */
export const CROSS_PACKAGE_SPECIFIERS: Readonly<Record<string, string>> = {
  '@waterx/predict-agent-sdk': 'sdk/index.js',
  '@waterx/predict-agent-schema': 'schema/index.js',
};

/** Where each binary's entry lands in the tree. */
export const INSTALL_ENTRIES = {
  cli: 'cli/main.js',
  keystore: 'keystore/bin/keystore.js',
} as const;

export interface AssembleResult {
  readonly root: string;
  readonly files: number;
  readonly rewrites: number;
}

const rewriteIn = (contents: string, fromFile: string, treeRoot: string): { text: string; count: number } => {
  let count = 0;
  let text = contents;
  for (const [specifier, target] of Object.entries(CROSS_PACKAGE_SPECIFIERS)) {
    // Both the static form and the dynamic one; nothing else may name a package.
    for (const quote of ["'", '"']) {
      const needle = `${quote}${specifier}${quote}`;
      if (!text.includes(needle)) continue;
      let path = relative(join(fromFile, '..'), join(treeRoot, target)).replaceAll('\\', '/');
      if (!path.startsWith('.')) path = `./${path}`;
      text = text.split(needle).join(`${quote}${path}${quote}`);
      count += 1;
    }
  }
  return { text, count };
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

/**
 * Build `dist/install/` from the packages' `dist/src`, and refuse anything that
 * would not run: a missing build, or a bare `@waterx/…` specifier left behind.
 */
export function assembleInstallTree(repoRoot: string): AssembleResult {
  const root = join(repoRoot, 'dist', 'install');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  let files = 0;
  let rewrites = 0;
  for (const part of INSTALL_PARTS) {
    const source = join(repoRoot, 'packages', part.from, 'dist', 'src');
    try {
      if (!statSync(source).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error(`${source} is not there; run \`pnpm build\` before assembling the install tree`);
    }
    const destination = join(root, part.to);
    // Declaration files and maps are for a library consumer; what runs is the
    // JavaScript, and shipping the rest would only make the install bigger.
    cpSync(source, destination, {
      recursive: true,
      filter: (path) => statSync(path).isDirectory() || (path.endsWith('.js') && !path.endsWith('.d.js')),
    });
  }

  for (const file of walk(root)) {
    files += 1;
    const contents = readFileSync(file, 'utf8');
    const { text, count } = rewriteIn(contents, file, root);
    rewrites += count;
    if (count > 0) writeFileSync(file, text);
    const leftover = /from ['"]@waterx\/[^'"]+['"]/u.exec(count > 0 ? text : contents);
    if (leftover !== null) {
      throw new Error(`${file} still imports ${leftover[0]}; the install tree would not resolve it`);
    }
  }

  for (const entry of Object.values(INSTALL_ENTRIES)) {
    const path = join(root, entry);
    try {
      statSync(path);
    } catch {
      throw new Error(`the install tree has no ${entry}; a binary would point at nothing`);
    }
  }

  writeFileSync(
    join(root, 'ASSEMBLED.json'),
    `${JSON.stringify({ assembledAt: new Date().toISOString(), parts: INSTALL_PARTS, files, rewrites }, null, 2)}\n`,
  );
  return { root, files, rewrites };
}
