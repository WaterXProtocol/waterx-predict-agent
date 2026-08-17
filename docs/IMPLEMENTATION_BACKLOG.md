# Implementation backlog

Derived from `docs/AGENT_INSTALLATION_AND_RUNTIME_PLAN.md` and constrained by
`docs/adr/`. This file is the only place that tracks what is **actually
implemented**. The plan describes the intended system; an ADR constrains how it
gets built; neither is evidence that anything works.

- Verified: 2026-08-17
- SDK: `codex/waterx-predict-agent-runtime` @ `4761de7` plus this commit
- Backend: `codex/waterx-predict-agent-runtime` @ `2aedb8d8` — unchanged by this
  SDK commit, and **correctly so**: the durable job store is entirely local. No
  wire surface is touched, no endpoint is added, and the backend stores no job,
  no target and no conditional order (ADR-0001 §7). There is no paired backend
  commit for this one. See the Contract sync section.
- SDK verification: `pnpm typecheck` clean, `pnpm test` 526/526 in 30 files
  (150 SDK, 71 schema, 149 CLI, 69 Runner, 59 E2E harness, 28 workspace),
  `pnpm build` clean, `pnpm schema:generate` reproduces the committed artifact
  byte-for-byte. The Runner suite runs against real SQLite files in a temporary
  directory that are closed and reopened; it opens no socket and spawns no
  process.
- **No end-to-end run against a live server has happened.** Nothing on this
  machine is provisioned — no `WATERX_PREDICT_*` variable, no config file — so
  the E2E harness (1.11) reports PARTIAL with one step passed and twelve NOT
  RUN. Those 59 harness tests are tests **of the harness**; they are not
  evidence that the runtime works against a server.

The repository is a pnpm workspace. `packages/sdk` is the SDK this file tracked
before the split; `packages/cli` now holds discovery, `doctor`, the market and
account read plane, **and the market-order write plane** — preview, execute,
execute-many, get and reconcile, behind an enforced execution policy;
`packages/runner` now holds the job store, the state machine, lease fencing, crash
recovery **and a daemon** — a process that recovers at start-up, supervises the
leases it holds and answers an authenticated local socket — and `packages/mcp` is
still a reserved boundary with **no implementation**. `packages/e2e` is a test
harness that drives the installed CLI; it ships to nobody, and a green harness
suite is not a green end-to-end.

What the CLI writes, it writes one order at a time from a one-shot process. There
is a daemon now, and there is now also a **job driver** — `driveJob` advances one
claimed job by one pass, from watching through the fresh trigger-time checks to
independent multi-leg create/sign/submit and reconcile, and its exactly-one-
submission property is tested against a real database killed at each side-effect
boundary — and there is now a **loop**: `JobScheduler` claims runnable jobs and
calls `driveJob` on a tick, never overlapping itself, dropping a job the instant
this instance is fenced out of it, and carrying on past a job whose pass threw.

Both of the things the loop must be handed now exist as well.
`QuoteStreamPriceObserver` answers a `PriceObserver` from the SDK's indicative
quote stream and, crucially, answers *nothing* rather than a remembered number
whenever that feed cannot prove it is live. `createExternalCommandSigner` is the
signer inside the trust boundary: it signs sponsored bytes through a keystore
command that holds the key, only for a job admitted under a `delegated-auto`
policy, and refuses `interactive` and `read-only` **before** it spawns anything.
What is still missing is the local *configuration* from which `runnerd` could
build a driver — an observer over no stream is not a price source, and a signer
with no configured command is not a signer. So whether a daemon drives
is now a decision its caller makes rather than a fact about the build — an
embedding application that supplies all three gets a Runner that takes a strategy
to a fill, and the shipped `runnerd`, which can supply none, starts no scheduler
and advances nothing. The daemon reports which it is (`driving`, plus
`driverGaps`), and any real agent command sent to its socket is refused either
way. A strategy that must outlive the invocation remains 2.6–2.8, and **no part
of this build should be read as a strategy running unattended**.

## Status vocabulary

| Marker | Meaning |
| --- | --- |
| **DONE** | Public path and its failure/recovery behavior work, with tests. |
| **PARTIAL** | Works for a stated subset; the gap is named. Never report as done. |
| **SEAM** | An interface exists; no implementation ships. Not a capability. |
| **TODO** | Not started. |
| **BLOCKED** | Needs a backend capability or an undecided product question. |

A **SEAM** must never be described to a user as support for the thing it is a
seam for. The SDK has two, and both are correctly disclosed in
`packages/sdk/README.md`.

## Contract sync

`packages/sdk/src/contract.ts` and
`bucket-backend-mono/apps/waterx/src/predict/agent-api/agent-api.contract.ts`
were diffed in full at SDK `HEAD` and backend `2aedb8d8`. Below the file header
(SDK lines 1–28, backend lines 1–22, which differ only in the vendoring notice)
they are byte-identical. No drift.

**This commit changes no wire surface.** The durable job store is local by
decision, not by omission: the backend stores no job, no target and no
conditional order (ADR-0001 §7), so a durable strategy is a client-side fact and
there is nothing for the server to learn about it. Nothing under `packages/runner`
issues a request today, and `packages/sdk/src/contract.ts` is untouched.

**The backend moved first again, for B3.** The quote stream (backend `2aedb8d8`)
adds `PREDICT_QUOTE_*` events, `PredictQuoteTopic`,
`PredictQuoteSubscribeMessage`, `PredictQuoteSubscriptionFrame`,
`PredictQuoteRejection(Reason)`, `PredictQuoteFreshness`,
`PredictQuoteStreamFrame` and `PredictQuoteHeartbeatFrame`, and widens
`PredictQuoteQualityFlag` with `INDICATIVE_ONLY`, `POLLED_UPSTREAM` and `STALE`.
The full semantic diff is **one** replaced line — that union — plus additions;
nothing was removed, renamed or retyped, and the union already carried a
`(string & {})` escape, so a client built against the previous contract still
compiles and still parses every response. As of this commit the SDK **consumes**
it: `packages/sdk/src/quote-stream.ts` speaks the protocol against these vendored
types, so the compiler is what catches the next drift (2.3).

**The backend moved first, three times.** B1 and B2 could not be closed on the
client side — one needs a text index the catalog endpoint did not expose, the
other needs a risk profile that only an owner-authenticated controller could
read — so the wire surface changed at `7ecad3f3` (`?search=` plus
`ListMarketsResponseBody.resolution`; `GET
accounts/:accountId/effective-limits`). B6 followed at `2e247fc4`
(`PredictAgentListQuery.cursor` on the three account reads, `nextCursor` on their
response bodies), because paging is a property of the query the database runs and
no client can synthesise it. Each time the complete contract body was re-vendored
here in one commit alongside the SDK method, the CLI commands, the schema entries
and the tests. Every change is purely **additive**: no field was removed, renamed
or retyped, so a client built against the previous contract still compiles and
still parses every response.

`nextCursor` is declared **optional**, which is the whole reason a client can tell
an old server from an exhausted history. If it were `string | null` a server that
never wrote the key would deserialise as `undefined` and read as "no more pages",
and a caller reconstructing its full history would stop early while reporting
itself complete. Absent means unknown; `null` means proven exhausted.

The write plane did not change this. It composes `createOrder` → sign →
`submitOrder`, `executeMany`, `getExecution` and `waitForExecution` exactly as the
SDK already implemented them; the approval token, the delegation scope and the
signing gate are **local** constructs that never appear on the wire.

## 1. Current SDK state — verified

| Capability | Status | Evidence |
| --- | --- | --- |
| Personal-message auth + token handling | DONE | `packages/sdk/src/client.ts:289`, `packages/sdk/src/signer.ts` |
| Bounded automatic re-authentication | DONE | `packages/sdk/src/session.ts`, `packages/sdk/src/transport.ts:89`, `packages/sdk/tests/reauthentication.test.ts` (14). Single-flight mint, compare-and-swap token replacement, one retry per request, `401 UNAUTHENTICATED` only, replay keeps exact bytes and key. |
| Executable quote | DONE | `packages/sdk/src/client.ts:314` |
| Market catalog list + get | DONE | `packages/sdk/src/client.ts:658`, `packages/sdk/src/client.ts:710` |
| Protected market order (create → sign → submit) | DONE | `packages/sdk/src/client.ts:339` |
| Terminal wait + REST reconciliation | DONE | `packages/sdk/src/client.ts:733` (public `waitForExecution`), `packages/sdk/tests/client.test.ts` |
| Terminal facts: fill, fee availability, remaining allowance | DONE | `packages/sdk/src/execution-facts.ts`, `packages/sdk/tests/terminal-result.test.ts` (14). Timeout returns `timedOut: true` with the execution id instead of throwing; absent fee is a reason, never zero; allowance is `undefined` off a non-terminal read and for an agent with no risk profile. |
| Stable idempotency across retries | DONE | `packages/sdk/tests/client.test.ts` |
| Server-driven retry policy | DONE | `packages/sdk/src/transport.ts`, `packages/sdk/src/errors.ts` |
| Exact decimal comparison | DONE | `packages/sdk/src/decimal.ts`, `packages/sdk/tests/wait-for-price.test.ts` |
| `executeMany` independent legs + STOP/CONTINUE | DONE | `packages/sdk/src/client.ts:388` |
| Allowance / positions / executions / fills reads | DONE | `packages/sdk/src/client.ts:554`–`:657`. The three history reads take `{ limit?, cursor? }` and return `nextCursor` (B6). |
| Keyset paging over account history | DONE | `packages/sdk/src/pagination.ts`, backend `2e247fc4`. Opaque row-anchored cursor over `(created_at, id)` for executions, `(filled_at, id)` for fills, `(created_at, id)` for positions, so a page boundary holds while new rows land at the head. `hasMorePages` is three-valued — `true` / `false` / `null` for "the server did not say" — and `isExhausted` is true only on an explicit `null` cursor, which the server proves by reading one row past the page. A malformed, edited, foreign-list or unowned cursor is refused as `INVALID_INPUT`, never ignored (B6). |
| `waitForPriceAndExecute` in-process trigger | PARTIAL | `packages/sdk/src/client.ts:444`. Correct trigger, fresh re-quote, re-verify, one submission — and that holds whether the trigger came from a poll or from a streamed frame. Still in-process only: it dies with the process, and is not durable. |
| Execution stream | DONE | `packages/sdk/src/execution-stream.ts`, `packages/sdk/tests/socket-execution-stream.test.ts` (35) + `execution-stream.test.ts` (13). `executionStream: 'native'` opens the official `socket.io-client` on the server's private namespace with the client's own session; the `ExecutionStream` seam remains for tests and custom transports. The default path still polls, and terminal state is **always** REST-confirmed — see 2.2/2.4. |
| Quote stream | DONE | `packages/sdk/src/quote-stream.ts`, `packages/sdk/tests/quote-stream.test.ts` (19) + `quote-stream-trigger.test.ts` (9). `quoteStream: 'native'` opens the official `socket.io-client` on the server's private namespace with the client's own session (`forceNew`, so it never multiplexes onto the execution stream's socket); the `QuoteStream` and `PriceWatcher` seams remain for tests and custom transports. Reconnect re-subscribes with `resume: true` and treats the `gap: true` snapshot as the whole recovery, `seq` is per (connection, topic) and never persisted, a heartbeat watchdog invalidates cached prices and rebuilds a silent connection, and everything else — no frame yet, `stale`, gap, rejection, degraded — falls back to `POST /quotes`. The trigger is still only a trigger: the order is priced off a fresh executable quote and re-checked against the target before submission. Default remains polling. |
| Server-side market resolution | DONE | `packages/sdk/src/client.ts` (`searchMarkets`), backend `7ecad3f3`. `?search=` matches published aliases server-side and returns `resolution` (`RESOLVED` / `AMBIGUOUS` / `NOT_FOUND`); `marketId` is non-null only on exactly one match, and `matchCount` is counted before `limit` truncates the page. A server that answers without a `resolution` reads as `NOT_FOUND` — the client withholds an id rather than inferring one (B2). |
| Agent-readable effective risk limits | DONE | `packages/sdk/src/client.ts` (`getEffectiveLimits`), backend `7ecad3f3`. `GET accounts/:accountId/effective-limits` returns the limits, the rolling-window usage, the allowance, the on-chain delegation and the blockers. **Read-only**: writes stay owner-authenticated (ADR-0003), so an agent credential can see its mandate and cannot raise it. `limits: null` is denial, not an unlimited default; a `null` delegation permission means the chain read failed, not that it was denied (B1). |

## 2. Phase 0 — spec freeze and threat model

| # | Item | Status | Note |
| --- | --- | --- | --- |
| 0.1 | Adopt `AGENTS.md` + runtime plan | DONE | This commit. |
| 0.2 | ADRs for the remaining open decisions | DONE | ADR-0002 (D-05), ADR-0003 (D-13), ADR-0004 (D-18), ADR-0005 (D-22); ADR-0001 records the confirmed baseline. |
| 0.3 | Checked implementation backlog | DONE | This file. |
| 0.4 | Runner trust boundary + crash/replay threat model | PARTIAL | Three of the five crash points are modelled **and enforced**, with the table written out in the header of `packages/runner/src/recovery.ts` and asserted twice — as a table through `classify`, and end to end against a database that is closed and reopened (`packages/runner/tests/recovery.test.ts`, 23). Crash between key persist and create → re-arm reusing the *same* key; crash between create and submit → `UNKNOWN_PENDING`, never a re-send, and now resolvable: `reconcileJob` reads the recorded execution back and admits only what the server reported (`reconciler.test.ts`, 15). The one crash point that stays unresolvable is a crash *inside* the create, where no execution id was ever recorded — that needs a backend read this API does not have (B9), and it is reported as `INCONCLUSIVE` rather than guessed. Duplicate Runner instances on one store → lease fencing tokens, so the superseded writer fails `LEASE_LOST` rather than interleaving (`store.test.ts`, 37). The gaps: **signer unavailable mid-job** is now modelled at the pass level — a refusal or an unavailable keystore leaves the created execution unsigned, records the reason on the leg as `signRefusedCode`, and hands the job to the reconciler rather than calling the order failed (`tests/strategy-driver.test.ts`) — but not yet against a real keystore process that dies mid-request, and **clock skew vs `expiresAt`** is untouched — recovery expires a job against an instant its caller supplies, and nothing yet reconciles that instant against the server's. |
| 0.5 | Job state machine specification | PARTIAL | Executable rather than prose: `packages/runner/src/state-machine.ts` is the table, and `tests/state-machine.test.ts` (9) asserts its properties over the whole edge set rather than the handful a feature used — no in-flight state may reach `CANCELLED`/`EXPIRED`, `UNKNOWN_PENDING` has exactly one exit, only `RECONCILING` may reach `FILLED`, terminal states are sinks, and every `WRITE`/`SIGN` state requires a persisted leg. The store enforces that last one at runtime (`NO_IDEMPOTENCY_KEY`). Includes `PAUSED` (ADR-0004) and `UNKNOWN_PENDING`. `driveJob` now enters and leaves `PAUSED` on a market verdict (2.9), so every state in the table is reachable by an implementation rather than only by a test. |
| 0.6 | CLI command + schema prototype | PARTIAL | Schema half is done (1.2): commands, inputs and the `implementation` mapping are fixed and validated. The CLI half now covers the read plane *and* the market-order write plane (1.3–1.8). The two-host discovery spike required by the plan's exit criteria is still not done — one intent has not yet been issued through the CLI *and* an adapter, because no adapter exists (3.2). |
| 0.7 | Quote WS protocol + achievable SLO | BLOCKED | Backend. Upstream feed is ~2 s polling; SLO must precede any real-time claim. |
| 0.8 | Testnet provisioning + owner onboarding runbook | PARTIAL | The runbook and the checkable gap list exist; **nothing is provisioned**. `packages/e2e/src/gaps.ts` names seven gaps — base URL, environment label, agent wallet, signer command, default account, delegation, owner risk profile — each with who supplies it, how, and the command that would settle it; `packages/e2e/README.md` carries the two-actor sequence. `packages/e2e/tests/gaps.test.ts` (7) fails if a gap loses its supplier, if a gap can be checked before a server is reachable, or if the two **owner-authenticated** entries (`delegation`, `ownerRiskProfile`) stop saying that this pipeline must not attempt them. Those two are a human, owner-authenticated task by ADR-0003 §1 and are not automatable here by design. Verified against this machine: `describe` reports no base URL, no label, no wallet, no signer and no account, so all five operator/owner gaps are MISSING and both owner-authenticated gaps are UNCHECKED — *not* denied, because no authenticated read happened. |

**Phase 0 exit criteria** (from the plan): one normalized intent produces an
identical SDK request through the CLI and through one tool adapter, and every
secret-custody and approval boundary has a named owner. Not met — 0.4 through 0.8
are open.

## 3. Phase 1 — universal one-shot interface

| # | Item | Status | Depends on |
| --- | --- | --- | --- |
| 1.1 | pnpm workspace split: `sdk` / `cli` / `runner` / `mcp` | DONE | `pnpm-workspace.yaml`, `packages/*/package.json`, `tests/workspace.test.ts`. SDK moved to `packages/sdk` with its published entry points unchanged; `schema` added; `cli`/`runner`/`mcp` are private, source-free reserved boundaries. Dependency direction and published-package hygiene are enforced by test, not convention. |
| 1.2 | Versioned runtime command schema (single source of truth) | DONE | `packages/schema/src`, emitted to `schemas/v1/agent-commands.json`; ADR-0006. Eighteen commands, runtime-validated by `validateCommandInput` with no coercion; `packages/schema/tests` (71) cover the validator subset, unsupported-keyword rejection, every published example, BUY/SELL unit and position agreement, decimal/price/address patterns, and byte-for-byte artifact drift. `tests/workspace.test.ts` additionally fails if a contract command is not backed by an AVAILABLE capability, so the contract cannot advertise what no surface runs. |
| 1.3 | Consistent JSON envelope, symbolic error codes, exit codes | DONE | `packages/cli/src/{envelope,exit-codes,errors}.ts`; `packages/cli/tests/envelope.test.ts` (13). Exactly one parseable document on stdout on every path including an unresolvable command; usage prose on stderr only; the exit code derived from the server's own symbolic code rather than the HTTP status; `retryable` copied from the server, never re-derived. The code table is published by `describe` so a host need not hard-code it. |
| 1.4 | `describe` | DONE | `packages/cli/src/commands/describe.ts`; `packages/cli/tests/discovery.test.ts` (14). Answers with no configuration, no signer and no network. Reports the policy in force, its source, and that an approval token **is not authentication**; reports `signer.canSignTransactions` from the policy rather than from intent. `serverCapabilities.source` is `STATIC` — this build's own claim, not something the server advertised (3.3/B7 is still blocked), and it is labelled as such rather than presented as negotiated. |
| 1.5 | `doctor` | DONE | `packages/cli/src/commands/doctor.ts`; `packages/cli/tests/doctor.test.ts` (7). Config, signer, reachability, authentication, catalog read, allowance read, and `writePlaneCheck`. The write-plane check never places an order — a diagnostic that trades is one nobody can safely run — so it SKIPs under `read-only` and `interactive`, and under `delegated-auto` it FAILs the one write-blocker knowable without trading: a scope whose `notAfter` has already passed. A check that could not run is SKIP, never PASS, and the command exits with the **first failing check's own code** so a rejected token exits 4 rather than 70. Signs the login challenge as a personal message only. |
| 1.6 | `market` / `account` / `order` commands | DONE | Read plane: `market list/search/get/quote` and `account status/allowance/risk-limits/positions/executions/fills` (`packages/cli/tests/read-plane.test.ts` (22), `input.test.ts` (16)). Write plane: `order preview/execute/execute-many/get/reconcile` (`packages/cli/src/commands/order.ts`, `packages/cli/tests/write-plane.test.ts` (34)) — an ambiguous intent (wrong unit for the side, both units, neither, a SELL naming no position, a BUY naming one) is refused with exit `INVALID_INPUT` (2) and **zero network and signer calls**, because guessing the unit trades the wrong thing; a timed-out wait is `ok: true` with exit `AMBIGUOUS` (11) plus a reconcile instruction, never a resubmission; `execute-many` legs succeed, fail and skip independently and the envelope says `atomic: false`. `market search` reports the **server's** `resolution` verbatim and exits `AMBIGUOUS` (11) with `marketId: null` unless exactly one market matched — it never matches text locally, and a truncated page is never read as a unique answer. `account risk-limits` reads the mandate and cannot write one. `market history` and `order cancel` are still refused by capability negotiation with a symbolic reason and **zero network calls**. Two defects on the reconcile path are fixed and regression-tested: the ambiguous-write recovery instruction printed `--execution-id`, a spelling that exits `USAGE`, so the one command a caller runs while holding an order of unknown outcome did not run — the test now *executes* the printed string rather than matching it; and `order reconcile --timeoutMs` was bounded by the invocation timeout instead of the timeout it was given, so a long wait was aborted early. Durable/conditional order commands are 2.8, not this item. |
| 1.7 | `order preview` as a first-class command | DONE | `packages/cli/src/commands/order.ts` (`runOrderPreview`); `write-plane.test.ts`. Resolves the market server-side, mints a fresh quote, normalizes the leg, computes the price-protection bound (`CEILING` for BUY, `FLOOR` for SELL) and the effective worst price, runs the same policy engine `execute` runs, and returns the approval token with the exact `--approve …` string. Signs nothing and places nothing. Outside `read-only` it now also reads the **effective mandate** alongside the quote and reports `riskLimits`, `blockers`, `delegation` and the hour already used, so a caller sees what would refuse the write before signing — a report, never local enforcement. Nothing is synthesized: unread limits say `NOT_READ`, an account with no mandate says `NO_RISK_PROFILE` (B1). |
| 1.8 | Signer provider interface + keystore/keychain/KMS | PARTIAL | ADR-0001 §7. The **external-command** provider exists and is the CLI's only one: `packages/cli/src/signer.ts`, `packages/cli/tests/signer.test.ts` (21). No key enters the process; the request is versioned and typed, so `PERSONAL_MESSAGE` and `TRANSACTION` are distinguishable by the key holder and never interchangeable; a non-zero exit, non-JSON stdout, a missing `signature` or a timeout is `SIGNER_FAILED`, never a fabricated signature. `signTransaction` throws before a child process is spawned under `read-only`, and otherwise spends a permit from the `SigningGate` **before** the child runs, so a write path reached without an authorization runs out of permits rather than signing. The **Runner** now has its own external-command signer over the same wire: `packages/runner/src/signer.ts`, `packages/runner/tests/signer.test.ts` (20). Deliberately a separate implementation — the CLI must not depend on a daemon and the Runner must not depend on a CLI — so the protocol is exported as data (`SIGNER_PROTOCOL`) from both, `tests/workspace.test.ts` asserts the two descriptors are equal, and each package asserts the request it actually writes has exactly those keys. It emits `TRANSACTION` only, because an unattended process has no login challenge to sign, and it refuses `interactive`, `read-only` and any mode this build does not recognize before spawning: a durable strategy fires when nobody is present to approve, and accepting `interactive` would make `delegated-auto`'s explicit scope evadable by wrapping an order in a strategy whose trigger is already met. The scope's `notAfter` is re-read at signing time, not only at the top of the pass. **Keystore, keychain and KMS providers are not built.** |
| 1.9 | Automatic re-auth preserving key and exact bytes | DONE | `packages/sdk/src/session.ts`, `packages/sdk/src/transport.ts:89`, `packages/sdk/src/errors.ts:isUnauthenticated`; `packages/sdk/tests/reauthentication.test.ts` (14) covers replay under a fresh token with identical bytes and key, a token dying between create and submit, five concurrent 401s minting one session, the bound (one re-auth, then the error), a fresh signed challenge per mint, pre-expiry rollover, `autoReauthenticate: false`, and the rejections it must **not** retry (`403 DELEGATION_REVOKED`, `401 SIGNATURE_INVALID`, `409 IDEMPOTENCY_KEY_REUSED`). At the SDK layer only — 1.8's signer provider still gates the CLI/Runner path, where the challenge is signed outside this process. |
| 1.10 | Secret redaction across stdout, logs, errors, job store | PARTIAL | CLI streams DONE: `packages/cli/src/redact.ts`, `packages/cli/tests/secrets.test.ts` (7), plus the write-plane case that asserts no signature, transaction bytes or token reaches either stream on a successful order. Registered secrets are replaced on the serialized stdout document *and* on every stderr line, including when the server echoes a token back inside its own error message; a credential-shaped config file key is refused naming the key and never the value; the signer is reported by executable base name only. The job store half is now covered by **refusal rather than redaction**: `packages/runner/src/secrets.ts` rejects a secret-shaped property before it reaches the file (`SECRET_REJECTED`), and the store records a SHA-256 digest of a request instead of its bytes. Refusal, not masking, because a redactor has to know the exact secret and the risk here is the field nobody anticipated. The gap: the two sides are unrelated code — the CLI's registered-secret redaction and the store's refusal list do not share a definition of what a secret is. The Runner now logs (2.6): `runnerd` writes one JSON diagnostic per line to **stderr**, never stdout, and `tests/daemon.test.ts` asserts the IPC token appears in no event and no reply. That is a checked absence for the one secret the daemon currently holds, not a redactor — there is no third definition of "secret" applied to daemon output, and the signer that would introduce more of them is not built. |
| 1.11 | Testnet quickstart + real E2E | PARTIAL | The harness is built and executable; **the end-to-end has not run, against any server, ever.** `packages/e2e` drives the *installed* binary as a subprocess — resolved through `node_modules` the way a consumer resolves it, not by importing the handlers — across thirteen steps: describe, doctor, market list/search/get/quote, order preview, order execute, terminal wait, order get, order reconcile, account positions/fills. Four executable examples ship (`one-shot-entry`, `slippage-rejection`, `delegation-revocation`, `reconciliation`); anything needing streams, the Runner or a strategy is 2.x, not this item. Honesty is enforced by construction, not by a paragraph: a `NOT_RUN` step carries no evidence field, so "passed without running" is unrepresentable; a step whose evidence transport is `STUB` makes the entire report `INVALID`, so a mock cannot stand in for a live path; and only an all-steps-passed report exits 0. The one write needs `--allow-write` **and** an environment label on the non-production allowlist — an unlabelled deployment is treated as production and is never traded on, proven by a test asserting the invoker never receives an `order execute` argv under a `mainnet` label. `packages/e2e/tests` (59) also lint every published invocation, including the examples and the READMEs, against the command contract, and execute each example with an empty environment to prove it refuses with a named supplier rather than a stack trace. **Actual result on this machine: PARTIAL, exit 10 — one step (`describe`) passed and twelve could not run.** That is the harness working, not an E2E passing. Depends on 1.1–1.9 and on 0.8's provisioning, which is a human task. |

On 1.2 and what it does **not** mean: `schemas/v1/agent-commands.json` describes
eighteen commands, and the CLI now runs all eighteen — but describing a command is
still not running one, and the guarantee comes from a test rather than from this
sentence. `tests/workspace.test.ts` fails if any contract command lacks an
AVAILABLE capability in `packages/cli/src/capabilities.ts`, so the contract
cannot drift back into advertising an intent no surface performs.

The v1 command set covers only what a surface can actually perform. `describe`,
`doctor` and `command-schema` are in it under an `implementation` union whose
`runtime` arm marks a command the runtime answers locally rather than through an
SDK method (ADR-0006). `market history` and `order cancel` are **absent on
purpose**: a command entry is precisely what an adapter turns into an advertised,
callable tool, so listing one would present a capability that does not exist.
Both are refused by name at the CLI with a symbolic reason and no network call,
so an agent asking for them gets an answer instead of silence.

`market search` and `account risk-limits` were absent for the same reason and are
now present, because the **server** grew the endpoints behind them (`7ecad3f3`).
That is the only admissible reason for a name to move in this direction, and
`packages/schema/tests/document.test.ts` says so at the point where the old list
lived: a command must never be added because the client learned to approximate
one. Approximating `market search` locally would mean returning a `marketId` this
CLI picked out of a truncated page, which ADR-0001 §10 forbids.

On the write plane and what it does **not** mean: an approval token binds one
exact intent, and it is **not authentication**. It is a digest any caller holding
the same order fields can compute, so it proves the order was not altered between
preview and execute — never that a person saw it. Human-in-the-loop is a property
of the host that decides whether to pass the token back; the CLI can only
guarantee that the order executed is the order approved.

On 1.9 and what it does **not** mean: the no-duplicate-execution guarantee is
proven in-process, against a fetch double, for a write the SDK itself replays.
It has not been exercised against a real server (1.11), and it says nothing about
a crash between the create and the submit — that is 0.4's threat model and 2.5's
durable store, because recovering from it needs the idempotency key to have
outlived the process.

**Phase 1 exit criteria**: an onboarded user gets a shell-capable agent to its
first testnet trade in 15 minutes, and a token expiring mid-flow causes no
duplicate execution. **Not met.** Neither half has been observed: no testnet
trade has been placed by this runtime, and the no-duplicate-execution property
is proven in-process against a fetch double only. 1.11 now provides the
instrument that would measure both; provisioning it is 0.8, and two of its seven
gaps are owner-authenticated actions no automation here may take.

## 4. Phase 2 — streaming and durable strategies

| # | Item | Status | Depends on |
| --- | --- | --- | --- |
| 2.1 | Backend quote WS | DONE (backend `2aedb8d8`) | Socket.IO on the existing private namespace `/agent-api/v1/predict`: `predict.quotes.subscribe` / `.unsubscribe` → a per-topic `predict.quotes.subscription` ack, a `predict.quotes.v1` SNAPSHOT per accepted topic, UPDATE only when a price moved, and a 15 s `predict.quotes.heartbeat` carrying each topic's `seq` and `stale`. 32 topics per connection, 60 messages per rolling minute, rejection per topic (`INVALID_REQUEST` / `UNKNOWN_MARKET` / `MARKET_CLOSED` / `NOT_QUOTABLE` / `SUBSCRIPTION_LIMIT` / `RATE_LIMITED`). **No replay exists and none is claimed**: this is a state feed, `seq` is per (connection, topic) from 1, the snapshot *is* the recovery, and `resume: true` returns it with `gap: true`. **Not low-latency, and labelled as such**: the server polls an upstream cache every ~2 s behind a publisher on a ~5 s cadence, so every frame carries `POLLED_UPSTREAM` plus `freshness.pollIntervalMs` / `staleAfterMs`, a past-TTL value publishes as `stale` with **null** prices, and an unstamped value reports `sourceAgeMs: null`, never 0. SLO measured as freshness — `value_age_seconds` P95 ≤ 8 s / P99 ≤ 15 s end to end, `delivery_lag_seconds` P99 ≤ 1 s for the WaterX-controlled portion. Tests: `predict-agent-quote-stream.service.spec.ts` (30) + `predict-agent-stream.gateway.spec.ts` (14, four of them the quote delegation and release), on a mock socket seam — no port, no live Socket.IO server. |
| 2.2 | Native execution stream client (replaces the SEAM) | DONE | `packages/sdk/src/execution-stream.ts`. `socket.io-client@^4.8.3` added as the SDK's only runtime dependency, justified in that file's header and allowlisted in `tests/workspace.test.ts`; loaded with `await import`, so a caller that never streams never loads it, and a pruned dependency degrades to polling instead of crashing at module load. WebSocket-only transport, because the server fans out per pod with no Socket.IO Redis adapter. Note what this buys: the outbox dispatcher publishes on a ~5 s tick, so it saves **requests**, not milliseconds. |
| 2.3 | Native quote stream client (replaces the SEAM) | DONE | `packages/sdk/src/quote-stream.ts`. Subscribes only after the ready frame proves the handshake was accepted, batches a burst of topics into one message against the 60-per-minute budget, and reports a `seq` break — from a frame or from the heartbeat, which is the only gap signal a quiet market has — without re-subscribing, because on a state feed a gap costs intermediate values and not the value now. A reconnect re-subscribes every held topic with `resume: true` and invalidates every cached price first. Two missed heartbeats rebuild the connection; a bounded number of silent windows, or of refused handshakes, gives up to REST polling via `onDegraded`. `MARKET_CLOSED` / `UNKNOWN_MARKET` / `INVALID_REQUEST` are terminal for the round and never re-asked; `NOT_QUOTABLE` / `SUBSCRIPTION_LIMIT` / `RATE_LIMITED` are retried on a timer. What it buys is **requests, not milliseconds** — one quote mint per trigger instead of one per tick (2.1: the server polls an upstream cache every ~2 s). Integrated into `waitForPriceAndExecute`: `pollIntervalMs` becomes a ceiling, the subscription is bracketed to the wait, and the order is still built on a fresh `POST /quotes` and re-verified against the target. |
| 2.4 | Gap detection, cursor persistence, REST reconciliation | PARTIAL | Implemented in the stream client: the cursor advances monotonically (BigInt, never rewound by a replay), rides every handshake including reconnects, and `gap: true` — plus a plain reconnect, which loses frames just as quietly — wakes every waiter to re-read over REST. `onCursor`/`cursor` expose the resume point for a caller that persists it. **A place to persist it now exists** — `saveCursor`/`readCursor` on the Runner's store keep a monotonic resume point across a restart and refuse a rewind (`CURSOR_REWIND`), tested through a closed and reopened database. The gap is now purely wiring: a process that outlives an invocation exists (2.6), and nothing in it reads a saved cursor back into a stream, because nothing in it opens a stream at all. The quote stream (2.3) detects gaps too, but has nothing to persist and nothing to reconcile against: it keeps no log, so its snapshot is the recovery and its `seq` is meaningless off the connection that issued it. |
| 2.5 | SQLite/WAL durable job store behind a store interface | DONE | ADR-0001 §8, ADR-0007. `packages/runner/src/store.ts` is the engine-free interface; `src/sqlite/` is the implementation, on `node:sqlite` so no native addon or postinstall script runs inside the process that will hold the signer. `journal_mode = WAL`, `synchronous = FULL` (NORMAL may lose the last transaction, which here is routinely the idempotency key written immediately before the order that uses it), `foreign_keys = ON`, `STRICT` tables, forward-only migrations on `user_version`, and a newer schema refused outright (`SCHEMA_TOO_NEW`). Every method is exactly one transaction and none is exposed, so a half-applied "persist the key, then mark the state" is unrepresentable; every mutating job method takes a lease. What it holds: the job, its normalized intent, trigger, policy snapshot, `expiresAt`, per-leg idempotency key, reference and submission quote ids, execution id, both digests, the side-effect ledger, the stream cursor, instance heartbeats and an append-only transition log. What it refuses to hold: signatures, sponsored transaction bytes, tokens and key material — a secret-shaped field is **rejected** (`SECRET_REJECTED`), not redacted, and a request is recorded as a SHA-256 digest, which proves a replay is byte-identical and is useless to whoever can read the file. `packages/runner/tests/store.test.ts` (37), against a real file that is closed and reopened. |
| 2.6 | Runner daemon + local IPC | PARTIAL | ADR-0008. **The process, its socket, the job driver and the loop that calls it all exist; what the loop must be handed does not.** `packages/runner/src/daemon.ts` + `src/bin/runnerd.ts`: start-up order is asserted-directory → open store → register instance → recover → listen, so no client can observe a Runner that has not yet decided what its jobs are, and a failure at any step unwinds the ones before it. `src/supervisor.ts` renews leases and heartbeats on a timer, without bumping the fence, and aborts a job's signal both when it was fenced out and when a renewal failure has left the lease inside the safety margin. `src/ipc/` is the local surface: a Unix domain socket at `0600` inside a `0700` uid-owned runtime directory that is **asserted rather than repaired**, a 256-bit token reminted on every start and compared with `timingSafeEqual`, versioned NDJSON frames with a bound, an ordered per-connection queue, `sun_path` length checked, and a stale socket taken over while a live one is refused. The surface is `runner.status`/`jobs`/`job`/`cancel-job`/`shutdown` only; an agent command from the shared registry is refused `NOT_IMPLEMENTED` naming the missing pieces rather than answered, and `cancel-job` distinguishes `recorded` from `applied` so a cancel during a possible write never reports a stop that did not happen. Tests: `tests/daemon.test.ts` (25), `tests/ipc.test.ts` (48), `tests/supervisor.test.ts` (14), `tests/scheduler.test.ts` (15), `tests/prices.test.ts` (20), all in-process on an ephemeral socket or none at all. `UNKNOWN_PENDING` reconciliation now exists as `src/reconciler.ts` (`tests/reconciler.test.ts`, 15): it moves the job to `RECONCILING` **before** the read, so a second crash cannot leave a job that already learned the answer still claiming it does not know; it admits only a status the server reported (`REJECTED` → `FAILED`, `CANCELLED`/`EXPIRED` verbatim) and leaves `SUBMITTED`/`PENDING_FILL` alone rather than finalizing a live order on a clock; it resolves the open attempt and patches the leg in one transaction; and it refuses to call a submit successful without a digest or a status at or past `SUBMITTING`, because an execution `REJECTED` by risk before it was sent is a submit that did *not* take effect. Legs resolve one per pass and independently (ADR-0001 §15), and an unresolved leg is preferred by evidence rather than by index, so one ambiguous create cannot hide its resolvable siblings forever. The create-phase case is unresolvable against this API (B9), so it reports `INCONCLUSIVE` and leaves the job visible. The **driver** now exists: `src/strategy/driver.ts` + `src/strategy/preflight.ts` (`tests/strategy-driver.test.ts`, 34) advance one claimed job by one pass and call the reconciler at the end of it. The **loop** now exists too: `src/scheduler.ts` (`tests/scheduler.test.ts`, 15) claims every runnable, unleased job each tick up to a `maxJobs` bound it *reports* rather than silently applies, drives each held job one pass in sequence, joins a concurrent `tick` instead of running a second pass over the same jobs — the guard that stops a tick interval shorter than a slow pass from minting two keys for one intent — skips a pass whose lease signal has already aborted, forgets a job on `LEASE_LOST`, and records a pass that threw against its job while the other jobs still get theirs. `stop` awaits the pass in flight, because a clean shutdown that abandoned a half-finished pass would manufacture the ambiguity the ledger exists to recover from, on purpose, on every Ctrl-C. The daemon takes a `driver` — gateway, `PriceObserver` and `StrategySigner` supplied together — and starts a scheduler only if it gets one; `driving` is read from whether that scheduler is ticking, never from a constant. The **price source** now exists too: `src/prices.ts` (`tests/prices.test.ts`, 20) puts a `PriceObserver` over the SDK's indicative quote stream. It subscribes once per market/outcome however many sides watch it, reads the ask for a BUY and the bid for a SELL through `streamTriggerPrice` so trigger and quote read the same book, and drops the cached frame on *every* event that means the feed can no longer prove it is live — stale, `GAP`, `DISCONNECTED`, `DEGRADED`, or a per-topic server refusal — because "nothing was observed" and "the market moved away" must not look alike to the executor. It accepts a `gap: true` resume snapshot as an answer, on the stated ground that every trigger here is a level test on current state rather than an edge test on a crossing, and records the gap for diagnosis rather than hiding it. It **does not fall back to `POST /quotes`**, unlike the SDK's `QuoteStreamPriceWatcher`: a `WatchKey` carries no size and that request requires one, so falling back would mean inventing a probe size and minting a priced, executable artifact to read a number. Subscriptions expire by disuse rather than by notification, so no cancellation, expiry, lost lease or crash leaks one, and `topics()` surfaces a topic gone permanently quiet under `DEGRADED` instead of leaving a strategy that waits forever looking healthy. The **signer** now exists too: `src/signer.ts` (`tests/signer.test.ts`, 20) signs sponsored bytes through a keystore command that holds the key, and refuses `interactive`, `read-only` and an unrecognized mode before spawning it (1.8). **Still missing, and the reason the shipped `runnerd` still advances nothing:** the local configuration `src/bin/runnerd.ts` would need in order to open a quote stream and name a keystore command — an observer over no stream is not a price source, and a signer with no configured command cannot sign — plus the rest of daemon-side policy (2.7). The strategy commands a client would use now exist as a library (2.8) and are deliberately *not* on this socket: a `strategy.create` answered by a process that may report `driving: false` would write a durable record and then advance it nowhere, which is the one thing the socket's refusals exist to prevent. No Windows fallback in beta (ADR-0002, ADR-0008). |
| 2.7 | Policy engine: `interactive` / `delegated-auto` / `read-only` | PARTIAL | ADR-0001 §9. Implemented and enforced for **one-shot CLI writes**: `packages/cli/src/policy.ts`, `packages/cli/tests/write-plane.test.ts` (34) + `signer.test.ts`. `--policy` may only narrow, never widen; `read-only` is enforced inside the signer; `delegated-auto` requires a file-only scope with mandatory per-order and per-run ceilings, an allow-listed account, side and market, and an unexpired `notAfter`, and every local check runs **before** any network read so an out-of-scope order costs nothing. The gap: no daemon-side policy and no policy evaluated across a durable job's lifetime — the daemon and the loop that drives its jobs both exist now (2.6), and neither evaluates a policy beyond what `preflight` reads off the job's own snapshot. The store snapshots the policy that admitted a job (`JobPolicySnapshot`), and `preflight` now performs **part** of the hour-later check: every driven pass re-reads the snapshot's `notAfter` and ends the job `POLICY_EXPIRED`, and applies `maxOrderNotional` to a BUY leg before it is quoted. The policy **mode** is now enforced across a durable job's lifetime, in three places that each catch what the others cannot: `normalizeStrategy` refuses a create under `interactive`, `read-only` or an unrecognized mode, so an owner learns at the prompt; `checkLocalPolicy` refuses on every pass **before any read**, so an unsignable job never watches a market or reserves allowance; and `createExternalCommandSigner` refuses before it spawns, so a path that skipped both still cannot produce a signature. `interactive` is refused rather than queued because a durable strategy fires when nobody is present to approve, and an unrecognized mode **pauses** rather than ends the job (ADR-0004). Tested as features in `tests/signer.test.ts` (20), `tests/strategy-intent.test.ts` and `tests/strategy-driver.test.ts`. The gap is the rest of the scope — allow-listed account, side and market, and the per-run ceiling — which is enforced only by the CLI's one-shot evaluator, and the daemon, which evaluates nothing beyond the job's own snapshot. |
| 2.8 | `strategy create / get / list / cancel / events` | PARTIAL | `packages/runner/src/strategy/` — the command core, on the durable store: `create` normalizes an intent and writes a job, `get`/`list` summarize it (`list` filters by account, strategy and state, and returns summaries rather than fanning out per row), `events` merges the transition log with the side-effect ledger into one ordered feed with stable ids in which an unresolved attempt appears as `SIDE_EFFECT_BEGAN` marked `unresolved` rather than as silence, and `cancel` is the *same* implementation the IPC socket now delegates to, so `recorded` vs `applied` cannot drift between two surfaces. `pastExpiry` is reported as a fact about the clock, never as the `EXPIRED` state, because only a Runner holding the lease may end a job. Tests: `tests/strategy-service.test.ts` (14) against a real database that is closed and reopened, `tests/strategy-intent.test.ts` (33). **The gap: whether a created job then advances depends on the process it was created in.** `driveJob` and `JobScheduler` (2.6) will advance one, but only for a daemon given a price source and a signer, and while `QuoteStreamPriceObserver` and `createExternalCommandSigner` both now exist, nothing in a shipped `runnerd` opens a stream to put the one over or names a keystore command for the other. A strategy created under `interactive` or `read-only` is now refused outright rather than written and left unadvanceable (2.7). These commands are therefore deliberately *not* exposed over the IPC socket or the agent-command contract yet, because advertising `strategy.create` from a process that may report `driving: false` would claim execution that does not exist. |
| 2.9 | `PAUSED` handling and terminal market lifecycle | PARTIAL | ADR-0004. `packages/runner/src/strategy/lifecycle.ts` is the decision table: closed and resolved are TERMINAL, not-tradeable is PAUSE under the *original* expiry, and an unrecognized status is PAUSE rather than TERMINAL — pausing a job that should have ended costs it time it already had a bound on, ending one that could still have fired cannot be undone. It reads `status` and `tradeable` and nothing else; `tradeabilityReason` is an open set written for people, so matching it would make a server copy edit a control-flow change on every Runner (B4 would refine PAUSE, never detect it). `tests/strategy-lifecycle.test.ts` (10), exhaustive over the status × tradeable table. **`preflight` now calls it, and `driveJob` acts on the verdict**: every watching pass re-reads the trigger's market *and* each leg's, enters `PAUSED` on a PAUSE, leaves it for `WATCHING` — never straight into an order — when the market quotes again, and ends the job on a TERMINAL one. A pause writes no transition it already wrote, so a market closed for a day is one row rather than a log. `tests/strategy-driver.test.ts` covers enter, stay, leave, terminal and unrecognized-status. The gap: this happens only on a driven pass, so it happens on a tick in a daemon given a driver and not at all in one without (2.6). |
| 2.10 | Mandatory `expiresAt`, 7-day cap, no extension | PARTIAL | ADR-0005. Enforced at creation by `resolveExpiry` (`packages/runner/src/strategy/intent.ts`): absent is refused (`EXPIRY_REQUIRED`), a zoneless or locale-formatted instant is refused rather than parsed — `Date.parse('01/02/2026')` is the host's opinion, not the caller's — an instant at or before now is refused, and past the seven-day cap is refused with the latest instant that *would* have been allowed, **never silently clamped**, since a clamped expiry stops watching earlier than its owner asked. The accepted value is canonicalized to UTC and written once; nothing anywhere extends it, and pausing explicitly does not. 15 of `tests/strategy-intent.test.ts`'s cases cover this. `driveJob` now ends a job at its expiry on any pass that reaches it, before it reads a market or a quote, and a cancellation the owner asked for outranks it. `tests/scheduler.test.ts` proves the loop ends a job on the clock alone, with no market read. **The gap: a timer fires between start-ups only in a daemon that was given a driver** — in one without, a job that passes its expiry stays in its state until the next start-up recovers it (2.6). Nothing extends an expiry, and pausing explicitly does not. |
| 2.11 | Frozen-share percentage SELL; dynamic fraction as a distinct mode | PARTIAL | ADR-0001 §13, D-15. At creation: exactly one of `buyAmount`, `sellShares`, `sellFractionOfPosition`, `dynamicSellFractionOfPosition` may be given — none is `SIZE_MISSING`, more than one is `SIZE_AMBIGUOUS` listing what was given, and a size is never inferred from the side. `sellFractionOfPosition` is the **default** meaning of "sell half": it resolves against a real position read into a concrete `sellShares` on exact scaled-integer arithmetic (truncating toward zero, and refusing a fraction that resolves to nothing rather than submitting a zero-size order), and the record keeps `positionSharesAtCreation` and `frozenAt` beside it. The read proves absence rather than assuming it: it pages until the server answers `nextCursor: null`, and an unanswered cursor, a repeating cursor or a page bound is `POSITION_LOOKUP_INCONCLUSIVE`, not "you hold none". `dynamicSellFractionOfPosition` is the distinct explicit mode and performs **no** read at creation. `JobLegSizing` persists which mode a leg is in. **The dynamic mode now has its resolution point**: `preflight` re-reads the position at trigger for a `DYNAMIC_FRACTION` leg *only*, sizes off what is held then, and leaves a frozen leg untouched — a frozen job performs no position read at trigger at all. Absence is still proven rather than assumed: an inconclusive lookup **pauses the whole job**, while a *proven* absence, a market/outcome mismatch or a fraction that resolves to zero skips only that leg and leaves its siblings to trade. Covered by `tests/strategy-driver.test.ts`. The gap: as everywhere in 2.6, resolution happens only on a driven pass. |
| 2.12 | Restart / kill / network-partition tests | PARTIAL | The **restart** half exists at the store layer: `packages/runner/tests/recovery.test.ts` (23) stages each crash point against a real database, closes it, reopens it and asserts what the next Runner does — re-arm on the same key, `UNKNOWN_PENDING` on an unresolved attempt, reconcile on a recorded execution id, and hands off rather than racing when another instance holds the lease. These are in-process reopen tests, not a killed process: no `SIGKILL`, no partition, and no server on the other end. The daemon (2.6) adds start-up recovery and clean shutdown under test — `tests/daemon.test.ts` asserts that a seeded mid-write crash is recovered as `UNKNOWN_PENDING` and stays there, and that a second Runner refuses a live socket — but those daemons are started and stopped in-process. **The thing that can now be interrupted mid-order exists, and is tested at every boundary**: `tests/strategy-driver.test.ts` injects the crash at the *store*, so the pass dies with exactly the rows a process killed one instruction earlier would have left, then closes the database, reopens it, runs recovery and counts what the gateway was ever asked to send. The four boundaries are: before the `CREATING` transition (nothing sent; the next pass re-arms and re-uses the **same persisted key**), during the create (one create ever, `UNKNOWN_PENDING` forever, no second order invented), after a recorded create and before the submit (recovery reconciles; zero submits), and during the submit (one submit ever, resolved by *reading* the execution rather than resending it). **Still not covered: a real `SIGKILL`, a network partition, and a server on the other end.** The crash is injected in-process and every gateway is a script. |
| 2.13 | Notification sink (webhook + durable event log) | TODO | D-23 |

**Phase 2 exit criteria**: across a two-hour strategy with forced token expiry, a
WS gap, and a Runner restart, at most one logical execution results and every leg
reconciles independently.

## 5. Phase 3 — adapters, beta, operations

| # | Item | Status |
| --- | --- | --- |
| 3.1 | Host-neutral agent instructions | TODO |
| 3.2 | MCP adapter + one other function-calling adapter, same schema | TODO |
| 3.3 | Server capability advertisement consumed by `describe` | BLOCKED (backend) |
| 3.4 | Quote-to-fill deviation, WS latency, reject-reason dashboards | PARTIAL (backend) — the quote stream now exports freshness (`value_age_seconds`), the WaterX-controlled portion (`delivery_lag_seconds`), frame counts by kind, subscription/stale-topic coverage and rejections by reason (backend `2aedb8d8`). Quote-to-fill deviation and execution reject-reason series are still absent, and no dashboard exists. |
| 3.5 | Thin-market large-size and high-subscription load tests | TODO |
| 3.6 | npm provenance, SBOM, upgrade/rollback docs, beta support policy | TODO — also gates publishing `@waterx/predict-agent-cli`, which is `private` today |

## 6. Backend dependencies

Ordered by what blocks the most SDK work.

| # | Capability | Status | Blocks |
| --- | --- | --- | --- |
| B1 | Agent-readable effective risk limits | DONE (backend `7ecad3f3`) | Unblocked 1.7. `GET agent-api/v1/predict/accounts/:accountId/effective-limits` on the **agent** controller returns limits, rolling-window usage, allowance, on-chain delegation and blockers. Read-only: ADR-0003 stands, and the owner-authenticated controller keeps every write. `order preview` and `account risk-limits` now report the real mandate instead of a reason; absence is still absence (`NOT_READ` / `NO_RISK_PROFILE`), never an unlimited default. |
| B2 | Market search / aliases for server-side resolution | DONE (backend `7ecad3f3`) | Unblocked natural-language resolution. `ListMarketsQuery.search` matches published `aliases` server-side and `ListMarketsResponseBody.resolution` carries the verdict. Matching is deterministic and purely lexical — every query token must prefix an alias token, no fuzzy distance, no synonym table — so the same text against the same catalog always resolves the same way. Candidate order is a tie-break (specificity, `closesAt`, id), **not** a ranking of which market is worth trading, and it is documented as such at the contract, command and CLI layers. `marketId` is non-null only on a unique match, so ADR-0001 §10 holds: identity is resolved by the server or not at all. |
| B3 | Quote WS: snapshot + monotonic sequence + gap + SLO | DONE (backend `2aedb8d8`) | Unblocked 2.1 and 2.3. Snapshot on every subscribe, `seq` monotonic per (connection, topic), `gap: true` on a resumed snapshot, heartbeat, per-topic rejection, subscription cap and rate limit, and freshness facts on every frame. Two honest limits are part of the capability, not caveats bolted on: there is **no replay** (a state feed writes nothing per tick — the snapshot is the recovery), and it is **not low-latency** (the server polls an upstream cache; the SLO is stated as `value_age_seconds` P95 ≤ 8 s / P99 ≤ 15 s, with `delivery_lag_seconds` P99 ≤ 1 s as the alertable WaterX-controlled portion). Size-aware depth is still B5; a machine-readable tradeability reason is still B4. |
| B4 | Machine-readable tradeability reason code (closed set) | TODO | 2.9 — ADR-0004 §8. `tradeabilityReason` is free text today. |
| B5 | Size-aware executable quote | TODO | Honest large-size preview. Today `availableSize`, `expectedFillSize`, `feeAmount` are null and `qualityFlags` carries `TOP_OF_BOOK_ONLY`. |
| B6 | Cursor pagination for executions / fills / positions | DONE (backend `2e247fc4`) | Unblocked complete history reconstruction. An opaque base64url keyset cursor anchored on a **row id**, not a timestamp — `TIMESTAMPTZ` is microsecond-precision and a JS `Date` is millisecond, so a timestamp cursor loses rows at the boundary. Keyset, not offset: rows arrive at the head mid-walk, and an offset would repeat or skip. `limit` alone still works, so the change is additive. Every cursor is version-tagged, kind-tagged and canonically re-encoded on decode, and is refused as `INVALID_REQUEST` if it is malformed, truncated, non-canonically spelled, minted for a different list, or names a row belonging to another agent — silently ignoring one restarts the page at the newest row and the caller double-counts it. `nextCursor: null` is proven by reading `limit + 1`, never inferred from page length. **`market list` deliberately gets no cursor**: the catalog is a mutable set with no stable insert order to anchor on, so `?cursor=` there is a 400 rather than a no-op, and the CLI rejects the flag before any request. |
| B7 | Server capability advertisement | TODO | 3.3 |
| B9 | A read from an idempotency key to an execution | TODO | The one `UNKNOWN_PENDING` case the Runner cannot resolve (2.6). A crash *during* `POST /executions` leaves a durable idempotency key and no execution id, and nothing in this API says whether that key produced an execution: no endpoint accepts the key, `PredictExecutionSummary` does not carry it, and `ListExecutionsQuery` cannot filter on it. Replaying the create as a probe is not a workaround — a key that never landed would be *made* to land by the probe, reserving allowance and creating the order the caller was trying to find out about, and the exact request bytes died with the process in any case. `reconcileJob` therefore reports `INCONCLUSIVE` and leaves the job visible in `UNKNOWN_PENDING`. Smallest sufficient fix: echo `idempotencyKey` on `PredictExecutionSummary` **and** accept it as a `ListExecutionsQuery` filter, so the answer is one authoritative read rather than a scan. |
| B8 | Performance reads: realized PnL, win rate, trade count, attribution | TODO | Scenario 5. Scope-gated by D-24. |

## 7. Open questions not yet ADR'd

D-23 through D-30 remain deliberately undecided. None gates Phase 0 or Phase 1.
They must be decided before beta:

| ID | Question | Gates |
| --- | --- | --- |
| D-23 | Notification channels | 2.13 |
| D-24 | Whether agent performance includes direct-chain trades | B8 |
| D-25 | Historical quote window and granularity | Scenario 1 |
| D-26 | Runtime auto-update with active jobs | 3.6 |
| D-27 | Release artifacts (provenance, SBOM, container) | 3.6 |
| D-28 | Whether MCP ships in the first wave | 3.2 |
| D-29 | CLI/local API version support window | 3.6 |
| D-30 | Telemetry and privacy defaults | 3.6 |

## 8. Standing rules for updating this file

- Move an item to **DONE** only when the public path *and* its failure/recovery
  behavior are implemented and tested. Documentation or scaffolding is not DONE.
- A capability may be advertised by `describe` only when it is DONE here.
- Re-diff the vendored contract against the backend whenever a wire surface
  changes, and update the "Contract sync" section with the commits compared.
- A reserved package boundary is never evidence for the item that names it.
  `packages/mcp` existing does not advance 3.2, and a Runner that starts, holds
  leases and answers a socket does not make 2.6 DONE — a job that nothing drives
  is not a running strategy, however reachable the process holding it is. A
  `JobScheduler` that exists does not change that either: the loop is DONE, but
  2.6 stays PARTIAL until the process an operator actually starts can build a
  driver, because a loop with no price source and no signer drives nothing. A
  `QuoteStreamPriceObserver` and an external-command signer that both exist do not
  change it either: an observer over a stream nothing opens is not a price source,
  and a signer nothing configures a command for cannot sign. The test of whether
  that has changed is `runnerd` printing `driving: true`, not the package being
  capable of it.
- A command in `schemas/v1/agent-commands.json` describes an intent; it is not
  evidence that a surface can execute it. Only add one when the execution core
  can perform it.
- When an item moves, update the evidence column with a real path or test name.
  An item with no evidence is not DONE.
