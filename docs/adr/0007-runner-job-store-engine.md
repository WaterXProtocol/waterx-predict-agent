# ADR-0007 — The Runner's job store engine, and the Node floor it costs

- Status: Accepted
- Date: 2026-08-17
- Refines: ADR-0001 §8 (durable local jobs use SQLite/WAL behind a store
  interface), ADR-0002 (supported platforms and runtime)
- Affects: `waterx-predict-agent-sdk` (`packages/runner` only)

## Context

ADR-0001 §8 decided *SQLite/WAL behind a store interface*. It did not decide
which SQLite binding, and the choice is not a matter of taste here: the Runner is
the process that holds the signer. Anything inside it is inside the trust
boundary of the keys, so its dependency surface is a security property rather
than an install-time inconvenience.

The realistic options were `better-sqlite3` (a native addon: a compiler or a
prebuilt binary, plus a postinstall script that runs on every install) and
`node:sqlite`, which ships with the runtime.

`node:sqlite` is usable without a flag from Node 23.4, and Node 24 is the LTS
line that carries it. The SDK's floor is `>=20` (ADR-0002), so choosing it means
the Runner's floor is higher than the SDK's.

## Decision

`packages/runner` uses **`node:sqlite`**, and declares **`engines.node: ">=24"`**
for that package only.

- The published SDK (`@waterx/predict-agent-sdk`) and the CLI keep `>=20`. A user
  who only installs the SDK is unaffected by this decision, and nothing in the
  SDK may import `node:sqlite` or `packages/runner`.
- The Runner takes **no runtime dependency outside the workspace**. A new one is
  a decision to widen the signer's trust boundary and needs its own ADR entry in
  the review, not a `pnpm add`.
- The floor is stated in `packages/runner/README.md` and asserted in
  `tests/workspace.test.ts`, so it is a checked fact rather than a comment that
  drifts.
- The `JobStore` interface stays engine-free. Nothing above it may import
  `node:sqlite` or depend on SQLite error text; a managed Runner on a different
  transactional database must be reachable without the daemon learning a second
  set of rules.

Three pragmas are part of the decision, not tuning:

- `journal_mode = WAL`, so a reader (`runner status`) never blocks the writer
  that is mid-order.
- `synchronous = FULL`. NORMAL may lose the last transactions after a power loss,
  and the last transaction here is routinely the idempotency key written
  immediately before the order that uses it. Losing exactly that row is the crash
  the store exists to survive, so the fsync is bought deliberately.
- `foreign_keys = ON`, so a side-effect attempt cannot outlive the leg whose
  idempotency key it claims to be replaying.

## What this forbids

- Adding a native SQLite binding to the Runner to recover the Node 20 floor.
  Lowering the floor is not worth a postinstall script inside the signer's
  process; if the floor must come down, the store implementation changes and this
  ADR is superseded.
- Setting `synchronous = NORMAL` for throughput. Nothing in this workload is
  write-bound; the fsync buys the one guarantee the store is for.
- Leaking the engine upward — SQLite types, SQLite error strings, or a
  `begin()`/`commit()` a caller could hold open across an `await`.

## Consequences

- `node:sqlite` is still marked experimental by Node on some releases in range, so
  a Node upgrade can change behaviour under us. The store's guarantees are covered
  by tests that close and reopen a real file, so a regression surfaces as a failed
  test rather than as a lost job.
- Windows remains unsupported (ADR-0002) and this ADR does not change that. SQLite
  file locking on Windows is one of the two reasons that decision exists.
- A managed Runner, if it is ever built, implements `JobStore` against its own
  database. The state machine, the lease fencing and the recovery rules are above
  that interface and are not reimplemented.
