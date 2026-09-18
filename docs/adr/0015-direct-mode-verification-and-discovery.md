# ADR-0015 — Direct mode: pinned contract shapes, chain-side discovery, adoption, and a write probe

- Status: Accepted
- Date: 2026-09-17 (the owner asked for the gaps against the perp agent to be closed, in order)
- Decides: how direct mode notices a contract upgrade, finds a grant the backend
  index missed, keeps to one account, and proves its write path without trading
- Amends: ADR-0013 §3 (verification) and its account discovery
- Affects: `packages/sdk/src/direct`, `packages/cli` (`doctor`, `next`),
  `packages/schema` (`runtime.doctor.probeWrite`), CI

## Context

After ADR-0014, direct mode still differed from the perp agent (`waterx-agent`)
in four ways:

- **Contract upgrades.** Perp compares the deployed contract functions with a
  corpus captured from the chain and refuses what it does not describe. Our
  verifier binds arguments by position against `@waterx/sdk` 5.0.0, with
  nothing to notice an upgrade that moved one.
- **Discovery.** Perp falls back to the chain's grant events when the backend's
  delegation lookup fails. On testnet the lookup did not fail; it answered
  empty for a grant 75 minutes old. So the perp fallback would not have fired
  either.
- **Account choice.** Perp adopts an account only on an explicit command with
  an approver. Direct mode took up whichever single account was authorized, and
  would have moved silently to a different one.
- **Doctor.** Perp's `doctor` builds probe transactions without signing them.
  Ours said the write path could only be proven by a trade.

## Decision

### 1. The bound call shapes are pinned and checked before signing

- **The snapshot.** `direct/abi.ts` holds `BOUND_FUNCTIONS`: every function the
  verifier accepts (the order calls, the selection, `account::request`, and the
  deposit and mint legs), with its type-parameter count and parameter types.
  Package ids are written symbolically, as the waterx-config key of the
  package's original id. It was captured from mainnet and testnet, which agree.
- **The check.** Before the first signature against a set of current packages,
  the client reads each function at the package the verifier requires calls to
  target, through Sui GraphQL, and compares.
  - A difference refuses: `TRANSACTION_REFUSED`, rule `ABI`.
  - A failed read refuses as `DEPLOYMENT_UNAVAILABLE` and is asked again next
    time.
  - A passing verdict is kept for the life of the client.
- **Where else it runs.**
  - `doctor` reports it as `contract-shapes`.
  - `pnpm --filter @waterx/predict-agent-sdk abi:check` runs it against both
    networks.
  - `.github/workflows/abi.yml` runs that daily.
- **When the shapes change:** a new snapshot needs the verifier reviewed
  against the new positions. It is never regenerated blindly.

### 2. A grant the index does not list is looked for on the chain

- **When.** When `/account/delegated` lists nothing, or fails.
- **Where.** The client pages back through the account package's
  `DelegateAdded` / `DelegateUpdated` events: four pages of 50 each, at most
  20 candidates.
- **Verification.** Every candidate is re-read from its `account::Account`
  object before it counts. The object must be the deployment's type; this
  wallet must be a delegate; it must be unexpired; and its prediction mask must
  be keyed by the deployment's own `account_data::WaterXPrediction`.
- **Named accounts.** An account named by `WATERX_PREDICT_ACCOUNT_ID` or
  `--accountId` is always verified this way. Orders resolve the owner from the
  chain first.

### 3. The account in use is adopted, and changing it takes a name

- **Recording.** `next` records the first account it finds authorized under
  `adopted` in the write ledger (ADR-0014), keyed by network and agent wallet.
- **A different account later.** If a different account is authorized later
  and nobody named it, `next` answers `ACCOUNT_CHOICE_NEEDED` and hands over
  to the operator. It reads nothing on the new account.
- **Naming it.** Naming the account switches the record (`SWITCHED_BY_NAME`).

The first sighting is still adopted without a command. It is a grant the owner
made to this wallet, and unlike perp's, the setup has no separate approver to
ask. What changed is that a later account is never taken up silently.

### 4. `doctor --probeWrite` proves the build path

- **What it does.** In direct mode, with an account resolved, the backend
  builds a 1 wxUSD BUY on a tradeable market. It passes through exactly the
  code an order uses (`probeOrder` shares `buildVerified` with
  `executeMarketOrder`): the delegation pre-check, the build, the digest, the
  contract shapes and every argument.
- **What it does not do.** It signs nothing and submits nothing. It opens a
  sponsor session that expires unused.
- **Opt-in.** It runs only when asked, for that reason.

## Consequences

- **More chain reads.** Direct mode depends on Sui GraphQL for more than
  landing. A GraphQL outage now refuses orders instead of letting them through
  unchecked.
- **The fallback's range is bounded.** A grant older than the last 200 events
  of its kind, or on a mainnet busy enough to push it out, is found only by
  naming the account.
- **Adoption lives in the same ledger** as approvals and spend, with the same
  lock and the same limits.
- **Seen live on testnet (2026-09-17):**
  - `contract-shapes` PASS on both networks;
  - an unlisted grant found from events;
  - `doctor --probeWrite` PASS, with the backend's real bytes verified and
    unsigned;
  - an expired order reported `EXPIRED` with its escrow and cancel window.
