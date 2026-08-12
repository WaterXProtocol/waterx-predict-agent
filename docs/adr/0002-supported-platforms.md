# ADR-0002 — Supported platforms and runtime

- Status: Accepted
- Date: 2026-08-12
- Plan ID: D-05
- Affects: `waterx-predict-agent-sdk`

## Context

The plan left the supported OS and runtime matrix undecided. The phrase "any
agent can install it" invites the reading that any platform works. That reading
is unsafe for a component that holds a signer and a durable job store: the two
places where platform differences actually bite are the OS keychain and SQLite's
file locking, and neither has been verified on Windows.

## Decision

The beta supports **Node.js 20+, ESM only**, on **macOS and Linux**.

- ESM only. No CommonJS build is published, and no dual-package interop is added
  to make one possible.
- Windows is **not supported and must not be claimed as supported** until it is
  verified. Verification means the signer provider, the SQLite/WAL job store
  including crash recovery, the Runner IPC transport, and the CLI's JSON output
  all pass on Windows in CI.
- Browser, Deno, and Bun compatibility are not promised. They may happen to work;
  that is not a supported claim and no work is spent preserving it.
- The runtime declares its platform support in `describe`, and the installer and
  README state it plainly rather than leaving it to inference.

Platform support is a claim about verified behavior, not about whether the code
plausibly runs.

## Consequences

- Windows users are an explicitly known gap in the beta. That is stated in the
  README limitations section rather than discovered at install time.
- Runner IPC may use a Unix domain socket without a Windows named-pipe fallback
  during the beta. Adding Windows later means implementing that fallback, not
  just testing.
- `engines.node` stays `>=20`. Node 18 is not supported: the runtime relies on
  stable global `fetch` and current `AbortSignal` behavior.
- Anything that would be trivial only on Windows is deferred rather than half
  built, so the codebase does not accumulate untested platform branches.
