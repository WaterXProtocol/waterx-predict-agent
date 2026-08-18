# Releasing

How a version of this workspace becomes something a stranger can install, and
what has to be true before it does. The binding decisions behind this document
are ADR-0009; what is actually implemented is `docs/IMPLEMENTATION_BACKLOG.md`.
Where this file and the backlog disagree about status, the backlog wins.

**Nothing here has been published yet.** Everything below describes a path that
has been built and mechanically checked, not one that has been walked.

## What ships

| Package | First wave | Why |
| --- | --- | --- |
| `@waterx/predict-agent-sdk` | Yes | A contract. Verifiable by reading it against the backend wire contract. |
| `@waterx/predict-agent-schema` | Yes | The command registry every other package validates against. |
| `@waterx/predict-agent-cli` | No — `private` | Operational software that places orders. Its end-to-end path has never run (backlog 1.11). |
| `@waterx/predict-agent-runner` | No — `private` | Same, plus it holds the signer and has no drain path yet. |
| `@waterx/predict-agent-adapters` | No — `private` | Built (backlog 3.2). Held with the CLI it instructs an agent to call. |
| `@waterx/predict-agent-mcp` | No — `private` | Built (backlog 3.2). Held for the same reason; D-28 in ADR-0009. |
| `@waterx/predict-agent-release` | Never | This tooling. `private` permanently. |

`private: true` is the release gate. A package becomes publishable by having
that flag removed, and the preflight and the SBOM generator pick it up from
there — there is no second list to update.

## Before anything is published

These are gates, not a checklist to work around.

1. **`pnpm typecheck && pnpm test && pnpm build` pass** on a clean checkout.
2. **Every generated artifact regenerates byte-for-byte** — the command schema,
   the agent instructions, and the SBOMs. CI enforces all three with
   `git diff --exit-code`.
3. **`pnpm release:preflight:strict` exits 0.** It refuses on anything it could
   not establish; see below.
4. **The backend wire contract is in sync.** The vendored contract in the SDK
   must be identical, below its header, to the backend's own. A wire change is
   made in the backend first.
5. **Backlog 1.11 has actually run** against a real server before any executable
   package (CLI, Runner, MCP) is published. It has not. As of this writing it is
   `PARTIAL`: 1 step passed, 19 never ran.

## The preflight

```
pnpm release:preflight          # report
pnpm release:preflight:strict   # the release gate
```

It has three outcomes, and the third is the point:

- **PASS** — checked and correct.
- **FAIL** — checked and wrong. Fix the repository.
- **UNRESOLVED** — *not checked*. The fact lives outside this workspace and no
  tool here can settle it.

`--strict` refuses on `UNRESOLVED`. Ordinary CI does not, so an unsettled
external fact reports itself on every run without blocking unrelated work,
while the release path demands a human answer for each one.

Currently unresolved:

- **No repository URL.** npm provenance attests a build to a source repository
  and cannot be produced without one. This workspace has no configured remote,
  so `repository` is absent from both published manifests. **A human must set it
  before the first publish**; nothing else in the release path can proceed past
  it.

## Provenance

Both published packages declare `publishConfig: { access: "public", provenance:
true }`. Provenance is produced by the registry from a CI run, so it requires
all of:

- a `repository` field in the manifest (see above — not yet set),
- `id-token: write` permission in the publishing workflow,
- publishing from that workflow, never from a developer machine,
- an npm token with publish rights, stored as a repository secret.

`.github/workflows/release.yml` is the only publish path. It is
`workflow_dispatch`-only and **defaults to a dry run**: publishing requires
explicitly setting the dry-run input to `false`. There is no tag trigger and no
push trigger, because a release should be an act someone performs, not a
side-effect of a merge.

## SBOM

```
pnpm sbom:generate         # write sbom/v1/*.cdx.json
pnpm sbom:check            # verify the committed set
```

One CycloneDX 1.6 document per published package, committed at
`sbom/v1/<package>.cdx.json`.

What it is, precisely — the document states each of these about itself:

- **Runtime dependencies only.** `devDependencies` never reach a consumer;
  `peerDependencies` are the consumer's to supply. Build tooling is out of
  scope, and the exclusion is recorded rather than left to be inferred.
- **Resolved from the installed tree**, not from declared ranges, so the
  versions are the ones a consumer gets — realpath'd through pnpm's virtual
  store, so one store entry is one component.
- **Integrity hashes from the lockfile**, converted to CycloneDX hex. A
  component with no lockfile entry gets no hash rather than a fabricated one.
- **No timestamp, and a content-derived serial number.** Regenerating an
  unchanged workspace produces identical bytes, which is what lets CI prove the
  committed file is still the generator's output.

### Undeclared licences

A package that omits `license` is not a package without one — it is one
somebody has to go read. The generator reports it as undeclared and refuses to
guess. A human reads the package and records the finding, with evidence and
pinned to the exact version, in `packages/release/src/license-review.ts`. The
SBOM then states that licence *and* marks its source as human review, so no
reader has to assume it came from the package.

The preflight fails on a review pinned to a version that no longer ships, so a
dependency bump forces a fresh reading instead of inheriting the old answer.

One review exists today: `xmlhttprequest-ssl@2.1.2`, reached transitively
through `socket.io-client` → `engine.io-client`, which uses npm's deprecated
`licenses: [{type: "MIT"}]` array form and ships a verbatim MIT text.

## Versioning and the support window

Published packages release **in lockstep at a single version**. A change in
either releases both.

During beta the supported window is **the current minor and the one before it**.
Outside it, refuse with the version in the error — never a silent downgrade:

- Local IPC carries a protocol version on every frame; a mismatch is refused by
  number (ADR-0008).
- A client that does not recognize the server's command-schema version may
  perform **reads** and must refuse **writes** — anything that places, cancels
  or alters an order or a job.

Beta means the contract may change between minors. It does not mean a version
mismatch is handled quietly.

## Updating an installation

There is no auto-update. An update is something an operator does.

**Upgrade, with no active jobs:** install the new version, restart the Runner.

**Upgrade, with active jobs:** drain first. The required sequence is refuse new
admission → let in-flight work reach a terminal or safely resumable state →
persist → exit.

> A drain that gates new admission **does not exist yet** (backlog 2.14).
> `runner.shutdown` is a clean stop, not a drain, and must not be presented as
> one. It does close the socket and then await the scheduler pass in flight, so
> it will not abandon a half-finished create/sign/submit — but it refuses no
> admission first and reports nothing about what it left unfinished. Until the
> drain path lands, the supported upgrade procedure for a Runner with active
> jobs is: stop submitting work, watch `strategy list` until nothing is
> mid-execution, then shut down and restart on the new version.

**Rollback:** install the previous version and restart. This is safe only while
the job store schema is backward-compatible. A release that changes the store
schema in a way the previous version cannot read is **not rollback-safe** and
must say so in its notes — the store is the record of what a job already did
with real money, and a downgrade that silently reinterprets it is worse than a
failed start.

Because there is no update channel, a security fix reaches an installation only
when its operator acts. Release notes state severity plainly for that reason.

## Telemetry

None. No metrics endpoint, no crash reporter, no usage ping, no update check,
in any package. Adding any of those requires an ADR superseding ADR-0009. If
operational telemetry is ever added it is opt-in and off by default, and it may
never carry prompts, strategy parameters, addresses, order contents, tokens,
signatures, or anything derived from a key.

Local logs are not telemetry. They stay local, and no secret is written to a log
line or an error body.

## The release run

1. Land everything on the release branch; the working tree is clean.
2. `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build`
3. `pnpm sbom:generate` — commit any change. If it changed, a dependency moved
   and the SBOM is part of the release.
4. `pnpm release:preflight:strict` — must exit 0.
5. Bump both published packages to the same version; write release notes that
   state, explicitly: whether the store schema changed, whether rollback is
   safe, and the severity of any security fix.
6. Dispatch `.github/workflows/release.yml` with dry-run **true**. Read the
   packed file list and the preflight output.
7. Dispatch it again with dry-run **false**. This is the only step that
   publishes.
8. Verify on the registry that provenance is attached to both packages.
9. Tag the release commit.

## What a first release does not prove

Stated here because a published package looks finished:

- The end-to-end path against a real backend has never run (backlog 1.11:
  `PARTIAL`, 1 step passed, 19 never ran, 10 gaps outstanding).
- No order has ever been placed by this code against any server, testnet or
  otherwise.
- Install and import have been verified on macOS/arm64 under Node 20, 22 and 26.
  Linux has not been verified here, and ADR-0002's platform claims rest on the
  Runner's own requirements rather than on an executed matrix.
- The SBOM describes what is installed. It is not a vulnerability scan and makes
  no claim about the security of any component it lists.
