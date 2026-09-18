# ADR-0013 — Direct mode: trade the way the perp agent does

- Status: Accepted
- Date: 2026-09-17 (decided by the repository owner)
- Decides: how the `waterx-predict` CLI reaches WaterX Predict by default
- Supersedes: the "the CLI is a client of the Agent Trading API" half of
  ADR-0001 §1–4, for the CLI only
- Leaves unchanged: the command contract (ADR-0006), the execution policy,
  approvals and signer protocol, ADR-0003 (only the owner grants authority),
  ADR-0011 (mainnet by default), the Runner (still an Agent API client)
- Affects: `packages/sdk` (new `direct/`), `packages/cli`, docs
- Amended by: [ADR-0014](0014-durable-write-controls.md), [ADR-0015](0015-direct-mode-verification-and-discovery.md), [ADR-0016](0016-runner-direct-mode.md) (the Runner trades in direct mode too)

## Context

The Agent Trading API (`/agent-api/v1`) is deployed on mainnet and switched
off: it needs `PREDICT_AGENT_API_JWT_SECRET`, which nobody with the access has
set (backlog 3.12). The perp agent (`waterx-agent`) needs no such thing. It
calls the same public, unauthenticated tx-build routes the web app calls,
passes its own address as `delegateSender`, signs the sponsored bytes the
backend returns, and hands the signature to `/sponsor/execute`. The only
authority in that path is the owner's on-chain delegation, which the backend
pre-checks and the contract enforces.

Predict already has those routes (`POST /predict/bets/place`, `/sell`), with
the same delegate check (`assertPredictPermission`) and the same sponsorship.
The owner asked for the CLI to trade that way.

## Decision

### 1. The CLI trades in direct mode by default

`WATERX_PREDICT_MODE` (config `mode`) is `direct` unless set to `agent-api`.
Direct mode uses only public routes: the catalog (`/predict/browse`), live
quotes (`/predict/quotes*`), tx builds (`/predict/bets/place|sell`),
`/sponsor/execute`, positions and activity (`/predict/bets/me*`), and the
shared account routes (`/account*`). No session, no token, no login challenge.

The command contract does not change. A command direct mode cannot honour
answers `CAPABILITY_UNAVAILABLE` with the reason, never an approximation.

### 2. What the server enforced now happens here, and says so

| Agent API guarantee | Direct mode |
| --- | --- |
| Server-built, server-trusted bytes | **Every byte is checked before it is signed** (§3) |
| Risk profile: allowance, per-order, per-hour, in-flight | The CLI's execution policy: `interactive` (a person approves each intent) or a `delegated-auto` scope with per-order and cumulative ceilings. **Enforced in this process only.** The chain enforces the delegation, not an amount |
| Idempotency key held by the server | The durable intent store, keyed by the intent, holding the transaction digest **before** it is submitted |
| Execution records, reconciler, terminal state | Read back from the chain (the digest) and from the owner's activity feed (the order it opened, and whether it filled) |
| Re-quote at execution time | A fresh public quote per order; the price cap is derived from it and is what the chain enforces |

### 3. Nothing is signed that was not read

The bytes from `/predict/bets/place|sell` are decoded by a dependency-free
BCS reader (`packages/sdk/src/sui-tx.ts`, held byte-for-byte to `@mysten/sui`
in tests) and checked against the intent formed before the request left:

- the sender is this agent wallet, and gas is not paid by it;
- only `MoveCall` and `MakeMoveVec` commands — no transfers, splits, merges,
  publishes or upgrades; no owned-object or sender-funded withdrawal inputs;
- every call's package is the deployment's current `published_at` for the
  package it names (from waterx-config), and every call is on an allowlist:
  `account::request`, `position::selection_yes|no`, the one trading call, and
  the deposit-direction consolidation legs the backend prepends;
- the trading call's every argument is bound: shared objects by role, the
  account id (twice for a buy), the on-chain market bytes, the selection, the
  amount, the price cap, the minimum, the expiry, the clock, the settlement
  coin type;
- a sell's `min_proceeds` — chosen by the backend — must be no lower than the
  floor this client computes from its own bid read, and never zero.

What this does not defend against is stated in the module: a compromised
agent process can skip it, and the backend still composes the consolidation
legs it is allowed to.

### 4. Market identity is a handle the SDK composes from the catalog

Quotes are keyed by catalog round and side; orders by on-chain market. The
market id direct mode returns is `wxp1.<roundId>.<onchain market, base64url>.<YES side>.<NO side or ~>`
— built only from fields the server returned in the same response, never from
text, and decoded on the way back in. The agent still never constructs one.

### 5. The protection is the price cap

A buy's `priceCapBps` is the reference ask tightened by `maxSlippageBps` and
any `worstAcceptablePrice`, rounded so the enforced bound is never looser
than asked — the same arithmetic as the Agent API's `price-protection.ts`.
`minShares` follows from it. The web app sends no cap; this client always does.

## What this forbids

- Signing bytes that fail verification, for any reason, including a decoding
  gap. A new call the backend starts composing is a refusal until it is added
  here deliberately.
- A buy without a price cap, a sell whose floor is zero, or `maxSlippageBps`
  ≥ 10000.
- Reporting an order as placed before `/sponsor/execute` answered, or as
  filled before the activity feed says so.
- Retrying a submission whose digest is on file and unresolved.
- Presenting local policy ceilings as a server-side or on-chain limit.

## Consequences

- **The ceiling on spending is local.** A delegation grants "may place
  orders", with no amount. Unattended trading in direct mode is bounded only by
  the `delegated-auto` scope in this process; an owner who wants a limit the
  agent cannot bypass needs the Agent API's risk profile.
- **Positions are the owner's main account's.** `/predict/bets/me` resolves an
  owner address to its main account; direct mode refuses other accounts
  rather than report nothing.
- **Some reads have no public source**: allowance, effective limits,
  performance and fills answer `CAPABILITY_UNAVAILABLE` in direct mode.
- **The Runner is unchanged** and still requires the Agent API; `next` says so
  rather than arming strategies nothing can run.
- **Sponsorship is required.** A delegate cannot pay gas; if the backend
  cannot sponsor, the order is refused.
