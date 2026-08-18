# ADR-0009 — What is published, how it is updated, and what it reports home

- Status: Accepted
- Date: 2026-08-18
- Decides: D-26 (runtime auto-update), D-27 (release artifacts), D-28 (whether
  MCP ships in the first wave), D-29 (CLI/local API version support window),
  D-30 (telemetry and privacy defaults)
- Refines: ADR-0001 §6 (self-hosted, no managed-runner promise), ADR-0002
  (supported platforms), ADR-0006 (the command schema is the compatibility
  surface), ADR-0008 (local IPC and its protocol version)
- Affects: `waterx-predict-agent-sdk` (every package, published or not)

## Context

Everything in this repository has been built as if it would be installed by
somebody else, and none of it has been. The first publish is where several
questions that were deferred as "not Phase 0" become unavoidable at once,
because each of them is answered *by the act of publishing* whether or not
anyone writes the answer down:

- An installed runtime that updates itself is deciding, on its own, when to
  interrupt a process that holds job leases and will hold a signer.
- A package published without provenance or an inventory is a package a
  consumer cannot distinguish from one someone else pushed under the same name.
- A client and a Runner at different versions have to either negotiate or
  guess, and guessing here is guessing about order placement.
- A tool that ships a telemetry default ships it to every user who never read
  this file.

These are release decisions, not build decisions. The adapters and the MCP
server already exist (backlog 3.2); what remains is whether they go out.

## Decision

### D-26 — The runtime never updates itself

**There is no auto-update, on any channel, in any package.** An update is an
operator action: the operator installs a new version and restarts the Runner.

A Runner with active jobs must be **drained**, not restarted underneath them.
The drain sequence a release must support is: refuse new job admission →
let in-flight work reach a terminal or safely resumable state → persist →
exit. `runner.shutdown` exists and stops the process, and on its own is a clean
stop rather than a drain.

> **Status note, 2026-08-18.** When this ADR was accepted the drain did not
> exist, and this paragraph said so. It now does: `runner.drain`
> (`packages/runner/src/drain.ts`, backlog 2.14) closes admission at both the
> socket and the store while held jobs keep getting passes, and reports what is
> still settling rather than crossing its deadline in silence. The decision
> above is unchanged — only the sentence describing what had been built. The
> deliberate reading of "or safely resumable" is that a watching job does not
> hold a drain open; a job with an open side-effect attempt does.

Rollback is "install the previous version and restart", and it is only safe
while the job store's schema is backward-compatible. A release that changes the
store schema in a way the previous version cannot read **must say so in its
release notes and is not rollback-safe** — the store is the record of what a
job already did with real money, and a downgrade that silently reinterprets it
is worse than a failed start.

### D-27 — Provenance and an SBOM are mandatory; a container image is not

Every published package carries:

- **npm provenance.** `publishConfig.provenance: true`, published from a CI
  workflow with `id-token: write`, from a repository whose URL is declared in
  the manifest. Without provenance a consumer has no way to tie a tarball to a
  commit, and this runtime's whole safety story is "you can read what it does".
- **A CycloneDX 1.6 SBOM**, committed at `sbom/v1/<package>.cdx.json`,
  generated from the *installed* tree rather than from declared ranges, and
  verified byte-for-byte in CI like every other generated artifact here.

The SBOM covers runtime dependencies only, and says so inside the document. A
dependency that declares no licence is **not** given one by the generator; a
human reads the package and records the finding, with its evidence, in
`packages/release/src/license-review.ts`, pinned to the exact version.

**No container image ships in the first wave.** ADR-0001 §6 promises a
self-hosted runtime, not a managed one; an image would be a second supported
installation shape with its own base-image CVE surface and its own update
story, and there is no managed deployment asking for it.

### D-28 — The first wave is the two libraries only

`@waterx/predict-agent-sdk` and `@waterx/predict-agent-schema` publish.
`@waterx/predict-agent-cli`, `@waterx/predict-agent-adapters`,
`@waterx/predict-agent-mcp` and `@waterx/predict-agent-runner` stay `private`.

This is not a judgement about the adapters' quality — it is that the SDK and
the schema are *contracts*, verifiable against the backend wire contract by
reading them, while the CLI, the Runner and the MCP server are *operational
software* whose end-to-end path against a real server has never run (backlog
1.11). Publishing an executable that places orders on the strength of unit
tests alone would put the burden of that gap on whoever installs it.

The MCP server publishes when — and only when — 1.11 has actually run against a
real backend and the Runner's drain path exists. That is a backlog condition,
not a date. The second half is now met (see the status note above); the first is
not, and it is the one that matters most, so nothing moves.

### D-29 — Refuse across a version boundary; never downgrade silently

Two version surfaces, both of which refuse rather than adapt:

- **Local IPC** carries `RUNNER_IPC_PROTOCOL_VERSION` on every frame and a
  mismatch is refused by number (ADR-0008). That stays. A client one version
  ahead of a Runner does not "fall back".
- **The command schema** is versioned (`AGENT_COMMAND_SCHEMA_VERSION`,
  ADR-0006). A client that does not recognize the server's schema version may
  perform **reads**; it must refuse **writes** — anything that places, cancels,
  or alters an order or a job.

The supported window during beta is **the current minor and the one before
it**, for the published packages taken together: they release in lockstep at a
single version. Older than that is refused with a version in the error, not
best-effort compatibility. Beta means the contract may change between minors;
it does not mean a mismatch is handled quietly.

### D-30 — Nothing is reported home

**No package in this repository collects, transmits, or persists telemetry, and
none may be added without a new ADR.** There is no metrics endpoint, no crash
reporter, no usage ping, no update check. Today this is trivially true — there
is no such code — and the point of writing it down is that it stays true after
someone finds a reason.

If operational telemetry is ever wanted it is **opt-in**, off unless the
operator turns it on, and it may never carry natural-language prompts,
strategy parameters, addresses, order contents, tokens, signatures or any
value derived from a key. Local logs are not telemetry; they stay local, and
the existing rule that no secret is written to a log or an error body is
unchanged.

## What this forbids

- Any self-updating code path, update check, or "latest version" fetch in the
  CLI, the Runner or an adapter.
- Restarting a Runner with active jobs as a normal update step, or presenting
  `runner.shutdown` as a drain.
- Publishing any package without provenance, or with a stale or absent SBOM.
- Publishing from a developer machine. The release workflow is the only path,
  and it is manually dispatched.
- Guessing a licence for a dependency that declares none, or carrying a licence
  review forward to a version nobody reviewed.
- Making the CLI, Runner, adapters or MCP server public before backlog 1.11 has
  actually run and the drain path exists.
- Adding telemetry — including "anonymous" telemetry — without an ADR that
  supersedes this one.
- Silently accepting a write from a client whose schema version the server does
  not recognize.

## Consequences

- **The first wave is small, and the interesting parts are held back.** That is
  the intended cost: it is the honest reading of a runtime whose end-to-end path
  has never been exercised against a real server.
- Provenance requires a declared repository URL, and this workspace currently
  has no configured remote. The release preflight reports that as *unresolved*
  rather than passing over it, and `--strict` — the mode the release workflow
  runs — refuses. Nothing can publish until a human sets it.
- A lockstep version across published packages means a change in either forces a
  release of both. With two contract packages that ship together, a consumer
  reading one version number is worth more than independent versioning.
- No auto-update means a security fix reaches an installation only when its
  operator acts. Release notes therefore have to state severity plainly; there
  is no channel that can push a fix.
- No container image means a self-hosted operator supplies Node 24 for the
  Runner themselves (ADR-0002, ADR-0007). That was already true of the
  installation path this repository documents.
