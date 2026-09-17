# ADR-0016 — The Runner trades in direct mode too

- Status: Accepted
- Date: 2026-09-17 (the owner asked for the gaps against the perp agent to be closed, in order)
- Decides: how `runnerd` reaches WaterX, and what its preflight and price watch
  read when there is no Agent API
- Amends: ADR-0013 ("the Runner is still an Agent API client"), ADR-0001 §8
- Affects: `packages/runner` (`config`, `runtime`, `prices`, `strategy/preflight`,
  `strategy/gateway`), `packages/sdk/src/direct` (`createExecution`,
  `submitExecution`, `getDelegation`, `FileMarketCatalog`, the live market phase)

## Context

ADR-0013 moved the CLI to direct mode and left the Runner on the Agent API.
Mainnet's Agent API is switched off, so an armed strategy could never trade
there, while a one-off order from the same machine could. The perp agent's
Runner drives the same direct path its CLI uses.

The Runner's design already fits direct mode. It splits a write into a create
and a submit, and persists the execution id between them. In direct mode that
id names the transaction digest before anything is signed.

## Decision

### 1. `mode` and `network` in the Runner config

- **The settings.** `WATERX_RUNNER_MODE` / file key `mode` is `direct` by
  default, or `agent-api`. `WATERX_RUNNER_NETWORK` / `network` is `mainnet` or
  `testnet`, and can be inferred from the two WaterX API hosts.
- **Missing network.** Direct mode on a host this build cannot name, with no
  network stated, is a driver gap (`network`). The daemon then answers and
  recovers but drives nothing, like every other gap.

### 2. The direct gateway

`buildRunnerDriver` builds `PredictDirectClient` for `mode: direct`. The
client's own signer refuses everything: the only signature is the Runner's
policy-bound signer's, as before.

| Gateway call | Direct mode |
| --- | --- |
| `createExecution` | Builds through the public route and verifies it: digest, contract shapes, every argument (ADR-0014/0015). Returns the bytes and a `dx1` id naming their digest. `signatureExpiresAt` is 10 s before the order's own expiry. A second create builds a fresh transaction; the unsigned first one can never execute. |
| `submitExecution` | `/sponsor/execute` with the signature. A definitive 4xx is thrown as the server's error. Anything that may have executed is thrown as a transport error, for the reconciler to read back. |
| `getExecution` | The chain-first read of ADR-0014. |
| `getMarket` | The public board, plus the market's own page for the live round phase. A round that is no longer the market's current one is `CLOSED`, so ADR-0004 ends the job. |
| `getEffectiveLimits` | The on-chain delegation only (`getDelegation`), with `limits: null` and no blockers. A failed read throws. |
| `mandate` | `NONE`. Preflight checks the delegation and does not pause for a mandate that cannot exist. The job's policy snapshot and the signer's re-check remain the ceiling. |

### 3. Prices are polled

There is no public quote stream, so `PollingPriceObserver` reads the watched
market's board at most once per 5 s per topic. It keeps the observer contract:
a failed read, a closed market or a missing side is `null` ("nothing
observed"), never a price that failed the trigger. Orders are still priced
from a fresh quote.

### 4. One market catalog

`FileMarketCatalog` moves into the SDK. The Runner reads the CLI's file
(`$WATERX_PREDICT_STATE_DIR` or `~/.waterx-predict/direct-markets.json`) and
re-reads it when it meets an id it does not know. A market resolved by the
CLI after the Runner started is still found.

## Consequences

- **Direct mode is the Runner's default,** matching the CLI. An operator who
  runs the Runner against the Agent API sets `mode: agent-api`.
- **No server mandate means the Runner's own limits are the only ceiling.** A
  strategy in direct mode is bounded by its job policy (`maxOrderNotional`,
  `notAfter`, checked again by the signer) and by the owner's delegation.
- **More public reads.** Price watching costs one board read per watched topic
  per 5 s. That is the price of not having a stream.
- **Not yet exercised against a live keeper.** The testnet keeper did not fill
  orders on 2026-09-17, so a strategy's fill path is covered by tests only.
