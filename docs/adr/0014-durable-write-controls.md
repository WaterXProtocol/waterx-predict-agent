# ADR-0014 — Write controls that outlive one invocation, and settlement from the chain

- Status: Accepted
- Date: 2026-09-17 (the owner asked for the gaps against the perp agent to be closed, in order)
- Decides: what an approval is, what a cumulative ceiling counts, which digest an
  order is kept under, and where direct mode reads an order's outcome
- Amends: the approval-token paragraph of `packages/cli/src/policy.ts` (ADR-0001
  §6.6), `DelegatedScope.maxCumulativeBuyAmount`, ADR-0013 §2–3
- Affects: `packages/cli`, `packages/sdk/src/direct`, `packages/sdk/src/sui-digest.ts`

## Context

Direct mode (ADR-0013) removed the server-side mandate. What was left bounding
an agent were two local controls, and both were weaker than they read:

1. **An approval was a digest of the intent.** Anything could compute it, it
   never expired, and it authorized every future order of the same shape: a new
   idempotency key under the same token was a second order.
2. **`maxCumulativeBuyAmount` counted one invocation.** A loop that called the
   CLI once per order was bounded by the per-order ceiling alone.

Two more gaps showed up when a real order was placed on testnet:

3. **The digest an order is journaled, submitted and reconciled under came from
   the backend.** A wrong one would steer the reconciliation to another
   transaction.
4. **Settlement came only from the backend's activity index.** The testnet
   index did not list the order, and the testnet keeper did not fill it. The
   order stayed `SUBMITTED` for good, while its 1 wxUSD escrow was held.

The perp agent (`waterx-agent`) keeps approvals as issued, expiring, single-use
records. This ADR does the same, and goes further on 2–4.

## Decision

### 1. An approval is issued, expires, and is spent once

- `order preview` issues `apv2_<intent digest>_<random>` into the approval
  ledger. The ledger is `write-ledger.json` in the state directory, mode
  `0600`, written atomically under an exclusive lock.
- The approval is valid for ten minutes.
- `order execute` / `execute-many` accept only a ledger-issued approval for
  exactly this intent. It must be unexpired and unspent.
- The approval is spent **after** every stateless check and **before**
  anything is signed. A write that fails later needs a new preview.
- A batch preview issues one approval, for the batch in order, and none per leg.
- With no state directory, no approval is issued. The preview says
  `APPROVAL_UNAVAILABLE`, and the write is refused `NOT_CONFIGURED`.

The token is still not authentication, and the result still says so. What
changed is that it authorizes one write, not a shape forever.

### 2. The cumulative ceiling counts the scope, across invocations

- Under `delegated-auto`, a BUY reserves its budget in the same ledger. The
  reservation is keyed by a digest of the configured scope and checked against
  `maxCumulativeBuyAmount` together with everything the scope already
  reserved.
- The reservation is returned only if the command signed nothing. A signed
  order whose fate is unknown counts.
- Changing the scope starts a new count. The person who can change the scope
  can raise the ceiling anyway, so this hides nothing.
- `order preview` reports a would-be excess as `DENIED`.

### 3. The digest is computed from the bytes

- Direct mode computes `base58(blake2b-256("TransactionData::" ‖ bytes))`. This
  is BLAKE2b per RFC 7693, implemented dependency-free and held to
  `@mysten/sui` and Node in tests.
- It refuses to sign (`TRANSACTION_REFUSED`, rule `DIGEST`) when the backend's
  digest differs.
- A `/sponsor/execute` answer naming another digest is treated as unanswered.
  The order is read back by its own digest.

### 4. The registry decides an order's state before the index does

For a landed submission, direct mode reads the order ids from the
transaction's own events: `OrderPlaced`, and `CloseRequested` with the position
it closes. The events are filtered to the deployment's original prediction
package and its USD registry. It then reads the registry tables through Sui
GraphQL:

| Registry says | Outcome |
| --- | --- |
| order in `orders`, before `expiry_ts + KEEPER_FILL_GRACE_MS` (300 s) | `PENDING_FILL`, with `openOrder` |
| order in `orders`, after it | **`EXPIRED`**, terminal. No fill can be reported; the escrow is held until a cancel (`openOrder.cancellableAfter`) |
| buy in `position_id_by_order` | `FILLED`, with shares and cost from the position (or the feed's fill, which names the keeper transaction) |
| close order gone, its position gone | `FILLED` |
| close order gone, its position still there | `CANCELLED` |
| buy order gone | the feed decides; silence stays non-terminal |

- A failed chain read is never evidence. The index is used as before.
- An index that fails no longer fails the read when the chain can answer.
- `order get` / `reconcile` / `execute` report an expired order's held escrow
  under `refund`. This agent places no cancels: the owner cancels in the app, or
  a delegate does if granted the cancel bit.

## Consequences

- **The CLI's approval contract changes in both modes.**
  - A token from an older build is refused.
  - `policy.approvalToken` appears only under `interactive`.
  - `policy.intentDigest` always appears.
  - The refusal names `order preview` instead of a token.
- **The ledger is not a boundary against a process running as this user.** Such
  a process can edit the ledger, as it can edit the config. That is stated
  where the ledger is defined.
- **Two invocations contend on one lock.** A lock older than 30 s is taken over.
  A live lock is waited on for 5 s and then refused as `TIMEOUT`.
- **Settlement no longer needs the index, except for a buy whose order is
  gone.** That case needs a fill or cancel transaction, and finding one needs an
  index.
- **Escrow recovery still needs a cancel route.** Recovering an expired order's
  escrow from the agent needs a backend build route for `self_cancel_order` and
  the cancel bit in the owner's grant. Both are outside this repository.
