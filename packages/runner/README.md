# @waterx/predict-agent-runner

The self-hosted local Runner. Private to this workspace; nothing here is
published, and the SDK does not depend on it (ADR-0001 §4).

**What exists today is the durable half, not the daemon.** This package can hold
a job's state safely across a crash. It cannot yet make a job progress on its
own.

| | status |
| --- | --- |
| SQLite/WAL job store behind a `JobStore` interface | implemented |
| Forward-only migrations, and refusal of a newer schema | implemented |
| Job state machine, with the transition audit log | implemented |
| Leases with fencing tokens, heartbeats, instance registry | implemented |
| Idempotency key persisted before any side effect | implemented |
| Side-effect ledger, and replay under the original key | implemented |
| Stream cursor persistence, monotonic | implemented |
| Crash recovery, including `UNKNOWN_PENDING` classification | implemented |
| Daemon process and authenticated local IPC | **not implemented** (backlog 2.6) |
| Executor that drives a job through the SDK | **not implemented** |
| Live reconciliation of `UNKNOWN_PENDING` against REST | **not implemented** |
| Signer inside the Runner trust boundary | **not implemented** (backlog 1.x) |

Until the daemon lands, synthetic limit orders still run in-process via the SDK's
`waitForPriceAndExecute` and die with the process — see `packages/sdk/README.md`.

## Requirements

**Node.js 24 or newer, for this package only.** The store uses `node:sqlite`
rather than a native binding, because this package holds the signer and a
postinstall script inside that process is a security surface, not just an install
cost. The published SDK and the CLI keep their Node 20 floor. ADR-0007 records the
trade and what it forbids.

macOS and Linux (ADR-0002). Windows is not supported and must not be claimed:
SQLite file locking there is unverified.

## The three properties everything else follows from

**Only evidence ends a job; absence of evidence ends nothing.** The store is
arranged so that "did anything leave this process?" is answered by a row on disk
rather than by a guess. A crash with an unresolved side-effect attempt lands the
job in `UNKNOWN_PENDING`, which has exactly one exit — a reconcile under the
*original* idempotency key. No recovery path ever mints a second intent for one
logical order.

**Persist before the side effect.** A state whose next act can create or submit an
order is unreachable until the leg and its idempotency key are committed; the
store raises `NO_IDEMPOTENCY_KEY` rather than trusting the caller to sequence it.
Resolving an attempt and recording the execution id it returned are one
transaction, because a crash between them would make a created order look like an
order that never happened.

**The fence, not the clock, decides who writes.** Every claim raises the job's
lease fence and every mutating call asserts `(instance, fence)`. A second Runner
on the same store cannot interleave writes with the first: whichever one was
superseded fails `LEASE_LOST` on its next call. An expired lease nobody reclaimed
keeps its fence, so its holder may still finish an order safely.

## Not a managed service

The Runner is local and self-hosted. The agent device and this process must stay
awake, online and running for a job to make progress. There is no managed-runner
promise, and a job whose Runner is down is a job nobody is watching —
`recoverJobs` reports those instances as stale rather than smoothing over it.

The signer will live inside this trust boundary. Models and ordinary agent
subprocesses never receive raw keys. The store enforces its share of that today:
it refuses to write secret-shaped fields at all rather than redacting them, and
it stores a SHA-256 digest of a request instead of the request bytes — enough to
prove a replay is byte-identical, and useless to whoever can read the file.

## Layout

```
src/state-machine.ts  the states, the legal edges, and why each one exists
src/store.ts          the JobStore interface — engine-free
src/sqlite/           the SQLite/WAL implementation and its migrations
src/recovery.ts       what a Runner does with the jobs it finds at start-up
src/secrets.ts        the refusal list applied at the store boundary
```

Tests use a real database file in a temporary directory, never `:memory:` — the
guarantees under test are about what survives a reopen.
