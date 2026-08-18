# @waterx/predict-agent-runner

The self-hosted local Runner. Private to this workspace; nothing here is
published, and the SDK does not depend on it (ADR-0001 §4).

**There is now a process, a thing that moves a job, a loop that calls it, and a
configuration a shipped `runnerd` can build that loop's collaborators from.** The
daemon starts, recovers the jobs it finds, holds their leases and answers a local
socket. `driveJob` takes a held lease and walks one job one step: watch, pause,
trigger, quote, create, sign, submit, reconcile. `JobScheduler` claims runnable
jobs and calls it on a tick, one pass per job, never overlapping itself, and stops
driving a job the instant this instance is fenced out of it.

The scheduler needs three collaborators supplied together — a gateway, a
`PriceObserver` and a `StrategySigner`. `QuoteStreamPriceObserver` turns the SDK's
indicative quote stream into observed prices, and into silence whenever that feed
cannot prove it is live; `createExternalCommandSigner` signs sponsored bytes
through a keystore command that holds the key; and `resolveRunnerConfig` plus
`buildRunnerDriver` assemble all three from the environment and one JSON file, so
`runnerd` drives when it is configured to. **Whether a daemon drives is still a
decision rather than a property of the build**: the configuration is all-or-nothing
— a missing base URL, wallet or keystore command yields *no* driver and names what
is absent, rather than a half-driver that could create an order it cannot sign.
`runner.status` reports which one it is — `driving`, `driverGaps`, and a per-topic
`prices` block — and any real agent command sent over the socket is still refused
`NOT_IMPLEMENTED` either way.

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
| Drain: refuse admission, settle in-flight work, report the deadline | implemented, tested |
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
| A leg a crash left unsent, finished under the key already on disk | implemented, tested |
| One order across a restart of the daemon itself, not just of a pass | implemented, tested |
| Scheduler that calls `driveJob` on a schedule, inside the daemon | implemented |
| `PriceObserver` over the SDK's indicative quote stream | implemented |
| Signer inside the Runner trust boundary, over an external command | implemented |
| Refusal to sign for an `interactive` or `read-only` job, before spawning | implemented, tested |
| A driver `runnerd` builds from local configuration, or refuses to | implemented, tested |
| Per-topic price-feed health in `runner.status` | implemented, tested |
| `strategy.create` / `get` / `list` / `cancel` / `events` on the socket | implemented, tested |
| The mandate a socket-created job is admitted under, from local configuration | implemented, tested |
| `waterx-predict strategy …` against this socket | implemented, tested |
| Keystore-file, OS-keychain and KMS signer providers | **not implemented** (backlog 1.8) |
| Starting, stopping or supervising this daemon from the CLI | **not implemented** (backlog 2.6) |
| Cursor persistence wired back into a live stream | **not applicable here** (backlog 2.4) |

Synthetic limit orders still run in-process via the SDK's `waitForPriceAndExecute`
and die with the process — see `packages/sdk/README.md`. A configured `runnerd` is
the durable alternative, a strategy reaches it over the socket, and the CLI's
`strategy` family now speaks that protocol: `waterx-predict strategy list` talks
to whatever `runnerd` is listening in the runtime directory. The CLI does not
depend on this package to do it — it carries its own copy of `RUNNER_IPC_PROTOCOL`,
and `tests/workspace.test.ts` holds the two equal and runs the CLI's real frames
through this package's `decodeClientFrame`.

What is still **not implemented** is the daemon's *lifecycle* from the CLI
(backlog 2.6): nothing there starts, stops or supervises a `runnerd`. An operator
runs the binary, and the device has to stay awake and online for any job to
progress.

The stream-cursor row deserves its wording. The store persists cursors and the
recovery path reads them, but there is nothing in this process to hand one back
to: the Runner reads indicative quotes, whose recovery *is* the snapshot — a
`SocketQuoteStream`'s `seq` is per connection and per topic, so a reconnect starts
a new sequence rather than resuming an old one — and it deliberately does not open
the *execution* stream at all, because a terminal state is confirmed by an
authoritative REST read (`getExecution`), never by a frame. Backlog 2.4 is real,
but it belongs to a consumer of the execution stream, which this package is not.

### What the price observer will and will not say

`QuoteStreamPriceObserver` answers a `PriceObserver` from the SDK's indicative
quote stream. It returns `null` — "nothing was observed", which the executor
treats as a pass with no opinion — the moment the feed can no longer prove it is
live: a stale frame, a gap it cannot fill, a dropped connection, a stream that
gave up, a topic the server refused. It never ages a remembered number into an
answer.

It also **never falls back to `POST /quotes`**, which is where it differs from
the SDK's `QuoteStreamPriceWatcher`. A `WatchKey` carries a market, an outcome
and a side and deliberately no size; `POST /quotes` requires one. Falling back
would mean inventing a probe size and minting a priced, executable artifact
merely to read a number. It waits instead, which costs a tick.

Subscriptions expire by disuse rather than by being told a job ended: a topic
nobody has asked about for `idleMs` (five minutes by default) is released on the
next `observe`. Nothing has to remember to tell it, so no cancellation, expiry,
lost lease or crash leaks a subscription. `topics()` reports what is held and why
a topic is quiet — `DEGRADED` in particular means the stream has given up for the
life of the process, so that topic will answer `null` forever without erroring.

### The signer, and the two refusals that are features

`createExternalCommandSigner({ command, agentWallet, run })` is the `StrategySigner`
a driver is given. It writes one versioned JSON request to a child process's stdin
and reads `{"signature":"<base64>"}` from its stdout, so the key stays inside
whatever holds it — a keystore agent, a KMS shim, an HSM wrapper (ADR-0001 §6).
This is the same wire the CLI speaks (`packages/cli/src/signer.ts`), and
`tests/workspace.test.ts` asserts the two descriptions of it are equal, so an
operator who configured one keystore command can point the other at it unchanged.
Unlike the CLI's signer, this one only ever emits `TRANSACTION`: an unattended
process has no login challenge to sign.

**A job whose policy is `interactive` is refused, and so is `read-only`.** Not
skipped, not queued for approval — refused, before any child process is started.
Read-only is the obvious case. Interactive is the one worth stating: a durable
strategy fires at whatever moment the market reaches its target, which is
precisely a moment nobody is present to approve, and accepting it here would make
the explicit scope of `delegated-auto` evadable by wrapping any order in a
strategy whose trigger is already met. Only `delegated-auto` signs. A mode this
build does not recognize is also refused — and *paused* rather than ended at the
job level, because the build that understands it may be the next one to start.

The same rule is applied in three places, each catching what the others cannot:
`normalizeStrategy` refuses at creation, so an owner learns at the prompt rather
than hours later; `checkLocalPolicy` refuses before a pass reads anything at all,
so an unsignable job never watches a market or reserves allowance; and the signer
refuses before it spawns, so a path that skipped both still cannot produce a
signature. The scope's `notAfter` is re-read at signing time as well as at the top
of the pass — a pass makes network calls in between, and a mandate can run out
while it does.

A refusal after an execution exists is reported, never rewritten: the leg carries
`signRefusedCode`, the job moves to `RECONCILING` with the unsigned legs named,
and only the reconciler — reading the server — may say what became of the
execution. Nothing here logs a signature, the transaction bytes, or the child's
stdout; the child's *stderr* is forwarded to an `onDiagnostic` callback for an
operator, and never enters a stored record.

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

Start-up order is fixed: resolve the configuration, assert the runtime directory,
open the store, run recovery, *then* listen — so no client can observe a Runner
that has not yet decided what its jobs are. Diagnostics go to stderr as one JSON
object per line, never stdout, and never a token, a signature or transaction bytes.
The first line is the resolved configuration, in which the keystore appears by
**base name only**: a full argv can carry a path that identifies the operator or a
hardware-token slot, and that line is what a service manager archives.

### Configuring it

Environment first, then `runner.json` in the runtime directory. There are no
flags: a process that runs for days should be configured by a document an operator
can read back, not by an argv nobody can recover after the terminal is gone.

| env | `runner.json` | |
| --- | --- | --- |
| `WATERX_RUNNER_DIR` | — | runtime directory (default `~/.waterx/runner`) |
| `WATERX_RUNNER_STORE` | — | database path (default `<dir>/jobs.sqlite`) |
| `WATERX_RUNNER_CONFIG` | — | the file itself (default `<dir>/runner.json`) |
| `WATERX_RUNNER_BASE_URL` | `baseUrl` | the API this Runner trades against |
| `WATERX_RUNNER_AGENT_WALLET` | `agentWallet` | the address it trades as |
| `WATERX_RUNNER_SIGNER_COMMAND` | `signerCommand` | the keystore **argv** |
| `WATERX_RUNNER_SIGNER_TIMEOUT_MS` | `signerTimeoutMs` | default 15000 |
| `WATERX_RUNNER_TICK_INTERVAL_MS` | `tickIntervalMs` | scheduler cadence |
| `WATERX_RUNNER_MAX_JOBS` | `maxJobs` | jobs claimed per tick |
| `WATERX_RUNNER_POLICY_MODE` | `policy.mode` | the mandate; default `interactive` |
| — | `policy.maxOrderNotional` | a decimal **string**, recorded per job |
| — | `policy.notAfter` | when the mandate itself ends |

```json
{ "baseUrl": "https://predict.example/api",
  "agentWallet": "0x…",
  "signerCommand": ["/opt/keystore/bin/waterx-sign", "--slot", "3"],
  "policy": { "mode": "delegated-auto", "maxOrderNotional": "250.000000" } }
```

**The mandate is configuration, never a request.** `strategy.create` has no
`policy` field at all, and a peer that sent one is refused: a socket client able
to name its own mode would be granting itself the authority to sign while nobody
is watching. The default is `interactive`, which is the mode a durable strategy is
*refused* under — so a Runner nobody has finished configuring answers, recovers
and arms nothing, rather than signing. A mode this build does not recognize is
refused at start-up rather than at the first trigger. The caps are file-only, on
purpose: a ceiling is the part an operator should be able to read back afterwards,
and an environment variable nobody can inspect later is not a reviewable mandate.
`maxRunNotional` is deliberately not a setting — nothing in this build enforces
one, and a limit an operator believes is in force while it is not is worse than
its absence.

The signer command is argv and is never run through a shell, so a bare executable
name is fine and anything with arguments must be an array — splitting on spaces
would break the first path containing one and quietly change which program runs.
An unknown key in the file is a refusal rather than a warning, and so is a
credential-shaped key at any depth, named by its path and never by its value.

**There is no token setting, from anywhere.** Not in the file, not in the
environment. A seven-day mandate outlives any token it could have been handed, so
the Runner authenticates itself through the same keystore command and
re-authenticates when the server rejects one — which is the path that keeps a
logical write's idempotency key and exact bytes intact across an expiry
mid-order. The session is opened lazily on first use, not at boot, so a Runner
restarted while the API is down still starts, still recovers its jobs, and
authenticates when the server comes back.

The three driver settings are all-or-nothing. Missing any of them, `runnerd`
starts, recovers, listens and reports `driving: false` with `driverGaps` naming
exactly what to set (`base-url`, `agent-wallet`, `signer-command`). A `baseUrl`
using plaintext `http://` to anything but loopback warns rather than refuses — a
local mock is legitimate — and the warning is printed once, at start-up.

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

`runner.status`, `runner.jobs`, `runner.job`, `runner.cancel-job`,
`runner.drain`, `runner.shutdown` and the five `strategy.*` commands are the
whole surface. This
socket is **not** a second command surface: `runner.*` names are about this
process, `strategy.*` names are about the durable jobs it owns, and an agent
command from the shared contract (`order.execute`, `market.quote`, …) is
recognized and then refused `NOT_IMPLEMENTED` naming the missing executor —
because a client asking a connected Runner to place an order must be told no
loudly, rather than told the command is unknown, which reads as a typo.

## Upgrading a Runner that is holding jobs

`runner.shutdown` is a clean stop, not a drain: it closes the socket and awaits
the scheduler pass in flight, so it will not abandon a half-finished
create/sign/submit — but it refuses no new work first. `runner.drain` is the
step before it.

```ts
const report = await client.request('runner.drain', { deadlineMs: 30_000 });
if (!report.settled) {
  // `report.settling` names each open attempt: job, leg and kind. Stopping now
  // leaves them UNKNOWN_PENDING for the next Runner to reconcile. That is a
  // legitimate choice; it should be a choice.
}
await client.request('runner.shutdown', { reason: 'UPGRADE' });
```

Draining closes admission at both doors at once — a `strategy.create` on the
socket is refused `RUNNER_DRAINING` and no job is written, and the scheduler
stops claiming from the store — while every job this Runner already holds keeps
getting passes.

What it waits for is **this instance's open side-effect attempts**, not merely
non-terminal jobs. A watching strategy with a seven-day expiry is *safely
resumable* right now: the store has everything and the next Runner adopts it, so
waiting for it would make every drain end on its deadline. An open attempt is a
request that may have reached the server with nobody having seen the answer, and
that is the thing worth staying alive for. Attempts inherited from a previous
instance are reported as `inherited` and never waited on, because staying alive
cannot settle them.

A drain never exits by itself, and admission never reopens. Both are deliberate:
see `src/drain.ts`.

The `strategy.*` handlers delegate to the same `StrategyService` an embedding
application gets from `daemon.strategies`. The socket therefore has no sizing
rule, no expiry cap and no cancellation rule of its own, and the refusals a client
reads are the named ones — `EXPIRY_REQUIRED`, `EXPIRY_TOO_FAR`, `SIZE_AMBIGUOUS`,
`POSITION_READ_UNAVAILABLE`, `POLICY_REQUIRES_DELEGATION` — rather than a schema
violation. `strategy.create` answers with `driving` and `driverGaps` beside the
job it wrote, because on an unconfigured Runner that job is real, durable, and
never going to move. `strategy.cancel` is `runner.cancel-job` under the other
name and the same implementation.

Two fields exist so a caller cannot mistake reachable for running: `driving` says
whether a scheduler is ticking *in this process right now*, and `driverGaps` names
what is absent when it is not. Both are read from the scheduler rather than from
configuration, so a daemon that was told to drive but whose loop is stopped reports
`false`.

A third exists so a caller cannot mistake running for *watching*. `prices` is
`null` when nothing observes prices at all, and otherwise counts the topics held,
how many are `degraded`, and how many are `silent` — subscribed, but nothing has
ever been observed on them — with a row per topic. `degraded` is the one worth
alerting on: it means the stream gave up for the life of the process, so those
topics will answer "nothing observed" forever without ever erroring, and a
strategy waiting on one is indistinguishable from a strategy waiting on a quiet
market unless something says so.

`runner.cancel-job` separates
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
state rather than a word like "armed". It is reachable two ways — `daemon.strategies`
in-process, and `strategy.*` on the socket — and they are the same object, so
there is nowhere for a second rule to live. What is still missing is a command:
no CLI speaks this protocol yet (backlog 2.8).

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

There is exactly one absence that *does* prove something, and it is about local
disk rather than about the server: an attempt row is committed **before** the
request that uses it, so a leg with no attempt row of any kind — open, failed or
abandoned — is a leg nothing was ever sent for. The reconciler checks that first,
ahead of reading executions that already exist, because this leg's create needs a
fresh quote and a quote is the one input that decays. Two answers follow. If no
leg of the job was ever sent, the job goes back to `WATCHING` with every key kept,
and re-observes its trigger from scratch. If a sibling's request did leave the
process, the job stays in `RECONCILING` and `driveJob` finishes the run: fresh
authorization, market, position and quote checks, then a create under the key that
was minted before the crash. That resume can never end the job — an order exists
on the server, so a refusal, or the job's own `expiresAt` passing, marks the unsent
legs `SKIPPED` and leaves the verdict to the read.

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

The signer lives inside this trust boundary, and only as a child process holding
its own key: models and ordinary agent subprocesses never receive raw keys, and
neither does this process. The store enforces its share of that too:
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
src/signer.ts         the trust boundary: the keystore protocol and who may sign
src/strategy/         normalization, the command core, and what they refuse
src/strategy/preflight.ts  what is re-read at the trigger, and pause vs stop
src/strategy/driver.ts     one job, one pass, and what a pass refuses to decide
src/daemon.ts         start-up order, shutdown, and what the process admits to
src/drain.ts          refusing admission, and what is worth staying alive for
src/supervisor.ts     lease renewal, heartbeat, and the two aborts they cause
src/ipc/              the socket: framing, auth, dispatch, and the client
src/config.ts         what an operator sets, and what this process will not hold
src/runtime.ts        the only place a SchedulerDriver is constructed
src/bin/runnerd.ts    the process entry point
```

Tests use a real database file in a temporary directory, never `:memory:` — the
guarantees under test are about what survives a reopen.
