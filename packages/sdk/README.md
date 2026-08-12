# @waterx/predict-agent-sdk

TypeScript client for the **WaterX Predict Agent Trading API** — quotes, protected
market orders, positions and allowance for autonomous strategies.

**Zero runtime dependencies.** Global `fetch` for HTTP, `node:crypto` for
idempotency keys, and a structural signer interface a Sui `Keypair` already
satisfies. Nothing here touches the chain: the backend builds every PTB, so you
are not pulling Move bindings or a protocol SDK into your process.

> Status: **0.1.0, pre-release.** The API it targets is gated off by default on
> the server side. See [Not implemented yet](#not-implemented-yet) before planning
> around it.

## Install

```bash
pnpm add @waterx/predict-agent-sdk
```

## Quick start

```ts
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { PredictAgentClient } from '@waterx/predict-agent-sdk';

// A Sui Keypair satisfies AgentSigner structurally — no adapter needed.
const signer = Ed25519Keypair.fromSecretKey(process.env.AGENT_SECRET_KEY!);

const client = new PredictAgentClient({ baseUrl: 'https://api.waterx.app', signer });
await client.authenticate();

// Quotes live ~3 seconds and are never extended — fetch immediately before ordering.
const quote = await client.getQuote({
  marketId: '0x…', // on-chain market id
  outcomeId: 'YES',
  side: 'BUY',
  size: { buyAmount: '50' }, // decimal STRING, never a number
});

const result = await client.executeMarketOrder(
  {
    accountId: '0x…',
    marketId: quote.marketId,
    outcomeId: quote.outcomeId,
    side: 'BUY',
    size: { buyAmount: '50' },
    referenceQuoteId: quote.quoteId,
    maxSlippageBps: 100, // 1%
  },
  { waitFor: 'TERMINAL', timeoutMs: 60_000 },
);

if (result.terminal && result.status === 'FILLED') {
  console.log(result.fill?.filledShares, result.remainingAllowance);
} else if (result.timedOut) {
  // Still live on chain. Reconcile later by id — never resubmit.
  await saveForReconciliation(result.executionId, result.idempotencyKey);
}
```

`executeMarketOrder` hides the API's three steps — create, sign the returned
sponsored bytes, submit — behind one await.

## The things that will bite you

**Money is a decimal string, never a number.** A JS `number` cannot hold 6-dp
money exactly. `'50'`, not `50`.

**Idempotency.** One key is generated per `executeMarketOrder` call and reused
across every internal retry, so a timeout mid-create resolves to the original
execution instead of placing a second order. That guarantee dies with the process:
to survive a restart, generate and persist the key yourself.

```ts
const idempotencyKey = crypto.randomUUID();
await savePendingIntent(idempotencyKey, intent); // your durable store
await client.executeMarketOrder({ ...intent, idempotencyKey });
```

**A timeout is not a failure, and it does not throw.** A `waitFor: 'TERMINAL'`
wait that runs out of time **returns** with `timedOut: true` and the last observed
status. The order is on-chain and a keeper may still fill it — the SDK just stopped
watching. Resume with `waitForExecution(executionId)` (or `getExecution`); never
assume it did not happen, and never resubmit under a fresh key.

```ts
const result = await client.executeMarketOrder(intent, { waitFor: 'TERMINAL' });
if (result.timedOut) {
  const settled = await client.waitForExecution(result.executionId, { timeoutMs: 300_000 });
}
```

**Settlement facts exist only on a terminal read.** `SUBMITTED` is a request a
keeper fills asynchronously, so `fill` and `remainingAllowance` are `undefined`
until the execution is terminal. Undefined is *unknown*, never zero — booking a
`SUBMITTED` result as a trade books shares nobody bought.

| Field | Meaning |
| --- | --- |
| `terminal` | The status can no longer change without a new request |
| `timedOut` | The SDK stopped waiting; the order is untouched |
| `fill` | Authoritative `filledAmount` / `filledShares` / `avgFillPrice`, once observed |
| `fee` | See below |
| `remainingAllowance` | Spendable API allowance *after* settlement, or `undefined` |

`fee` is a discriminated union, not a nullable number, because the two absences
are different facts and neither is zero:

```ts
if (result.fee.available) {
  net = subtract(result.fill!.filledAmount, result.fee.actualFee);
} else if (result.fee.reason === 'EMBEDDED_IN_PRICE') {
  // Settled, and the broker's published price is already fee-adjusted:
  // the cost is inside filledAmount, not missing from it.
} else {
  // NO_FILL_OBSERVED — nothing settled (yet, or ever, for a rejection).
}
```

`remainingAllowance` is also `undefined` for an agent with no risk profile. It is
omitted mid-flight on purpose: the reservation is held but not yet spent, so any
figure reported then would be neither the before nor the after.

**Retries follow the server, not a local table.** Every error carries
`retryable`; this SDK retries only what the server marks transient, and only for
requests that are safe to repeat.

```ts
import { isPredictAgentApiError } from '@waterx/predict-agent-sdk';

try {
  await client.executeMarketOrder(intent);
} catch (error) {
  if (isPredictAgentApiError(error) && error.code === 'SLIPPAGE_EXCEEDED') {
    // Re-quote and decide again. Do not blindly loop.
  }
}
```

**Quotes are size-blind today.** `availableSize`, `expectedFillSize` and
`feeAmount` are `null`, and `qualityFlags` carries `TOP_OF_BOOK_ONLY`. Your price
*is* protected (`price_cap` is enforced by the contract), but a large order may
fail to **fill** — arriving later as `CANCELLED`. Size accordingly.

**A SELL needs `positionId`, and `sellShares` may not exceed the holding.** The
API rejects an oversized request rather than silently trading less than you asked
for.

**`enforcedWorstPrice` may be stricter than you asked for.** The contract's price
granularity is coarser than the wire format's, and rounding always favours you.

**`executeMany` is not atomic.** Each leg has its own execution, key, quote and
protection. `failurePolicy: 'STOP'` stops *launching* further legs; it cannot
cancel or roll back one already submitted.

```ts
const results = await client.executeMany(intents, { concurrency: 3, failurePolicy: 'STOP' });
for (const entry of results) {
  if (entry.ok) continue;
  if ('skipped' in entry) { /* never launched — safe to resubmit */ }
  else { /* attempted and failed — inspect entry.error */ }
}
```

## API

| Method | Notes |
| --- | --- |
| `authenticate()` | Signs the server's challenge, opens the session |
| `getQuote(request)` | ~3 s lifetime, never extended |
| `executeMarketOrder(intent, options?)` | create → sign → submit; optional terminal wait |
| `executeMany(intents, options?)` | Independent legs, bounded concurrency |
| `waitForExecution(id, options?)` | Wait for terminal facts; also the reconciliation entry point |
| `getExecution(id)` | Poll one execution |
| `listExecutions(accountId, limit?)` | Your order history on that account |
| `getPositions(accountId, limit?)` | Positions you opened, with cost basis |
| `getAllowance(accountId)` | API allowance, real balance, and the binding minimum |

`getAllowance` reports `apiAllowance` and `accountSpendableBalance` separately
because a direct-chain spend moves one without the other. Size against
`effectiveBuyCapacity`, which is the smaller.

> The API allowance is a WaterX **API policy**, not a protocol guarantee. A
> delegated key can bypass it by submitting directly to Sui. On-chain delegation
> revocation and the contract's price guards are the authoritative controls.

## Sessions and re-authentication

Opening the first session is always explicit — `authenticate()`, or a `token` you
pass in. After that the client keeps it alive on its own: when the server rejects
the token with `401 UNAUTHENTICATED`, it signs a **fresh** challenge and replays
the rejected request once. A token it minted itself is also rolled over just
before it expires.

The safety properties, since this fires in the middle of orders:

- **The replay is the same logical write.** Identical bytes, identical
  `Idempotency-Key`. A token dying between create and submit cannot become a
  second order.
- **One login, not one per request.** Concurrent rejections join a single
  handshake, and a request whose token was already replaced by another in-flight
  refresh reuses that one instead of minting again.
- **Bounded.** At most one re-authentication per request; a server that keeps
  rejecting produces an `UNAUTHENTICATED` error, never a login loop.
- **Narrow.** Only `401 UNAUTHENTICATED` triggers it. `SIGNATURE_INVALID`,
  `DELEGATION_REVOKED` and `IDEMPOTENCY_KEY_REUSED` are not token problems and a
  new token would not fix them, so they surface unchanged.

```ts
// Opt out and handle expiry yourself.
new PredictAgentClient({ baseUrl, signer, autoReauthenticate: false });
```

## Synthetic limit orders

`waitForPriceAndExecute` watches the price and fires **one** protected order the
moment your target is met. It is SDK-side by design: the server stores no target
and no conditional order, so nothing can fire while your strategy is not running.

```ts
await client.waitForPriceAndExecute(
  {
    accountId: '0x…',
    marketId: '0x…',
    outcomeId: 'YES',
    side: 'SELL',
    size: { sellShares: '100' },
    positionId: 'pos-1',
    targetPrice: '0.70', // SELL: a FLOOR. BUY: a CEILING.
    maxSlippageBps: 100,
    idempotencyKey: myPersistedKey, // makes the whole wait restart-safe
  },
  { pollIntervalMs: 1_000, waitTimeoutMs: 3_600_000 },
);
```

Direction is not symmetric: a **BUY** target is a ceiling (fire when the ask falls
to it), a **SELL** target is a floor (fire when the bid rises to it).

When the target is hit, the SDK takes a **fresh quote** and **re-checks the target
against it** before ordering — the sample that triggered is up to one interval old
and is never what the order is priced against. If the market moved back in that
window, it keeps waiting instead of firing on a price that no longer qualifies.

Exactly one order is ever submitted: an in-process latch plus one idempotency key
minted before the loop starts. On expiry it throws `EXECUTION_TIMEOUT` having
submitted **nothing** — the one timeout that still throws, precisely because there
is no execution to reconcile. Once an order exists, a timeout is returned as
`timedOut`, never raised.

### Price source

Today it polls `POST /quotes`, which is the only price source an agent can reach.
Spec §16.1 wants a sequenced quote stream with gap detection instead, but §21.3
notes the feed behind it is a ~2 s poll that "cannot reliably satisfy the WS P95",
and fixing that is upstream of this SDK. Supply your own `priceWatcher` to change
where prices come from — the trigger, re-verify and single-submission logic are
unaffected:

```ts
new PredictAgentClient({ baseUrl, signer, priceWatcher: myStreamWatcher });
```

## Execution stream

`waitFor: 'TERMINAL'` polls `getExecution` by default. Supply an `executionStream`
adapter and a wait reacts to pushed frames instead — one connection instead of a
request per second per execution:

```ts
new PredictAgentClient({ baseUrl, signer, executionStream: mySocketAdapter });
```

The seam exists because this package has no runtime dependencies and the server's
stream is Socket.IO; the adapter is yours to supply.

**A stream can only ever make a wait faster — it is never the answer.** Frames get
lost (the server's ready frame says `gap: true` when its replay cursor was too old)
and a socket can die without saying so, so the terminal state is always confirmed
with a REST read, and the poll interval stays a floor on liveness. A dead stream
therefore degrades to plain polling instead of hanging a strategy.

## Not implemented yet

- **Quote streaming** — see [Price source](#price-source). Blocked upstream: the
  feed behind it is a ~2 s poll that cannot satisfy the target latency, and fixing
  that lives outside this SDK.

## Signer

`AgentSigner` needs **two** signing methods, and they are not interchangeable:

- `signTransaction` — the sponsored order bytes.
- `signPersonalMessage` — the login challenge.

Sui prefixes signed bytes with an intent, so a personal message (scope 3) and a
transaction (scope 0) hash differently. The server verifies the challenge with
`verifyPersonalMessageSignature`; signing it as a transaction produces a
well-formed signature over the wrong bytes and every login is rejected. A
`Keypair` implements both, so passing one still just works — a KMS-backed signer
must route each to the right primitive.

## Wire contract

`src/contract.ts` is **vendored** from
`apps/waterx/src/predict/agent-api/agent-api.contract.ts` in `bucket-backend-mono`,
where the controllers are typed against it so a shape change fails that build. Keep
the two identical below the header comment. Every wire type is re-exported from the
package root.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```
