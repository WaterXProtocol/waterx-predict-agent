# ADR-0019 — The repository installs with npm, as one sentence

- Status: Accepted
- Date: 2026-09-18 (the owner asked for the perp agent's install shape)
- Decides: how an agent host installs this runtime without a release
- Amends: ADR-0010 (the operator bundle is no longer the only way in), ADR-0012
- Affects: the repository root (`package.json`, `bin/`, `scripts/`),
  `packages/release`

## Context

The perp agent (`waterx-agent`) is one npm package in one repository, so its
whole setup is one sentence:

```
Run `npm install github:WaterXProtocol/waterx-agent`, then `npx waterx next --json`, and do what it says.
```

This repository is a pnpm workspace of ten packages, and npm cannot install
one: the CLI depends on the SDK and the schema through `workspace:*`. ADR-0010
answered that with two release tarballs, which works and has two costs — a
release has to exist first (none does), and the sentence carries two URLs
rather than one repository.

## Decision

### 1. The root is an installable package

`npm install github:WaterXProtocol/waterx-predict-agent` works, and gives the
same two binaries the bundle does: `waterx-predict` and
`waterx-predict-keystore`.

- **`prepare`** (`scripts/prepare-git-install.mjs`) runs only for npm. It picks
  a pnpm — one on PATH, else corepack, else `npx pnpm@<pinned>` — installs the
  workspace, runs `pnpm build`, and assembles the install tree. Anything that
  is not npm (a developer's `pnpm install`) returns immediately: building the
  world on every install would be a slow surprise, and `pnpm build` is still
  the command that builds here.
- **The tree** (`dist/install/`, from `packages/release/src/install-tree.ts`)
  is the four built packages — CLI, SDK, schema, keystore — copied as they
  were compiled, with the only two specifiers that cross a package boundary
  rewritten to relative paths. Nothing is bundled or minified: a stack trace
  still names the file it came from. The assembler refuses a missing build, a
  leftover `@waterx/…` specifier, or a missing binary entry.
- **Third-party dependencies are not vendored.** `@mysten/sui` and
  `socket.io-client` are declared by the root package and installed from the
  registry, exactly as the perp agent's are.
- **`pnpm install:check`** packs the working tree the way a git install packs
  it (`npm pack` runs the same `prepare`), installs it into a throwaway
  project with lifecycle scripts off, and walks `describe` → `next` →
  `keystore init` → `next`. CI runs it.

### 2. The bundle stays

ADR-0010's two tarballs remain the release artifacts, and `cli:bundle:check`
still walks them. They are what a release attaches, what carries an SBOM per
artifact, and what installs without a build step or a git credential.

| | git install (this ADR) | operator bundle (ADR-0010) |
| --- | --- | --- |
| Command | one repository | two tarball URLs |
| Needs a release | no | yes |
| Builds on the host | yes, about a minute, needs pnpm via corepack | no |
| Dependencies | from the registry, by range | pinned inside the tarball |
| SBOM | the repository's | one per artifact, attached |
| `@mysten/sui` in the CLI's tree | yes (one dependency tree for both binaries) | no (separate artifacts) |

### 3. What a private repository still costs

`npm install github:…` clones with the caller's git credentials. While this
repository is private, only a host whose git can read it can install this way —
the same condition the perp agent's sentence carries.

## Consequences

- **The sentence for an agent host becomes:**
  `Run `npm install github:WaterXProtocol/waterx-predict-agent`, then `npx --no waterx-predict next --json`, and do what it says.`
  `--no` stays: without it, `npx` would look the name up on the public registry.
- **The root package now has a `version` and a `bin`.** It stays `private`, so
  it can never be published to a registry by accident.
- **A git install is not reproducible the way the bundle is.** Its dependencies
  resolve by range at install time, and its build happens on the host. For an
  operator who needs the pinned artifact and its SBOM, the bundle is still the
  answer.
- **Two ways in mean two checks.** `install:check` and `cli:bundle:check` both
  run in CI, because a change that breaks either breaks somebody's setup.
