# Implementation backlog

Derived from `docs/AGENT_INSTALLATION_AND_RUNTIME_PLAN.md` and constrained by
`docs/adr/`. This file is the only place that tracks what is **actually
implemented**. The plan describes the intended system; an ADR constrains how it
gets built; neither is evidence that anything works.

- Verified: 2026-08-12
- SDK: `codex/waterx-predict-agent-runtime` @ `4bfb258` plus this commit
- Backend: `codex/waterx-predict-agent-runtime` @ `201fc84` (untouched)
- SDK verification: `pnpm typecheck` clean, `pnpm test` 296/296 in 19 files
  (72 SDK, 71 schema, 133 CLI, 20 workspace), `pnpm build` clean,
  `pnpm schema:generate` reproduces the committed artifact byte-for-byte.

The repository is a pnpm workspace. `packages/sdk` is the SDK this file tracked
before the split; `packages/cli` now holds discovery, `doctor`, the market and
account read plane, **and the market-order write plane** — preview, execute,
execute-many, get and reconcile, behind an enforced execution policy;
`packages/runner` and `packages/mcp` are reserved boundaries with **no
implementation** and must not be read as progress on the items that name them.

What the CLI writes, it writes one order at a time from a one-shot process. There
is no daemon, no durable job and no conditional order in this build: a strategy
that must outlive the invocation is still 2.5–2.8, and nothing here should be
read as progress on it.

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
were diffed in full at the commits above. Below the file header (SDK lines 1–28,
backend lines 1–22, which differ only in the vendoring notice) they are
byte-identical. No drift. Re-diffed in full at the commits in the header and
still identical: the CLI work above is a new surface over the same client and the
same wire shapes, so no backend change was required and none was made.

The write plane did not change this. It composes `createOrder` → sign →
`submitOrder`, `executeMany`, `getExecution` and `waitForExecution` exactly as the
SDK already implemented them; the approval token, the delegation scope and the
signing gate are **local** constructs that never appear on the wire. The backend
worktree is still at `201fc84` with a clean tree.

## 1. Current SDK state — verified

| Capability | Status | Evidence |
| --- | --- | --- |
| Personal-message auth + token handling | DONE | `packages/sdk/src/client.ts:241`, `packages/sdk/src/signer.ts` |
| Bounded automatic re-authentication | DONE | `packages/sdk/src/session.ts`, `packages/sdk/src/transport.ts:89`, `packages/sdk/tests/reauthentication.test.ts` (14). Single-flight mint, compare-and-swap token replacement, one retry per request, `401 UNAUTHENTICATED` only, replay keeps exact bytes and key. |
| Executable quote | DONE | `packages/sdk/src/client.ts:266` |
| Market catalog list + get | DONE | `packages/sdk/src/client.ts:544`, `packages/sdk/src/client.ts:559` |
| Protected market order (create → sign → submit) | DONE | `packages/sdk/src/client.ts:291` |
| Terminal wait + REST reconciliation | DONE | `packages/sdk/src/client.ts:582` (public `waitForExecution`), `packages/sdk/tests/client.test.ts` |
| Terminal facts: fill, fee availability, remaining allowance | DONE | `packages/sdk/src/execution-facts.ts`, `packages/sdk/tests/terminal-result.test.ts` (14). Timeout returns `timedOut: true` with the execution id instead of throwing; absent fee is a reason, never zero; allowance is `undefined` off a non-terminal read and for an agent with no risk profile. |
| Stable idempotency across retries | DONE | `packages/sdk/tests/client.test.ts` |
| Server-driven retry policy | DONE | `packages/sdk/src/transport.ts`, `packages/sdk/src/errors.ts` |
| Exact decimal comparison | DONE | `packages/sdk/src/decimal.ts`, `packages/sdk/tests/wait-for-price.test.ts` |
| `executeMany` independent legs + STOP/CONTINUE | DONE | `packages/sdk/src/client.ts:340` |
| Allowance / positions / executions / fills reads | DONE | `packages/sdk/src/client.ts:474`–`:531` |
| `waitForPriceAndExecute` in-process trigger | PARTIAL | `packages/sdk/src/client.ts:396`. Correct trigger, fresh re-quote, re-verify, one submission — but in-process only. Dies with the process; not durable. |
| Execution stream | SEAM | `packages/sdk/src/client.ts:141`. Interface only; caller supplies a Socket.IO adapter. Default path polls. |
| Quote stream | SEAM | `packages/sdk/src/client.ts:121`. Interface only; default polls `POST /quotes`. |
| Agent-readable effective risk limits | TODO | No client method. Backend exposes risk profile on the **owner** controller only (ADR-0003). |

## 2. Phase 0 — spec freeze and threat model

| # | Item | Status | Note |
| --- | --- | --- | --- |
| 0.1 | Adopt `AGENTS.md` + runtime plan | DONE | This commit. |
| 0.2 | ADRs for the remaining open decisions | DONE | ADR-0002 (D-05), ADR-0003 (D-13), ADR-0004 (D-18), ADR-0005 (D-22); ADR-0001 records the confirmed baseline. |
| 0.3 | Checked implementation backlog | DONE | This file. |
| 0.4 | Runner trust boundary + crash/replay threat model | TODO | Must cover: crash between idempotency-key persist and create; crash between create and submit; duplicate Runner instances on one job store; signer unavailable mid-job; clock skew vs `expiresAt`. |
| 0.5 | Job state machine specification | TODO | Including `PAUSED` (ADR-0004) and `UNKNOWN_PENDING`, and which transitions require a durable write **before** the side effect. |
| 0.6 | CLI command + schema prototype | PARTIAL | Schema half is done (1.2): commands, inputs and the `implementation` mapping are fixed and validated. The CLI half now covers the read plane *and* the market-order write plane (1.3–1.8). The two-host discovery spike required by the plan's exit criteria is still not done — one intent has not yet been issued through the CLI *and* an adapter, because no adapter exists (3.2). |
| 0.7 | Quote WS protocol + achievable SLO | BLOCKED | Backend. Upstream feed is ~2 s polling; SLO must precede any real-time claim. |
| 0.8 | Testnet provisioning + owner onboarding runbook | TODO | Depends on ADR-0003's two-actor flow. |

**Phase 0 exit criteria** (from the plan): one normalized intent produces an
identical SDK request through the CLI and through one tool adapter, and every
secret-custody and approval boundary has a named owner. Not met — 0.4 through 0.8
are open.

## 3. Phase 1 — universal one-shot interface

| # | Item | Status | Depends on |
| --- | --- | --- | --- |
| 1.1 | pnpm workspace split: `sdk` / `cli` / `runner` / `mcp` | DONE | `pnpm-workspace.yaml`, `packages/*/package.json`, `tests/workspace.test.ts`. SDK moved to `packages/sdk` with its published entry points unchanged; `schema` added; `cli`/`runner`/`mcp` are private, source-free reserved boundaries. Dependency direction and published-package hygiene are enforced by test, not convention. |
| 1.2 | Versioned runtime command schema (single source of truth) | DONE | `packages/schema/src`, emitted to `schemas/v1/agent-commands.json`; ADR-0006. Sixteen commands, runtime-validated by `validateCommandInput` with no coercion; `packages/schema/tests` (71) cover the validator subset, unsupported-keyword rejection, every published example, BUY/SELL unit and position agreement, decimal/price/address patterns, and byte-for-byte artifact drift. `tests/workspace.test.ts` additionally fails if a contract command is not backed by an AVAILABLE capability, so the contract cannot advertise what no surface runs. |
| 1.3 | Consistent JSON envelope, symbolic error codes, exit codes | DONE | `packages/cli/src/{envelope,exit-codes,errors}.ts`; `packages/cli/tests/envelope.test.ts` (13). Exactly one parseable document on stdout on every path including an unresolvable command; usage prose on stderr only; the exit code derived from the server's own symbolic code rather than the HTTP status; `retryable` copied from the server, never re-derived. The code table is published by `describe` so a host need not hard-code it. |
| 1.4 | `describe` | DONE | `packages/cli/src/commands/describe.ts`; `packages/cli/tests/discovery.test.ts` (14). Answers with no configuration, no signer and no network. Reports the policy in force, its source, and that an approval token **is not authentication**; reports `signer.canSignTransactions` from the policy rather than from intent. `serverCapabilities.source` is `STATIC` — this build's own claim, not something the server advertised (3.3/B7 is still blocked), and it is labelled as such rather than presented as negotiated. |
| 1.5 | `doctor` | DONE | `packages/cli/src/commands/doctor.ts`; `packages/cli/tests/doctor.test.ts` (7). Config, signer, reachability, authentication, catalog read, allowance read, and `writePlaneCheck`. The write-plane check never places an order — a diagnostic that trades is one nobody can safely run — so it SKIPs under `read-only` and `interactive`, and under `delegated-auto` it FAILs the one write-blocker knowable without trading: a scope whose `notAfter` has already passed. A check that could not run is SKIP, never PASS, and the command exits with the **first failing check's own code** so a rejected token exits 4 rather than 70. Signs the login challenge as a personal message only. |
| 1.6 | `market` / `account` / `order` commands | DONE | Read plane: `market list/get/quote` and `account status/allowance/positions/executions/fills` (`packages/cli/tests/read-plane.test.ts` (15), `input.test.ts` (16)). Write plane: `order preview/execute/execute-many/get/reconcile` (`packages/cli/src/commands/order.ts`, `packages/cli/tests/write-plane.test.ts` (34)) — an ambiguous intent (wrong unit for the side, both units, neither, a SELL naming no position, a BUY naming one) is refused with exit `INVALID_INPUT` (2) and **zero network and signer calls**, because guessing the unit trades the wrong thing; a timed-out wait is `ok: true` with exit `AMBIGUOUS` (11) plus a reconcile instruction, never a resubmission; `execute-many` legs succeed, fail and skip independently and the envelope says `atomic: false`. `market search`, `market history` and `order cancel` are refused by capability negotiation with a symbolic reason and **zero network calls**. Durable/conditional order commands are 2.8, not this item. |
| 1.7 | `order preview` as a first-class command | DONE | `packages/cli/src/commands/order.ts` (`runOrderPreview`); `write-plane.test.ts`. Resolves the market server-side, mints a fresh quote, normalizes the leg, computes the price-protection bound (`CEILING` for BUY, `FLOOR` for SELL) and the effective worst price, runs the same policy engine `execute` runs, and returns the approval token with the exact `--approve …` string. Signs nothing and places nothing. Effective **risk limits** are still unreadable by an agent credential, so `riskLimits.available` is `false` with the reason attached rather than a synthesized number (B1). |
| 1.8 | Signer provider interface + keystore/keychain/KMS | PARTIAL | ADR-0001 §7. The **external-command** provider exists and is the CLI's only one: `packages/cli/src/signer.ts`, `packages/cli/tests/signer.test.ts` (21). No key enters the process; the request is versioned and typed, so `PERSONAL_MESSAGE` and `TRANSACTION` are distinguishable by the key holder and never interchangeable; a non-zero exit, non-JSON stdout, a missing `signature` or a timeout is `SIGNER_FAILED`, never a fabricated signature. `signTransaction` throws before a child process is spawned under `read-only`, and otherwise spends a permit from the `SigningGate` **before** the child runs, so a write path reached without an authorization runs out of permits rather than signing. **Keystore, keychain and KMS providers are not built.** |
| 1.9 | Automatic re-auth preserving key and exact bytes | DONE | `packages/sdk/src/session.ts`, `packages/sdk/src/transport.ts:89`, `packages/sdk/src/errors.ts:isUnauthenticated`; `packages/sdk/tests/reauthentication.test.ts` (14) covers replay under a fresh token with identical bytes and key, a token dying between create and submit, five concurrent 401s minting one session, the bound (one re-auth, then the error), a fresh signed challenge per mint, pre-expiry rollover, `autoReauthenticate: false`, and the rejections it must **not** retry (`403 DELEGATION_REVOKED`, `401 SIGNATURE_INVALID`, `409 IDEMPOTENCY_KEY_REUSED`). At the SDK layer only — 1.8's signer provider still gates the CLI/Runner path, where the challenge is signed outside this process. |
| 1.10 | Secret redaction across stdout, logs, errors, job store | PARTIAL | CLI streams DONE: `packages/cli/src/redact.ts`, `packages/cli/tests/secrets.test.ts` (7), plus the write-plane case that asserts no signature, transaction bytes or token reaches either stream on a successful order. Registered secrets are replaced on the serialized stdout document *and* on every stderr line, including when the server echoes a token back inside its own error message; a credential-shaped config file key is refused naming the key and never the value; the signer is reported by executable base name only. **No job store exists to redact** (2.5). |
| 1.11 | Testnet quickstart + real E2E | TODO | 1.1–1.9 |

On 1.2 and what it does **not** mean: `schemas/v1/agent-commands.json` describes
sixteen commands, and the CLI now runs all sixteen — but describing a command is
still not running one, and the guarantee comes from a test rather than from this
sentence. `tests/workspace.test.ts` fails if any contract command lacks an
AVAILABLE capability in `packages/cli/src/capabilities.ts`, so the contract
cannot drift back into advertising an intent no surface performs.

The v1 command set covers only what a surface can actually perform. `describe`,
`doctor` and `command-schema` are in it under an `implementation` union whose
`runtime` arm marks a command the runtime answers locally rather than through an
SDK method (ADR-0006). `market search`, `market history` and `order cancel` are
**absent on purpose**: a command entry is precisely what an adapter turns into an
advertised, callable tool, so listing one would present a capability that does
not exist. All three are refused by name at the CLI with a symbolic reason and no
network call, so an agent asking for them gets an answer instead of silence.

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
duplicate execution.

## 4. Phase 2 — streaming and durable strategies

| # | Item | Status | Depends on |
| --- | --- | --- | --- |
| 2.1 | Backend quote WS | BLOCKED | 0.7 |
| 2.2 | Native execution stream client (replaces the SEAM) | TODO | Backend gateway exists (`predict-agent-stream.gateway.ts`, Socket.IO namespace, cursor + `gap` flag). Needs a Socket.IO runtime dependency — justify per `AGENTS.md`. |
| 2.3 | Native quote stream client | BLOCKED | 2.1 |
| 2.4 | Gap detection, cursor persistence, REST reconciliation | PARTIAL | Contract carries `cursor` and `gap` (`packages/sdk/src/contract.ts:450`–`:475`) and terminal state is always REST-confirmed. Cursor persistence across restart needs the durable store. |
| 2.5 | SQLite/WAL durable job store behind a store interface | TODO | ADR-0001 §8 |
| 2.6 | Runner daemon + local IPC | TODO | 2.5, 1.8. Unix domain socket; no Windows fallback in beta (ADR-0002). |
| 2.7 | Policy engine: `interactive` / `delegated-auto` / `read-only` | PARTIAL | ADR-0001 §9. Implemented and enforced for **one-shot CLI writes**: `packages/cli/src/policy.ts`, `packages/cli/tests/write-plane.test.ts` (34) + `signer.test.ts`. `--policy` may only narrow, never widen; `read-only` is enforced inside the signer; `delegated-auto` requires a file-only scope with mandatory per-order and per-run ceilings, an allow-listed account, side and market, and an unexpired `notAfter`, and every local check runs **before** any network read so an out-of-scope order costs nothing. The gap: no daemon-side policy and no policy evaluated across a durable job's lifetime (2.5, 2.6) — a scope is checked at invocation, and there is nothing yet that could check it an hour later. |
| 2.8 | `strategy create / get / list / cancel / events` | TODO | 2.5, 2.6 |
| 2.9 | `PAUSED` handling and terminal market lifecycle | TODO | ADR-0004 |
| 2.10 | Mandatory `expiresAt`, 7-day cap, no extension | TODO | ADR-0005 |
| 2.11 | Frozen-share percentage SELL; dynamic fraction as a distinct mode | TODO | ADR-0001 §13 |
| 2.12 | Restart / kill / network-partition tests | TODO | 2.5, 2.6 |
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
| 3.4 | Quote-to-fill deviation, WS latency, reject-reason dashboards | BLOCKED (backend) |
| 3.5 | Thin-market large-size and high-subscription load tests | TODO |
| 3.6 | npm provenance, SBOM, upgrade/rollback docs, beta support policy | TODO — also gates publishing `@waterx/predict-agent-cli`, which is `private` today |

## 6. Backend dependencies

Ordered by what blocks the most SDK work.

| # | Capability | Status | Blocks |
| --- | --- | --- | --- |
| B1 | Agent-readable effective risk limits | TODO | Degrades 1.7 — ADR-0003. Risk profile is owner-only today (`predict-agent-owner.controller.ts`, `WaterXAuthGuard`), so `order preview` returns `riskLimits.available: false` with the reason rather than a number, and `account risk-limits` refuses. Sizing falls back to `effectiveBuyCapacity`, which is real but is not the limit. |
| B2 | Market search / aliases for server-side resolution | TODO | Natural-language resolution. `ListMarketsQuery` supports `limit`, `category`, `status`, `tradeable`, `updatedAfter` — **no text search** (`packages/sdk/src/contract.ts:565`). Without it an agent cannot resolve "tonight's A vs B BTTS" without client-side guessing, which ADR-0001 §10 forbids. |
| B3 | Quote WS: snapshot + monotonic sequence + gap + SLO | TODO | 2.1, 2.3, 3.3 |
| B4 | Machine-readable tradeability reason code (closed set) | TODO | 2.9 — ADR-0004 §8. `tradeabilityReason` is free text today. |
| B5 | Size-aware executable quote | TODO | Honest large-size preview. Today `availableSize`, `expectedFillSize`, `feeAmount` are null and `qualityFlags` carries `TOP_OF_BOOK_ONLY`. |
| B6 | Cursor pagination for executions / fills / positions | TODO | Complete history reconstruction. `limit` only today. |
| B7 | Server capability advertisement | TODO | 3.3 |
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
  `packages/runner` existing does not advance 2.5 or 2.6.
- A command in `schemas/v1/agent-commands.json` describes an intent; it is not
  evidence that a surface can execute it. Only add one when the execution core
  can perform it.
- When an item moves, update the evidence column with a real path or test name.
  An item with no evidence is not DONE.
