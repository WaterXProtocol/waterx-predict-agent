# packages/runner — `@waterx/predict-agent-runner`

SQLite/WAL job store, state machine, lease fencing, crash recovery,
`UNKNOWN_PENDING` reconciliation, a daemon with authenticated local IPC
(ADR-0008) and lease supervision, the one-job/one-pass `driveJob`, the scheduler
that calls it on a tick, a price observer over the SDK's indicative quote
stream, a signer inside the trust boundary, and the local configuration
`runnerd` builds all three from — so a configured process reports
`driving: true` and an unconfigured one reports `false` with `driverGaps` naming
what to set. `private`, Node 24 floor (ADR-0007); CI's `floor` job therefore
excludes this package from the Node 20 run.

`strategy.create` / `get` / `list` / `cancel` / `events` are served over the
local socket by the same `StrategyService` an embedder holds, under a mandate
resolved from **local configuration and never from the request**, and the CLI
reaches them over that socket (backlog 2.8). `runner.drain` (backlog 2.14) is
the first step of an upgrade: it refuses new admission at both the socket and
the store while held jobs keep getting passes, waits on **this instance's**
open side-effect attempts — not on merely non-terminal jobs, which are safely
resumable — and reports an exceeded deadline rather than crossing it. It never
exits; `runner.shutdown` is step two and remains a clean stop, not a drain.

Trades in direct mode by default (ADR-0016): `src/runtime.ts` builds a
`PredictDirectClient` gateway that never signs, preflight checks the on-chain
delegation only (`mandate: 'NONE'`), and prices are polled.

## Layout

- `src/state-machine.ts` — the states, the legal edges, and the reason each one
  exists. Three properties are load-bearing: no local cancel or expiry once a
  write may have started, `UNKNOWN_PENDING` has exactly one exit (a reconcile
  under the original key), and a side-effect state is unreachable before the
  idempotency key is on disk.
- `src/store.ts` — the engine-free `JobStore` interface. Every method is exactly
  one transaction and none is exposed, so a half-applied "persist the key, then
  mark the state" is unrepresentable. Every mutating job method takes a lease.
- `src/sqlite/` — the SQLite/WAL implementation and its forward-only migrations.
  `synchronous = FULL` is deliberate; a newer schema is refused outright.
- `src/recovery.ts` — what a Runner does with the jobs it finds at start-up. Its
  rule is *only evidence ends a job; absence of evidence ends nothing.*
- `src/reconciler.ts` — the other half of that rule: recovery decides *that* a job
  is unresolved, `reconcileJob` decides *what happened*, and only from an
  authoritative REST read. A non-terminal execution is left alone rather than
  finalized on a clock, and a create with no execution id reports `INCONCLUSIVE`
  because no API read maps an idempotency key to an execution. The one absence it
  *does* read as proof is a leg with no attempt row at all — the row is committed
  before the request — which either re-arms the whole job (nothing ever left the
  process) or lets `driveJob` finish a half-sent run under the key already on disk.
  `driveJob` calls it at the end of every executing pass, and `JobScheduler` calls
  `driveJob` on a tick, so in a configured daemon a `RECONCILING` job is read back
  until the server says something terminal.
- `src/secrets.ts` — refusal, not redaction, at the store boundary: a
  secret-shaped field is rejected rather than written and masked.
- `src/daemon.ts` — the process. Start-up order is load-bearing: assert the
  runtime directory, open the store, recover, *then* listen, so no client can
  observe a Runner that has not yet decided what its jobs are. `driving` and a
  named `driverGaps` list are in every status reply, read from whether a scheduler
  is actually ticking rather than from configuration, because a reachable Runner is
  not a running strategy (ADR-0001 §6). So is a per-topic `prices` block: a
  `DEGRADED` feed answers "nothing observed" forever and must not read as a quiet
  market.
- `src/config.ts` — what an operator sets (environment, then one JSON file; no
  flags) and what this process refuses to hold: no key material, and **no session
  token from anywhere**, because a seven-day mandate outlives any token. The three
  driver settings are all-or-nothing — a partial driver would create an order it
  cannot sign — and a credential-shaped key is refused by path, never by value.
  The `policy` block is the mandate a socket-created strategy is admitted under;
  it is configuration precisely so no request can name one, and its default,
  `interactive`, is the mode a durable strategy is refused under.
- `src/runtime.ts` — the only place a `SchedulerDriver` is constructed. One client,
  its own quote stream so REST and WS share a session, two signers over one
  keystore command where the authentication one throws on `signTransaction`, and a
  session opened lazily so a Runner still starts while the API is down.
- `src/supervisor.ts` — `LeaseKeeper`. Renews without bumping the fence, and
  aborts a job's signal both when the lease was fenced out and when it could not
  be renewed inside the safety margin before expiry.
- `src/ipc/` — the local socket (ADR-0008). `runtime-dir.ts` is the security
  boundary: a `0700` uid-owned directory, asserted rather than repaired, plus a
  reminted `0600` bearer token. `commands.ts` refuses a real agent command with
  `NOT_IMPLEMENTED` naming the missing executor rather than letting it read as a
  typo. This socket is not a second command surface: its `strategy.*` schemas
  describe shape only and every sizing, expiry and cancellation *rule* stays in
  `src/strategy/`, so a client is refused by name (`SIZE_AMBIGUOUS`,
  `EXPIRY_REQUIRED`) rather than by an anonymous schema violation.
- `src/bin/runnerd.ts` — the entry point. Foreground only; it does not
  daemonize, and it writes diagnostics to stderr, never the token, the signature,
  the transaction bytes or the keystore argv (the executable appears by base name).
  It builds a driver or refuses to build a partial one, and starts either way.
