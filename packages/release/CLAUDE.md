# packages/release — `@waterx/predict-agent-release`

Release readiness. `private` **permanently** (ADR-0009), not pending a release.
No runtime dependencies.

- The CycloneDX 1.6 SBOM generator for each published package (from the
  **installed** tree, hashed from the lockfile, no timestamp) and the ten-check
  preflight whose third outcome is `UNRESOLVED` — a fact outside this workspace,
  refused by `--strict`. `pnpm sbom:generate` writes `sbom/v1/` (one document
  per published package) and `sbom/bundle/` (the operator bundle's); the SBOM
  states what each installs into a consumer. A licence is never guessed: an
  undeclared one is read by a human and pinned to an exact version in
  `src/license-review.ts` with its evidence.
- `src/consumer.ts` — the two ways to install what is about to ship before it
  ships: `pnpm consumer:kit` writes a portable project whose `file:`
  dependencies are the packed tarballs, `pnpm consumer:registry` serves the same
  tarballs scoped over HTTP so `npm install <name>` resolves by name, and
  `pnpm consumer:check` runs the install to a verdict — the `install` job in CI.
  Both pack whatever `publishedPackages` reports, so a `private` package can
  never be served, and both pack the working tree — rebuild first.
- `src/bundle.ts` — the one exception, and it is deliberate: `pnpm cli:bundle`
  packs the private CLI with the two published libraries inside it as a release
  asset, `pnpm cli:bundle:check` installs it with npm alone and runs `next`, and
  `--release` reads ADR-0010's `Status` line and refuses unless it says
  `Accepted`.
- `src/bin/assemble-install.ts` — behind `pnpm install:assemble` / the
  `install:check` CI step: the git-install shape (ADR-0019).

`sbom/` at the repo root is a **generated**, committed artifact. Never
hand-edit; CI diffs it against the generator, and a stale SBOM tells a scanner
the wrong version is installed.
