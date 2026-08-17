# @waterx/predict-agent-runner

The self-hosted local Runner. Private to this workspace; nothing here is
published, and the SDK does not depend on it (ADR-0001 §4).

**There is now a process, and it still drives nothing.** The daemon starts,
recovers the jobs it finds, holds their leases and answers a local socket. What it
does not have is the executor that would turn a held lease into an order, so a job
sits in the state recovery left it in. `runner.status` reports this as
`driving: false` with the missing pieces named, and any real agent command sent
over the socket is refused `NOT_IMPLEMENTED` rather than answered.

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
| Daemon process, recovery at start-up, ordered shutdown | implemented |
| Authenticated local IPC over a Unix socket (ADR-0008) | implemented |
| Lease renewal and heartbeat supervision, with abort on loss | implemented |
| Executor that drives a job through the SDK | **not implemented** |
| Live reconciliation of `UNKNOWN_PENDING` against REST | **not implemented** |
| Price watcher feeding a job's trigger | **not implemented** |
| Signer inside the Runner trust boundary | **not implemented** (backlog 1.x) |
| Cursor persistence wired back into a live stream | **not implemented** (backlog 2.4) |

Synthetic limit orders therefore still run in-process via the SDK's
`waitForPriceAndExecute` and die with the process — see `packages/sdk/README.md`.
Starting `runnerd` does not change that yet.

## Requirements

**Node.js 24 or newer, for this package only.** The store uses `node:sqlite`
rather than a native binding, because this package holds the signer and a
postinstall script inside that process is a security surface, not just an install
cost. The published SDK and the CLI keep their Node 20 floor. ADR-0007 records the
trade and what it forbids.

macOS and Linux (ADR-0002). Windows is not supported and must not be claimed:
SQLite file locking there is unverified, and the IPC is a Unix domain socket with
no Windows fallback (ADR-0008).

## Running it

```
node packages/runner/dist/src/bin/runnerd.js
```

It runs in the foreground and does not daemonize. That is deliberate: a process
that detached itself would look like a strategy still running after the terminal
that owned it went away, and the whole point of ADR-0001 §6 is that a local Runner
makes no such promise. Backgrounding it, and keeping the device awake, are the
operator's decisions to make explicitly.

`WATERX_RUNNER_DIR` (default `~/.waterx/runner`) is the runtime directory;
`WATERX_RUNNER_STORE` overrides where the database lives. Start-up order is fixed:
assert the runtime directory, open the store, run recovery, *then* listen — so no
client can observe a Runner that has not yet decided what its jobs are. Diagnostics
go to stderr as one JSON object per line, never stdout, and never the token.

## Talking to it

`runner.sock` and `runner.token` are created inside the runtime directory at
`0600`. Authentication is the token; the isolation is the directory, which must be
`0700` and owned by this uid or the Runner refuses to start. ADR-0008 records why
that is the boundary and what it does not cover.

```ts
const client = await RunnerIpcClient.connect({
  socketPath: join(runtimeDir, 'runner.sock'),
  token: readIpcToken(join(runtimeDir, 'runner.token')),
});
const status = await client.request('runner.status');
```

`runner.status`, `runner.jobs`, `runner.job`, `runner.cancel-job` and
`runner.shutdown` are the whole surface. This socket is **not** a second command
surface: `runner.*` names are about this process, and an agent command from the
shared contract (`order.execute`, `market.quote`, …) is recognized and then refused
`NOT_IMPLEMENTED` naming the missing executor — because a client asking a connected
Runner to place an order must be told no loudly, rather than told the command is
unknown, which reads as a typo.

Two fields exist so a caller cannot mistake reachable for running: `driving` is
`false`, and `driverGaps` names what is absent. `runner.cancel-job` separates
`recorded` from `applied` for the same reason — only the lease holder may end a
job, and only from a state that has not started a write, so a cancel arriving
during a submit reports `pending: 'IN_FLIGHT'` rather than a stop that did not
happen.

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

`LeaseKeeper` turns that into something a job can be stopped by. It renews without
bumping the fence — bumping would invalidate the lease its own executor is holding
— and it aborts a job's `AbortSignal` in two cases: the lease was fenced out, or it
could not be renewed and is now inside the safety margin before expiry. The second
matters as much as the first, because a Runner that cannot reach its store also
cannot prove it still owns the job for longer than a request takes.

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
src/daemon.ts         start-up order, shutdown, and what the process admits to
src/supervisor.ts     lease renewal, heartbeat, and the two aborts they cause
src/ipc/              the socket: framing, auth, dispatch, and the client
src/bin/runnerd.ts    the process entry point
```

Tests use a real database file in a temporary directory, never `:memory:` — the
guarantees under test are about what survives a reopen.
