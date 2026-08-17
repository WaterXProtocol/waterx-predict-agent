# @waterx/predict-agent-runner

The self-hosted local Runner. Private to this workspace; nothing here is
published, and the SDK does not depend on it (ADR-0001 §4).

**There is now a process, a thing that moves a job, and a loop that calls it — and
what is still missing is what the loop needs to call it *with*.** The daemon
starts, recovers the jobs it finds, holds their leases and answers a local socket.
`driveJob` takes a held lease and walks one job one step: watch, pause, trigger,
quote, create, sign, submit, reconcile. `JobScheduler` claims runnable jobs and
calls it on a tick, one pass per job, never overlapping itself, and stops driving a
job the instant this instance is fenced out of it.

The scheduler needs three collaborators supplied together — a gateway, a
`PriceObserver` and a `StrategySigner` — and this package implements only the
first. So **whether a daemon drives is a decision, not a property of the build**:
an embedding application that supplies all three gets a Runner that takes a
strategy to a fill, and `runnerd`, which supplies none, starts no scheduler and
advances nothing. `runner.status` reports which one it is — `driving`, plus
`driverGaps` naming what is absent — and any real agent command sent over the
socket is refused `NOT_IMPLEMENTED` either way.

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
| `UNKNOWN_PENDING` resolved from an authoritative REST read | implemented |
| Strategy create / get / list / cancel / events over the store | implemented |
| Mandatory `expiresAt`, capped at seven days (ADR-0005) | implemented |
| Frozen-share percentage SELL, and the explicit dynamic mode | implemented |
| Market pause-vs-terminal classification (ADR-0004) | implemented |
| `driveJob`: one job, one pass, watch through reconcile | implemented |
| Fresh delegation / market / position / quote checks at trigger | implemented |
| Independent multi-leg execution under per-leg keys | implemented |
| Exactly one logical submission across a crash at any boundary | implemented, tested |
| Scheduler that calls `driveJob` on a schedule, inside the daemon | implemented |
| Price watcher supplying a `PriceObserver` from a live stream | **not implemented** (interface only) |
| Signer inside the Runner trust boundary | **not implemented** (interface only, backlog 1.x) |
| A driver `runnerd` can construct from local configuration | **not implemented** (backlog 2.6) |
| Cursor persistence wired back into a live stream | **not implemented** (backlog 2.4) |

Synthetic limit orders therefore still run in-process via the SDK's
`waitForPriceAndExecute` and die with the process — see `packages/sdk/README.md`.
Starting `runnerd` does not change that yet: it can construct no signer and no
price source, so it starts with no driver and reports `driving: false`.

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

Two fields exist so a caller cannot mistake reachable for running: `driving` says
whether a scheduler is ticking *in this process right now*, and `driverGaps` names
what is absent when it is not. Both are read from the scheduler rather than from
configuration, so a daemon that was told to drive but whose loop is stopped reports
`false`. `runner.cancel-job` separates
`recorded` from `applied` for the same reason — only the lease holder may end a
job, and only from a state that has not started a write, so a cancel arriving
during a submit reports `pending: 'IN_FLIGHT'` rather than a stop that did not
happen.

## Strategies

`StrategyService` is the command core — one implementation of what a strategy
*is*, so the CLI, the IPC surface and any adapter cannot drift into a second set
of rules about sizing, expiry or cancellation. `create` normalizes an intent and
writes a durable job in `DRAFT`. Whether anything then advances it depends on
whether *this* Runner was given a driver, which is why `create` returns the job's
state rather than a word like "armed". It is deliberately not exposed over the IPC
socket yet — advertising a strategy command from a process that may report
`driving: false` would claim execution that does not exist.

What it refuses is the interesting part. `normalizeStrategy` will not guess a
size, an expiry or a market:

- **`expiresAt` is mandatory and capped at seven days** (ADR-0005). A zoneless or
  locale-formatted instant is refused rather than parsed, because the host would
  be deciding what `01/02/2026` means. A request past the cap is refused with the
  latest instant that *would* have been allowed — never silently clamped, since a
  clamped expiry is a strategy that stops watching earlier than its owner asked.
- **A size is never inferred from the side.** Exactly one of `buyAmount`,
  `sellShares`, `sellFractionOfPosition` or `dynamicSellFractionOfPosition` may be
  present; zero of them is `SIZE_MISSING` and two is `SIZE_AMBIGUOUS`, listing
  what was given.
- **"Sell half" freezes at creation** (D-15). The fraction is resolved against a
  real position read into a concrete `sellShares`, and the position it was
  computed from is persisted alongside it. Truncation is toward zero, and a
  fraction that resolves to nothing is refused rather than submitted as a
  zero-size order. `dynamicSellFractionOfPosition` is the distinct, explicit mode
  that re-reads at trigger — and so performs no position read at creation.
- **Absence must be proven.** A position lookup pages until the server answers
  `nextCursor: null`. A server that simply stopped answering, a repeating cursor
  or a page bound produces `POSITION_LOOKUP_INCONCLUSIVE`, not "you hold none".
- **The watched market is derived, never assumed.** A price trigger takes market,
  outcome and side all-or-nothing; otherwise they come from the legs, and legs
  that disagree are refused with the distinct values rather than resolved by
  picking one.

`events(jobId)` merges the transition log with the side-effect ledger into one
ordered feed with stable ids. An attempt with no recorded outcome appears as a
`SIDE_EFFECT_BEGAN` event marked `unresolved` — it is the evidence that a request
may have left the process, and it does not become silence.

`classifyMarket` is ADR-0004 as a decision table, reading `status` and
`tradeable` and nothing else: `tradeabilityReason` is free text for people, and
pattern-matching it would make a copy edit on the server a control-flow change
here. Closed and resolved are terminal; not-tradeable pauses under the original
expiry; a status this build does not recognize pauses too, because ending a job
that could still have fired cannot be undone. `preflight` calls it on every
watching pass, so a market that halts at 3am is noticed then rather than at the
next restart.

## Driving one job

`driveJob({ store, gateway, signer, prices, lease, at })` advances a single job by
a single pass and returns what it did. It is a function, not a loop: the caller
owns scheduling, so a Runner, a test and a one-shot CLI invocation all get the
same semantics, and a pass that must not happen concurrently with itself is the
caller's lease to enforce.

A pass re-reads everything that could have changed while the job was armed, in
this order, before it writes anything:

1. **The local mandate**, then **delegation and effective limits** from the
   server. A permission the owner revoked ends the job. `mayPlaceOrder: null`
   means the chain read failed and pauses it — `null` is never read as "no". No
   mandate at all, a suspension, or any `blockers` entry pauses too, forwarded
   verbatim rather than re-interpreted.
2. **Every market involved** — the watched one and each leg's. Closed or resolved
   ends the whole job; anything else non-runnable pauses it under its *original*
   `expiresAt`, which is never extended, and its original market, which is never
   swapped.
3. **The position**, but only for a `DYNAMIC_FRACTION` leg, which is the explicit
   mode that asked for it. A frozen size is not re-derived. An unproven lookup
   pauses the job; a *proven* absence or mismatch skips only that leg.
4. **A fresh quote per leg**, re-verified against the trigger's target. An
   indicative bid that met the floor and an executable quote that does not is a
   re-arm, not a worse fill.

Then the legs execute as phases rather than a queue — all creates, all signs, all
submits — because sponsored bytes and signatures are never persisted (ADR-0001
§7), so create → sign → submit has to complete in one in-memory pass or start
over from evidence. Each leg carries its own idempotency key and its own ledger
row: one leg's refusal never rolls back a sibling's fill, and a job with one
filled leg and one rejected leg is `FILLED` with the detail on the legs.

The one thing a pass will not do is decide an outcome. A submit that returned
records a digest and nothing else; only `reconcileJob`, reading the server, may
call a leg `SUCCEEDED`. A request that got no answer leaves its attempt row open
and moves the job to `UNKNOWN_PENDING`, which stops the pass — including for legs
that had not been reached, because a chain whose earlier order is unresolved is
not a chain that should keep placing orders.

## The three properties everything else follows from

**Only evidence ends a job; absence of evidence ends nothing.** The store is
arranged so that "did anything leave this process?" is answered by a row on disk
rather than by a guess. A crash with an unresolved side-effect attempt lands the
job in `UNKNOWN_PENDING`, which has exactly one exit — a reconcile under the
*original* idempotency key. No recovery path ever mints a second intent for one
logical order.

`reconcileJob` is the implementation of that single exit. It reads the execution
over REST and admits only what the server reported — `FILLED`, `REJECTED` as
`FAILED`, `CANCELLED`, `EXPIRED` — while `SUBMITTED` and `PENDING_FILL` leave the
job in `RECONCILING` to be read again, because finalizing a live order on a clock
is the failure this whole path exists to avoid. An answer that settles nothing puts
the job back in `UNKNOWN_PENDING` rather than downgrading "I cannot tell" to
"nothing happened".

`driveJob` calls it at the end of every executing pass and on any pass that finds
a job already in `RECONCILING` or `UNKNOWN_PENDING`, and `JobScheduler` calls
`driveJob` on a tick — so in a daemon with a driver, a job left `RECONCILING`
keeps being read back until the server says something terminal.

One case it cannot resolve, and neither can anything else today: a crash *during*
the create leaves an idempotency key with no execution id, and this API has no read
from a key to an execution — no endpoint takes the key, and the execution summary
does not carry it. Replaying the create as a probe is not a substitute, because a
key that never landed would be *made* to land by the probe. So that job reports
`INCONCLUSIVE` and stays visible in `UNKNOWN_PENDING`. Backlog §6 carries the
backend dependency.

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
src/reconciler.ts     resolving UNKNOWN_PENDING from an authoritative REST read
src/secrets.ts        the refusal list applied at the store boundary
src/strategy/         normalization, the command core, and what they refuse
src/strategy/preflight.ts  what is re-read at the trigger, and pause vs stop
src/strategy/driver.ts     one job, one pass, and what a pass refuses to decide
src/daemon.ts         start-up order, shutdown, and what the process admits to
src/supervisor.ts     lease renewal, heartbeat, and the two aborts they cause
src/ipc/              the socket: framing, auth, dispatch, and the client
src/bin/runnerd.ts    the process entry point
```

Tests use a real database file in a temporary directory, never `:memory:` — the
guarantees under test are about what survives a reopen.
