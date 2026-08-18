# `@waterx/predict-agent-release`

Release readiness for this workspace. It answers two questions about the
packages that ship, and it ships to nobody itself — it is `private`
permanently, not pending a release (ADR-0009).

1. **What does a published package actually carry into a consumer?**
   → a CycloneDX 1.6 SBOM per published package, committed at `sbom/v1/`.
2. **Is this workspace fit to publish right now?**
   → a preflight whose failures name the file to fix.

The full release procedure is `docs/RELEASE.md`. This README covers the tool.

## Commands

Run from the workspace root:

```
pnpm sbom:generate               # write sbom/v1/*.cdx.json
pnpm sbom:check                  # verify the committed set, write nothing
pnpm release:preflight           # report
pnpm release:preflight:strict    # the release gate; refuses on UNRESOLVED
```

## The SBOM

Generated from `node_modules` **as installed**, not from declared ranges — a
manifest states a range and an inventory has to state a version. Resolution
follows the same upward `node_modules` walk Node's resolver follows and
realpaths through pnpm's virtual store, so one store entry is one component
however many symlinks reach it.

Deliberate properties, each of which the document states about itself:

- **Runtime dependencies only.** `devDependencies` never reach a consumer and
  `peerDependencies` are the consumer's to supply. An SBOM that silently omits
  build tooling reads as a complete inventory, so the exclusion is a property
  next to the components.
- **No timestamp, content-derived serial number.** Regenerating an unchanged
  workspace produces identical bytes, which is what lets CI prove the committed
  file is still the generator's output — the same rule `schemas/v1/` and
  `agent-instructions/` are held to.
- **Hashes come from the lockfile.** A component with no lockfile entry gets no
  hash rather than a fabricated one, and a key whose peer-suffixed entries
  disagree is dropped rather than resolved arbitrarily.
- **Licences are never guessed.** A package that declares none is reported as
  undeclared; see below.

## Undeclared licences

npm's `license` field is the machine-readable answer, and a package that omits
it is not a package without a licence — it is one somebody has to go read.
The generator will not invent one.

A human reads the package, then records the finding in
`src/license-review.ts`, pinned to an exact version and carrying the evidence.
The SBOM emits that licence **and** marks its source as human review, so no
reader has to assume it came from the package itself. The preflight fails on a
review pinned to a version that no longer ships, so a dependency bump forces a
fresh reading rather than inheriting the old answer.

## The preflight's three outcomes

- **PASS** — checked and correct.
- **FAIL** — checked and wrong. Fix the repository.
- **UNRESOLVED** — *not checked*. The fact lives outside this workspace: a
  repository URL nobody has configured, a dependency that declares no licence.

Two outcomes would force a choice between blocking on facts the tool cannot
check and pretending it checked them. `--strict` refuses on `UNRESOLVED`, so the
release path demands a human answer for each one while ordinary CI keeps
reporting them without blocking unrelated work.

## Checks

| Check | What it establishes |
| --- | --- |
| `manifest-metadata` | Licence, engines, exports, `files`, and the LICENSE and README those promise. |
| `publish-config` | Public access and a provenance attestation are requested. |
| `repository-provenance` | A repository URL exists for provenance to attest to. |
| `version-alignment` | Published packages share one version; siblings referenced by `workspace:`. |
| `dist-built` | Declared entry points resolve to built files. |
| `third-party-licenses` | Every shipped dependency has a licence, declared or reviewed. |
| `engines-floor` | No shipped dependency needs more than the Node floor the packages promise. |
| `integrity-coverage` | Every shipped dependency has a lockfile hash to put in the SBOM. |
| `sbom-current` | The committed SBOMs regenerate byte-for-byte. |
| `release-docs` | The release process and upgrade/rollback policy are written down. |

`dist-built` fails on a workspace that has not been built. That is expected
outside a release: `pnpm test` runs before `pnpm build` here on purpose, since
the suites resolve source rather than `dist`.
