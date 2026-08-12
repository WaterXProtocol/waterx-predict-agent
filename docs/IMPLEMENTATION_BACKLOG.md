# Implementation backlog

Derived from `docs/AGENT_INSTALLATION_AND_RUNTIME_PLAN.md` and constrained by
`docs/adr/`. This file is the only place that tracks what is **actually
implemented**. The plan describes the intended system; an ADR constrains how it
gets built; neither is evidence that anything works.

- Verified: 2026-08-12
- SDK: `codex/waterx-predict-agent-runtime` @ `a3bb7ee` plus this commit
- Backend: `codex/waterx-predict-agent-runtime` @ `201fc84` (untouched)
- SDK verification: `pnpm typecheck` clean, `pnpm test` 129/129 in 8 files
  (45 SDK, 69 schema, 15 workspace), `pnpm build` clean, `pnpm schema:generate`
  reproduces the committed artifact byte-for-byte.

The repository is now a pnpm workspace. `packages/sdk` is the SDK this file
tracked before the split; `packages/cli`, `packages/runner` and `packages/mcp`
are reserved boundaries with **no implementation** and must not be read as
progress on the items that name them.

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
were diffed in full at the commits above. They are identical apart from the
SDK-specific vendoring header (lines 2–8). No drift.

## 1. Current SDK state — verified

| Capability | Status | Evidence |
| --- | --- | --- |
| Personal-message auth + token handling | DONE | `packages/sdk/src/client.ts:207`, `packages/sdk/src/signer.ts` |
| Executable quote | DONE | `packages/sdk/src/client.ts:232` |
| Market catalog list + get | DONE | `packages/sdk/src/client.ts:502`, `packages/sdk/src/client.ts:517` |
| Protected market order (create → sign → submit) | DONE | `packages/sdk/src/client.ts:250` |
| Terminal wait + REST reconciliation | DONE | `packages/sdk/src/client.ts:419`, `packages/sdk/tests/client.test.ts` |
| Stable idempotency across retries | DONE | `packages/sdk/tests/client.test.ts` |
| Server-driven retry policy | DONE | `packages/sdk/src/transport.ts`, `packages/sdk/src/errors.ts` |
| Exact decimal comparison | DONE | `packages/sdk/src/decimal.ts`, `packages/sdk/tests/wait-for-price.test.ts` |
| `executeMany` independent legs + STOP/CONTINUE | DONE | `packages/sdk/src/client.ts:298` |
| Allowance / positions / executions / fills reads | DONE | `packages/sdk/src/client.ts:432`–`:476` |
| `waitForPriceAndExecute` in-process trigger | PARTIAL | `packages/sdk/src/client.ts:354`. Correct trigger, fresh re-quote, re-verify, one submission — but in-process only. Dies with the process; not durable. |
| Execution stream | SEAM | `packages/sdk/src/client.ts:126`. Interface only; caller supplies a Socket.IO adapter. Default path polls. |
| Quote stream | SEAM | `packages/sdk/src/client.ts:106`. Interface only; default polls `POST /quotes`. |
| Agent-readable effective risk limits | TODO | No client method. Backend exposes risk profile on the **owner** controller only (ADR-0003). |

## 2. Phase 0 — spec freeze and threat model

| # | Item | Status | Note |
| --- | --- | --- | --- |
| 0.1 | Adopt `AGENTS.md` + runtime plan | DONE | This commit. |
| 0.2 | ADRs for the remaining open decisions | DONE | ADR-0002 (D-05), ADR-0003 (D-13), ADR-0004 (D-18), ADR-0005 (D-22); ADR-0001 records the confirmed baseline. |
| 0.3 | Checked implementation backlog | DONE | This file. |
| 0.4 | Runner trust boundary + crash/replay threat model | TODO | Must cover: crash between idempotency-key persist and create; crash between create and submit; duplicate Runner instances on one job store; signer unavailable mid-job; clock skew vs `expiresAt`. |
| 0.5 | Job state machine specification | TODO | Including `PAUSED` (ADR-0004) and `UNKNOWN_PENDING`, and which transitions require a durable write **before** the side effect. |
| 0.6 | CLI command + schema prototype | PARTIAL | Schema half is done (1.2): commands, inputs and `sdkMethod` mapping are fixed and validated. The CLI half and the two-host discovery spike required by the plan's exit criteria are not started — nothing has yet issued the same intent through two hosts. |
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
| 1.2 | Versioned runtime command schema (single source of truth) | DONE | `packages/schema/src`, emitted to `schemas/v1/agent-commands.json`; ADR-0006. Ten commands, runtime-validated by `validateCommandInput` with no coercion; `packages/schema/tests` (69) cover the validator subset, unsupported-keyword rejection, every published example, BUY/SELL unit and position agreement, decimal/price/address patterns, and byte-for-byte artifact drift. |
| 1.3 | Consistent JSON envelope, symbolic error codes, exit codes | TODO | 1.2 |
| 1.4 | `describe` | TODO | 1.2, 3.3 |
| 1.5 | `doctor` | TODO | 1.2, signer provider. Signs a challenge with no funds effect only. |
| 1.6 | `market` / `account` / `order` commands | TODO | 1.2, 1.3 |
| 1.7 | `order preview` as a first-class command | TODO | 1.2, 3.3. Must surface effective limits, worst price, warnings, and whether execute is currently permitted — without signing. |
| 1.8 | Signer provider interface + keystore/keychain/KMS | TODO | ADR-0001 §7 |
| 1.9 | Automatic re-auth preserving key and exact bytes | TODO | 1.8. SDK holds a token today but does not re-authenticate on expiry. |
| 1.10 | Secret redaction across stdout, logs, errors, job store | TODO | 1.8 |
| 1.11 | Testnet quickstart + real E2E | TODO | 1.1–1.9 |

On 1.2 and what it does **not** mean: `schemas/v1/agent-commands.json` describes
ten commands, but describing a command is not running one. There is no CLI and no
adapter, so 1.6 stays TODO — the contract is the input side of it, and the JSON
envelope, exit codes and argument parsing in 1.3 are still open.

The v1 command set deliberately covers only what the execution core can perform
today. `describe` (1.4), `doctor` (1.5) and `order preview` (1.7) are absent from
the schema on purpose: a command entry is precisely what an adapter turns into an
advertised, callable tool, so listing them would present planned capability as
implemented. Adding a command to a versioned document is not a breaking change,
so each lands with its implementation.

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
| 2.7 | Policy engine: `interactive` / `delegated-auto` / `read-only` | TODO | ADR-0001 §9 |
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
| 3.6 | npm provenance, SBOM, upgrade/rollback docs, beta support policy | TODO |

## 6. Backend dependencies

Ordered by what blocks the most SDK work.

| # | Capability | Status | Blocks |
| --- | --- | --- | --- |
| B1 | Agent-readable effective risk limits | TODO | 1.4, 1.7 — ADR-0003. Risk profile is owner-only today (`predict-agent-owner.controller.ts`, `WaterXAuthGuard`). |
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
  `packages/cli` existing does not advance 1.6.
- A command in `schemas/v1/agent-commands.json` describes an intent; it is not
  evidence that a surface can execute it. Only add one when the execution core
  can perform it.
- When an item moves, update the evidence column with a real path or test name.
  An item with no evidence is not DONE.
