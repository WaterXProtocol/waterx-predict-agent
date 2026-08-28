# `@waterx/predict-agent-release`

Release readiness for this workspace. It answers three questions about the
packages that ship, and it ships to nobody itself — it is `private`
permanently, not pending a release (ADR-0009).

1. **What does a published package actually carry into a consumer?**
   → a CycloneDX 1.6 SBOM per published package, committed at `sbom/v1/`.
2. **Is this workspace fit to publish right now?**
   → a preflight whose failures name the file to fix.
3. **What is it like to install and use it?**
   → a consumer kit and a local registry, so the answer can be found out before
   a version is burned rather than after.

The full release procedure is `docs/RELEASE.md`. This README covers the tool.

## Commands

Run from the workspace root:

```
pnpm sbom:generate               # write sbom/v1/*.cdx.json
pnpm sbom:check                  # verify the committed set, write nothing
pnpm release:preflight           # report
pnpm release:preflight:strict    # the release gate; refuses on UNRESOLVED
pnpm consumer:kit <dir>          # a portable project against the packed tarballs
pnpm consumer:registry           # serve the same tarballs, resolvable by name
pnpm consumer:check              # pack, install, and assert what arrived — CI runs this
```

## Installing what is about to ship

A manifest can pass every mechanical check above and still ship a `files` list
that omits the document the package exists to deliver. The only way to find that
out is to install the thing.

Both tools pack whatever `publishedPackages` reports, so a package that becomes
publishable becomes installable in the same commit — and one that is `private`
cannot be served by accident. Both pack from the working tree, so **rebuild
first, and re-run them after any rebuild**: a stale tarball is the one way to
pass this check while shipping something else.

**The kit** is a directory: `package.json` with `file:` dependencies on vendored
tarballs, and the tarballs. `npm install` in it produces the same `node_modules`
a published install would.

```
pnpm build
pnpm consumer:kit ~/tmp/consumer --name my-betting-bot
cd ~/tmp/consumer && npm install
```

Vendoring the tarball rather than copying `dist/` is the whole point. A
hand-assembled folder tests the copier's judgement about what belongs in the
package, which is precisely the judgement `files` is supposed to be making.

**The registry** covers the one step a kit answers in advance: turning a name
into an install. It serves the same tarballs over HTTP, scoped, so real
dependencies still resolve from the public registry and the install keeps the
shape a published one would have.

```
pnpm build
pnpm consumer:registry            # holds the terminal; --port to move it
```

then, in a project that is not this one:

```
echo '@waterx:registry=http://127.0.0.1:4873' > .npmrc
npm install @waterx/predict-agent-sdk
```

The `.npmrc` is project-local on purpose: nothing has to be undone afterwards,
and no global npm config is touched.

**The check** is the same install, run to a verdict instead of to a prompt.
`pnpm consumer:check` packs into a throwaway project, installs, and asserts that
what each manifest promised arrived: every literal `files` entry, `main`,
`types`, every `bin`, an `import()` of the package by name, and every binary
spawned far enough to prove it can resolve its own imports. The `install` job in
`.github/workflows/verify.yml` runs it on every push.

What it asserts is derived from `files` and `bin`, never from a list written
here — a list here would be a second opinion about what should ship, and two
opinions disagreeing is the failure itself. That cuts one way only, and it is
worth being exact about which: it catches `files` promising something that did
not arrive. It cannot catch `files` forgetting to promise something, because the
expectation would go missing with the entry. That half is held by
`tests/workspace.test.ts`, which requires the agent-facing documents to be in
`files` at all. Neither check is sufficient alone.

`--keep` leaves the installed project in place to poke at.

Neither tool publishes anything, and neither can: `npm publish` refuses a
`private` package, and these never call it.

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
