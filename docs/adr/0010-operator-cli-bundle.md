# ADR-0010 — The CLI ships as one self-contained release tarball

- Status: Proposed
- Date: 2026-09-16
- Decides: how an operator installs `waterx-predict` without a registry, and
  when that installation may be handed to anyone outside this repository
- Amends: ADR-0009 D-28, for this one artifact and only once this ADR is
  Accepted
- Leaves unchanged: ADR-0009 D-26 (no auto-update), D-27 (provenance and SBOM),
  D-29 (version window), D-30 (no telemetry); ADR-0003 (the owner's mandate)
- Affects: `packages/cli`, `packages/release`, `.github/workflows/release.yml`

## Context

The setup an agent host wants is one sentence: *install this, run
`waterx-predict next --json`, and do what it says.* `runtime.next` (backlog 3.8)
makes the second half safe — it suggests only reads from the contract, stops
where a person has to act, and reports anything unsettled before anything new.
The first half is not possible today, for three independent reasons:

- **The CLI is `private`** (D-28). Nothing publishes it.
- **Its dependencies are unreachable.** It depends on the SDK and the schema
  through `workspace:*`, which npm does not understand, and neither library is
  on a registry yet.
- **A git URL does not help.** `npm install github:…` installs the repository
  root, which is a private pnpm workspace with no `bin`; npm cannot install a
  subdirectory of a git repository; and pnpm refuses a git dependency with a
  build step unless it is allow-listed first.

There is also a hazard in the obvious phrasing. `npx waterx-predict` falls
through to the public registry when nothing is installed locally, so an
instruction that spells it that way runs whatever package holds that name —
for a tool that places orders, that is an installation path an attacker can
occupy.

## Decision

### 1. One tarball, attached to a release, never published to a registry

The operator bundle is `@waterx/predict-agent-cli` packed with the SDK and the
schema inside it as `bundleDependencies`, taken from those packages' own
`npm pack` output. It is built by `pnpm cli:bundle` (`packages/release/src/bundle.ts`)
and is shaped as follows:

- **`private: true`**, so `npm publish` refuses it. It is a release asset.
- **No lifecycle scripts.** An operator installing with `--ignore-scripts`
  gets exactly what everybody else gets.
- **Third-party dependencies are not bundled.** The bundled packages'
  dependencies (today: `socket.io-client` and its chain) are lifted onto the
  bundle's `dependencies` and installed from the registry, under the
  consumer's own lockfile and integrity checks. Two different ranges for one
  name are a build failure, not a pick.
- **Only published packages are bundled.** A private workspace package inside
  it would ship code that never passed the published-package gates.
- **It carries its SBOM** (`sbom.cdx.json`, CycloneDX 1.6), and the release
  carries the same document and a `SHA256SUMS` beside the tarball. The SBOM
  is also committed at `sbom/bundle/` and verified byte-for-byte in CI, like
  every other generated artifact here.
- **Its version is the CLI's**, which moves in lockstep with the libraries
  (D-29).

### 2. The sentence, exactly

```
Run `npm install <release-asset-url>`, then `npx --no waterx-predict next --json`, and do what it says.
```

> **Amended by ADR-0012:** the install names two assets — this bundle and the
> keystore signer — in one `npm install`, and a release carries both or
> neither.

`--no` is part of the instruction, not a style choice: it makes a missing
install a failure instead of a registry lookup. `installSentence()` is the one
place the sentence is spelled.

### 3. Built and checked freely; released only when this ADR is Accepted

`pnpm cli:bundle` and `pnpm cli:bundle:check` run anywhere, and the check runs
in CI: it installs the tarballs with npm alone and scripts off, and follows the
sentence's second half in an emptied environment — since ADR-0012, all the way
from `SETUP_INCOMPLETE` to `READY` against a stub on 127.0.0.1.

Attaching the bundle to a release is `pnpm cli:bundle --release`, which reads
this file's `Status` line and refuses unless it says `Accepted`. The release
workflow runs only that command to produce what it attaches, from a job that is
manually dispatched and off by default. The decision therefore lives in one
reviewed place — this file — rather than in a workflow input.

### 4. What accepting this ADR means

D-28 withheld the CLI because its end-to-end path had not run against a real
server (backlog 1.11). Since then all twenty steps have run — against a backend
started locally on Sui testnet, driven by hand, not by the harness and not
against a deployed environment. Accepting this ADR accepts that residual gap
for this artifact, on the strength of three facts that did not exist when D-28
was written:

- the default execution policy is `interactive`, so an installed bundle can
  place no order without a person approving that exact intent;
- `next` never suggests a write, and stops at every step a person owns;
- every write is still gated by the owner's on-chain delegation and risk
  profile, which this runtime cannot grant itself (ADR-0003).

If that is not enough, leave this ADR Proposed until 1.11 has run against a
deployed environment. Nothing else needs to change: the bundle keeps being
built and checked, and cannot be released.

## What this forbids

- Publishing `@waterx/predict-agent-cli` to any registry. This ADR authorizes
  a release asset, nothing more.
- Documenting `npm install github:…` as an installation path for the CLI.
- Any published instruction that runs the CLI through `npx` without `--no`.
- A lifecycle script in the bundle, or a bundled package that is `private`.
- A release step that attaches the bundle without going through
  `cli:bundle --release`.
- Reading this ADR as authorizing the adapters, the MCP server or the Runner.
  They remain under D-28 as written.

## Consequences

- **A private repository means an authenticated download.** A release asset of
  a private repository is not fetchable by a plain `npm install <url>`; the
  sentence works as written only where the asset is reachable.
- **Installation still reaches the registry** for the third-party dependencies.
  An air-gapped operator has to mirror them, as they would for the SDK.
- **The checksum states what was released, not a reproducible build.** npm's
  tarball bytes can differ across npm versions; `SHA256SUMS` lets an operator
  verify the file they downloaded is the file that was attached.
- **Updates stay manual** (D-26). A new version is a new URL; nothing checks
  for one.
- **The adapters become installable later without a new shape.** They delegate
  to an installed `waterx-predict`, and this is the first way to have one
  outside the workspace. Shipping them is still a separate decision.
