/**
 * The preflight's value is its third outcome. A gate with only pass and fail
 * has to choose between blocking on facts it cannot check and pretending it
 * checked them; this one reports `UNRESOLVED` and lets the caller decide, so
 * these tests pin that behaviour as hard as the checks themselves.
 *
 * The run against the real workspace is deliberate: a preflight that only ever
 * runs on fixtures is a preflight nobody has flown.
 */
import { describe, expect, it } from 'vitest';

import { LICENSE_REVIEWS } from '../src/license-review.ts';
import { exitCodeFor, formatReport, minimumNodeMajor, NODE_FLOOR, runPreflight } from '../src/preflight.ts';
import { findRepoRoot, publishedPackages } from '../src/workspace.ts';

const report = runPreflight(findRepoRoot());
const checkFor = (id: string): { status: string; detail: string } => {
  const check = report.checks.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check;
};

describe('minimumNodeMajor', () => {
  it('reads the common range forms', () => {
    expect(minimumNodeMajor('>=10.0.0')).toBe(10);
    expect(minimumNodeMajor('>= 14')).toBe(14);
    expect(minimumNodeMajor('^18.17.0')).toBe(18);
    expect(minimumNodeMajor('>=0.4.0')).toBe(0);
  });

  it('takes the lowest alternative, since any one of them may be the host', () => {
    expect(minimumNodeMajor('^18 || >=20')).toBe(18);
  });

  it('returns null for a range it will not claim to understand', () => {
    expect(minimumNodeMajor('*')).toBeNull();
    expect(minimumNodeMajor('<14')).toBeNull();
  });
});

describe('exitCodeFor', () => {
  const base = { checks: [], failed: 0, unresolved: 0 };

  it('passes a clean report in either mode', () => {
    expect(exitCodeFor(base, false)).toBe(0);
    expect(exitCodeFor(base, true)).toBe(0);
  });

  it('refuses on a failure regardless of mode', () => {
    expect(exitCodeFor({ ...base, failed: 1 }, false)).toBe(1);
    expect(exitCodeFor({ ...base, failed: 1 }, true)).toBe(1);
  });

  it('lets an unresolved check through only outside strict mode', () => {
    expect(exitCodeFor({ ...base, unresolved: 1 }, false)).toBe(0);
    expect(exitCodeFor({ ...base, unresolved: 1 }, true)).toBe(1);
  });
});

describe('formatReport', () => {
  it('prints every check, and says what unresolved means for publishing', () => {
    const text = formatReport(report, false);
    for (const check of report.checks) expect(text).toContain(check.id);
    if (report.unresolved > 0) expect(text).toContain('--strict');
  });
});

describe('runPreflight against this workspace', () => {
  it('finds no failing check', () => {
    // `dist-built` is excluded: this workspace runs `pnpm test` before
    // `pnpm build` on purpose — the suites resolve source, not dist — so the
    // absence of a build here says nothing about release readiness. The release
    // workflow builds first and runs the same check for real.
    const failures = report.checks.filter(
      (check) => check.status === 'FAIL' && check.id !== 'dist-built',
    );
    expect(failures.map((check) => `${check.id}: ${check.detail}`)).toEqual([]);
  });

  it('checks every published package and nothing private', () => {
    const published = publishedPackages(findRepoRoot());
    expect(published.map((pkg) => pkg.name).sort()).toEqual([
      '@waterx/predict-agent-schema',
      '@waterx/predict-agent-sdk',
    ]);
    expect(checkFor('manifest-metadata').detail).toContain(String(published.length));
  });

  it('confirms both published packages request public access and provenance', () => {
    expect(checkFor('publish-config').status).toBe('PASS');
  });

  it('holds the shipped dependency floor at the version the packages promise', () => {
    expect(checkFor('engines-floor').status).toBe('PASS');
    expect(NODE_FLOOR).toBe(20);
  });

  it('keeps the committed SBOMs current', () => {
    expect(checkFor('sbom-current').status).toBe('PASS');
  });

  it('reports the missing repository URL as unresolved, not as a pass', () => {
    // Provenance cannot be attested without one. Recording it as unresolved is
    // what keeps `--strict` from letting a release through on a fact nobody set.
    const check = checkFor('repository-provenance');
    expect(['PASS', 'UNRESOLVED']).toContain(check.status);
    if (check.status === 'UNRESOLVED') expect(check.detail).toContain('repository URL');
  });

  it('has no licence review left pinned to a version that no longer ships', () => {
    expect(checkFor('third-party-licenses').status).not.toBe('FAIL');
    for (const review of LICENSE_REVIEWS) expect(review.evidence.length).toBeGreaterThan(40);
  });
});
