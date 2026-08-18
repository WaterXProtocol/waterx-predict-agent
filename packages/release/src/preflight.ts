/**
 * The mechanical gate that runs before anything is published.
 *
 * Three outcomes, not two:
 *
 * - `PASS` — checked and correct.
 * - `FAIL` — checked and wrong. Someone has to fix the repository.
 * - `UNRESOLVED` — *not* checked. The fact lives outside this workspace: a
 *   registry URL nobody has configured, a third-party package that declares no
 *   licence. This tool cannot settle those, and a green run that quietly
 *   swallowed them would be a lie told by a passing build.
 *
 * `--strict` refuses on `UNRESOLVED`. That is the mode the release workflow
 * runs, so the release path demands a human answer for every fact this tool
 * could not establish, while day-to-day CI still reports them without blocking
 * unrelated work.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildSbomArtifacts, SBOM_DIR } from './artifacts.ts';
import { packageKey, readIntegrityIndex, resolveComponentGraph, type InstalledPackage } from './graph.ts';
import { LICENSE_REVIEWS, licenseReviewFor } from './license-review.ts';
import { findRepoRoot, publishedPackages, type WorkspacePackage } from './workspace.ts';

export type CheckStatus = 'PASS' | 'FAIL' | 'UNRESOLVED';

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** What was found. On anything but `PASS`, what a human has to do about it. */
  readonly detail: string;
}

export interface PreflightReport {
  readonly checks: readonly Check[];
  readonly failed: number;
  readonly unresolved: number;
}

/** The Node floor every published package promises. */
export const NODE_FLOOR = 20;

const pass = (id: string, title: string, detail: string): Check => ({ id, title, status: 'PASS', detail });
const fail = (id: string, title: string, detail: string): Check => ({ id, title, status: 'FAIL', detail });
const unresolved = (id: string, title: string, detail: string): Check => ({
  id,
  title,
  status: 'UNRESOLVED',
  detail,
});

const verdict = (id: string, title: string, problems: readonly string[], ok: string): Check =>
  problems.length === 0 ? pass(id, title, ok) : fail(id, title, problems.join('; '));

const field = (pkg: WorkspacePackage, key: string): unknown => pkg.manifest[key];

/**
 * The lowest Node major a range admits, or `null` when this parser will not
 * claim to understand it. `null` is reported as unresolved rather than assumed
 * compatible: a range we cannot read is not a range we have checked.
 */
export function minimumNodeMajor(range: string): number | null {
  const alternatives = range.split('||');
  const majors: number[] = [];
  for (const alternative of alternatives) {
    const match = /(?:>=?|\^|~)?\s*v?(\d+)/u.exec(alternative.trim());
    if (match?.[1] === undefined) return null;
    if (/</u.test(alternative) && !/>=?/u.test(alternative)) return null;
    majors.push(Number(match[1]));
  }
  return majors.length === 0 ? null : Math.min(...majors);
}

const checkManifests = (packages: readonly WorkspacePackage[]): Check => {
  const problems: string[] = [];
  for (const pkg of packages) {
    const require = (condition: boolean, message: string): void => {
      if (!condition) problems.push(`${pkg.name}: ${message}`);
    };
    require(field(pkg, 'type') === 'module', 'type is not "module"');
    require(field(pkg, 'license') === 'MIT', 'license is not MIT');
    require(
      typeof field(pkg, 'engines') === 'object' &&
        (field(pkg, 'engines') as { node?: unknown }).node === `>=${String(NODE_FLOOR)}`,
      `engines.node is not ">=${String(NODE_FLOOR)}"`,
    );
    require(typeof field(pkg, 'exports') === 'object', 'declares no exports map');
    require(typeof field(pkg, 'description') === 'string', 'declares no description');

    const files = field(pkg, 'files');
    const fileList = Array.isArray(files) ? files.map(String) : [];
    for (const required of ['dist', 'LICENSE', 'README.md']) {
      require(fileList.includes(required), `files omits ${required}`);
    }
    for (const required of ['LICENSE', 'README.md']) {
      require(existsSync(join(pkg.directory, required)), `${required} is missing on disk`);
    }
  }
  return verdict(
    'manifest-metadata',
    'Published manifests declare the metadata a registry entry needs',
    problems,
    `${String(packages.length)} published packages carry licence, engines, exports and files.`,
  );
};

const checkPublishConfig = (packages: readonly WorkspacePackage[]): Check => {
  const problems: string[] = [];
  for (const pkg of packages) {
    const config = field(pkg, 'publishConfig');
    const values = (typeof config === 'object' && config !== null ? config : {}) as Record<string, unknown>;
    // A scoped package defaults to restricted; publishing one without this is
    // an access error at the registry, after the version is already burned.
    if (pkg.name.startsWith('@') && values['access'] !== 'public') {
      problems.push(`${pkg.name}: publishConfig.access is not "public"`);
    }
    if (values['provenance'] !== true) {
      problems.push(`${pkg.name}: publishConfig.provenance is not true`);
    }
  }
  return verdict(
    'publish-config',
    'Scoped packages publish public, with provenance',
    problems,
    'Every published package requests public access and a provenance attestation.',
  );
};

const checkRepository = (repoRoot: string, packages: readonly WorkspacePackage[]): Check => {
  const missing = packages.filter((pkg) => {
    const repository = field(pkg, 'repository');
    const url =
      typeof repository === 'string'
        ? repository
        : typeof repository === 'object' && repository !== null
          ? (repository as { url?: unknown }).url
          : undefined;
    return typeof url !== 'string' || url.trim() === '';
  });

  if (missing.length === 0) {
    return pass(
      'repository-provenance',
      'Every published package names the repository provenance will attest to',
      'A repository URL is declared for each published package.',
    );
  }

  return unresolved(
    'repository-provenance',
    'Every published package names the repository provenance will attest to',
    `${missing.map((pkg) => pkg.name).join(', ')} declare no repository URL. npm provenance ` +
      'attests a build to a source repository and refuses without one, and this workspace has ' +
      `no canonical remote to fill in (${repoRoot}). A human must set the URL before publishing.`,
  );
};

const checkVersions = (packages: readonly WorkspacePackage[]): Check => {
  const versions = new Set(packages.map((pkg) => pkg.version));
  const workspaceNames = new Set(packages.map((pkg) => pkg.name));
  const problems: string[] = [];

  if (versions.size > 1) {
    problems.push(`published versions disagree: ${[...versions].sort().join(', ')}`);
  }
  for (const pkg of packages) {
    const dependencies = field(pkg, 'dependencies');
    const entries = typeof dependencies === 'object' && dependencies !== null ? dependencies : {};
    for (const [name, range] of Object.entries(entries as Record<string, unknown>)) {
      // `workspace:` is rewritten at pack time, so it is the correct form here;
      // a hard-coded sibling version is the one that silently goes stale.
      if (workspaceNames.has(name) && !String(range).startsWith('workspace:')) {
        problems.push(`${pkg.name} depends on ${name}@${String(range)} instead of workspace:`);
      }
    }
  }

  return verdict(
    'version-alignment',
    'Published packages share one version and reference each other by workspace protocol',
    problems,
    `All published packages are at ${[...versions][0] ?? 'n/a'}.`,
  );
};

const checkDistBuilt = (packages: readonly WorkspacePackage[]): Check => {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const key of ['main', 'types'] as const) {
      const entry = field(pkg, key);
      if (typeof entry !== 'string') {
        problems.push(`${pkg.name}: no ${key}`);
        continue;
      }
      if (!existsSync(join(pkg.directory, entry))) {
        problems.push(`${pkg.name}: ${key} points at ${entry}, which is not built`);
      }
    }
  }
  return verdict(
    'dist-built',
    'Declared entry points exist on disk',
    problems,
    'Every published entry point resolves to a built file.',
  );
};

interface ShippedComponent {
  readonly component: InstalledPackage;
  readonly shippedBy: string;
}

const shippedComponents = (packages: readonly WorkspacePackage[]): readonly ShippedComponent[] => {
  const byKey = new Map<string, ShippedComponent>();
  for (const pkg of packages) {
    for (const component of resolveComponentGraph(pkg.directory).components) {
      const key = packageKey(component);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, { component, shippedBy: pkg.name });
      } else {
        byKey.set(key, { component, shippedBy: `${existing.shippedBy}, ${pkg.name}` });
      }
    }
  }
  return [...byKey.values()].sort((left, right) =>
    packageKey(left.component).localeCompare(packageKey(right.component)),
  );
};

const checkThirdPartyLicenses = (shipped: readonly ShippedComponent[]): Check => {
  const shippedKeys = new Set(shipped.map((entry) => packageKey(entry.component)));
  const undeclared = shipped.filter((entry) => entry.component.license === null);
  const unreviewed = undeclared.filter((entry) => licenseReviewFor(packageKey(entry.component)) === undefined);

  // A review pinned to a version that is no longer shipped is not harmless: it
  // reads as coverage. Failing on it forces the next bump to be re-reviewed
  // rather than inheriting the last answer.
  const orphaned = LICENSE_REVIEWS.filter((review) => !shippedKeys.has(review.component));
  if (orphaned.length > 0) {
    return fail(
      'third-party-licenses',
      'Every shipped dependency has a licence, declared or reviewed',
      `${orphaned.map((review) => review.component).join(', ')} no longer ship. Delete the stale ` +
        'entries from license-review.ts, and review whatever replaced them.',
    );
  }

  if (unreviewed.length > 0) {
    return unresolved(
      'third-party-licenses',
      'Every shipped dependency has a licence, declared or reviewed',
      `${unreviewed
        .map((entry) => `${packageKey(entry.component)} (via ${entry.shippedBy})`)
        .join(', ')} declare no licence in their manifest. This tool will not guess one. A human ` +
        'must read the package, then record the finding in license-review.ts before publishing.',
    );
  }

  const reviewed =
    undeclared.length === 0 ? '' : ` ${String(undeclared.length)} of them by recorded human review.`;
  return pass(
    'third-party-licenses',
    'Every shipped dependency has a licence, declared or reviewed',
    `${String(shipped.length)} third-party components, all with a licence.${reviewed}`,
  );
};

const checkEnginesFloor = (shipped: readonly ShippedComponent[]): Check => {
  const above: string[] = [];
  const unreadable: string[] = [];
  for (const entry of shipped) {
    if (entry.component.engines === null) continue;
    const minimum = minimumNodeMajor(entry.component.engines);
    if (minimum === null) {
      unreadable.push(`${packageKey(entry.component)} (${entry.component.engines})`);
      continue;
    }
    if (minimum > NODE_FLOOR) {
      above.push(`${packageKey(entry.component)} needs node ${entry.component.engines}`);
    }
  }
  if (above.length > 0) {
    return fail(
      'engines-floor',
      `No shipped dependency needs more than Node ${String(NODE_FLOOR)}`,
      `${above.join('; ')}, above the >=${String(NODE_FLOOR)} the published packages promise. ` +
        'Either raise the declared floor or drop the dependency.',
    );
  }
  if (unreadable.length > 0) {
    return unresolved(
      'engines-floor',
      `No shipped dependency needs more than Node ${String(NODE_FLOOR)}`,
      `${unreadable.join('; ')}: this tool does not parse those ranges. Read them by hand.`,
    );
  }
  return pass(
    'engines-floor',
    `No shipped dependency needs more than Node ${String(NODE_FLOOR)}`,
    `Every shipped component admits Node ${String(NODE_FLOOR)}.`,
  );
};

const checkIntegrityCoverage = (repoRoot: string, shipped: readonly ShippedComponent[]): Check => {
  const integrity = readIntegrityIndex(readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  const missing = shipped
    .filter((entry) => integrity.get(packageKey(entry.component)) === undefined)
    .map((entry) => packageKey(entry.component));

  return verdict(
    'integrity-coverage',
    'Every shipped dependency has a lockfile integrity hash',
    missing.length === 0
      ? []
      : [
          `${missing.join(', ')} have no integrity entry in pnpm-lock.yaml, so the SBOM states no ` +
            'hash for them. Reinstall against the committed lockfile.',
        ],
    `All ${String(shipped.length)} shipped components carry a registry hash into the SBOM.`,
  );
};

const checkSbomCurrent = (repoRoot: string): Check => {
  const problems: string[] = [];
  for (const artifact of buildSbomArtifacts(repoRoot)) {
    const path = join(repoRoot, SBOM_DIR, artifact.fileName);
    let current: string;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      problems.push(`${join(SBOM_DIR, artifact.fileName)} is missing`);
      continue;
    }
    if (current !== artifact.contents) problems.push(`${join(SBOM_DIR, artifact.fileName)} is stale`);
  }
  return verdict(
    'sbom-current',
    'The committed SBOMs match the installed tree',
    problems.length === 0 ? [] : [`${problems.join('; ')}. Run \`pnpm sbom:generate\`.`],
    'Every committed SBOM regenerates byte-for-byte.',
  );
};

const checkReleaseDocs = (repoRoot: string): Check => {
  const problems: string[] = [];
  for (const path of [join('docs', 'RELEASE.md'), join('LICENSE')]) {
    if (!existsSync(join(repoRoot, path))) problems.push(`${path} is missing`);
  }
  return verdict(
    'release-docs',
    'The release process and upgrade/rollback policy are written down',
    problems,
    'docs/RELEASE.md is present.',
  );
};

/** Run every check against a workspace. Reads only; changes nothing. */
export function runPreflight(repoRoot: string = findRepoRoot()): PreflightReport {
  const packages = publishedPackages(repoRoot);
  const shipped = shippedComponents(packages);

  const checks: readonly Check[] = [
    checkManifests(packages),
    checkPublishConfig(packages),
    checkRepository(repoRoot, packages),
    checkVersions(packages),
    checkDistBuilt(packages),
    checkThirdPartyLicenses(shipped),
    checkEnginesFloor(shipped),
    checkIntegrityCoverage(repoRoot, shipped),
    checkSbomCurrent(repoRoot),
    checkReleaseDocs(repoRoot),
  ];

  return {
    checks,
    failed: checks.filter((check) => check.status === 'FAIL').length,
    unresolved: checks.filter((check) => check.status === 'UNRESOLVED').length,
  };
}

export function formatReport(report: PreflightReport, strict: boolean): string {
  const lines = [`release preflight — ${String(report.checks.length)} checks${strict ? ' (strict)' : ''}`, ''];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(10)} ${check.id}`);
    lines.push(`           ${check.title}`);
    lines.push(`           ${check.detail}`);
    lines.push('');
  }
  const passed = report.checks.length - report.failed - report.unresolved;
  lines.push(
    `${String(passed)} passed, ${String(report.failed)} failed, ${String(report.unresolved)} unresolved`,
  );
  if (report.unresolved > 0) {
    lines.push(
      strict
        ? 'Unresolved checks block a release. Each one names a fact this tool cannot establish.'
        : 'Unresolved checks are not failures here, but --strict refuses on them. Publishing is blocked until a human settles each one.',
    );
  }
  return `${lines.join('\n')}\n`;
}

export const exitCodeFor = (report: PreflightReport, strict: boolean): number =>
  report.failed > 0 || (strict && report.unresolved > 0) ? 1 : 0;
