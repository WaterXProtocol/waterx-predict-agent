# @waterx/predict-agent-sdk

TypeScript client for the **WaterX Predict Agent Trading API** — quotes, protected
market orders, positions and allowance for autonomous strategies.

**One runtime dependency.** Global `fetch` for HTTP, `node:crypto` for
idempotency keys, and a structural signer interface a Sui `Keypair` already
satisfies. Nothing here touches the chain: the backend builds every PTB, so you
are not pulling Move bindings or a protocol SDK into your process. The one
dependency is `socket.io-client`, which the server's stream protocol requires — it
is loaded lazily, so nothing but [the execution stream](#execution-stream) pays
for it.

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
| `listExecutions(accountId, page?)` | Your order history on that account, newest first |
| `getFills(accountId, page?)` | Filled executions only, by fill time |
| `getPositions(accountId, page?)` | Positions you opened, with cost basis |
| `getAllowance(accountId)` | API allowance, real balance, and the binding minimum |
| `getEffectiveLimits(accountId)` | The mandate: limits, window usage, delegation, blockers |
| `searchMarkets(query)` | Free text → one market id, **resolved server-side** |

`getAllowance` reports `apiAllowance` and `accountSpendableBalance` separately
because a direct-chain spend moves one without the other. Size against
`effectiveBuyCapacity`, which is the smaller.

`getEffectiveLimits` is the mandate itself, and it is **read-only** — an agent
credential can see its limits and can never raise them. `limits: null` means no
owner granted this agent a risk profile; that is denial, not an unlimited
default. A `null` delegation permission means the on-chain read **failed**, which
is not the same as `false`.

`searchMarkets` sends the text and returns the server's `resolution` unchanged.
`marketId` is non-null only when exactly one market matched, and `matchCount` is
counted over the whole filtered catalog before `limit` truncates the page — so a
page of one is never a unique answer. The client does not match, score or
tie-break locally: against a server too old to answer with a `resolution` it
reports `NOT_FOUND` rather than inferring an id. Candidate order is a
reproducible tie-break, not a ranking of which market is worth trading.

### Paging the account history

`listExecutions`, `getFills` and `getPositions` take `{ limit?, cursor? }` and
answer with `nextCursor`. Paging is **keyset**, anchored on a row rather than an
offset or a timestamp, so a page boundary does not shift when new executions land
at the head mid-walk — an offset would silently repeat or skip rows there.

`nextCursor` is three-valued and the three must stay apart:

| Value | Meaning |
| --- | --- |
| a string | Pass it as `cursor` for the next page |
| `null` | Provably exhausted — the server read one row past the page and found none |
| absent | The server predates keyset paging. **Unknown**, not finished |

`hasMorePages(response)` returns `true | false | null` for exactly those three,
and `isExhausted(response)` is true only on an explicit `null`. A reconstruction
that must be complete should treat `null` as a failure to answer.

A cursor is opaque, is minted for one list, and is **refused** — `INVALID_INPUT`,
not ignored — if it is malformed, edited, minted for a different list, or names a
row belonging to another agent. A silently-ignored cursor restarts the page at
the newest row, and a caller walking backwards would then count that page twice.
The market catalog is deliberately limit-only: `market list` has no cursor, and
sending one is rejected rather than dropped.

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

Today it polls `POST /quotes`. The server now also publishes a sequenced quote
stream on the agent socket (`predict.quotes.*`: snapshot on subscribe, `seq` per
connection and topic, `gap: true` on a resume, 15 s heartbeat) and this package
vendors its types — but **no client here speaks it yet**, so nothing in this SDK
gets prices from it.

It would not buy latency in any case. The server has no upstream push: it re-reads
a cache every ~2 s behind a publisher on a ~5 s cadence, which is why every stream
frame carries `POLLED_UPSTREAM` and its own freshness facts. What a stream buys is
*requests* — one connection instead of one quote call per tick — and a value that
is explicitly `stale` instead of a silently old one. Supply your own `priceWatcher`
to change where prices come from; the trigger, re-verify and single-submission
logic are unaffected:

```ts
new PredictAgentClient({ baseUrl, signer, priceWatcher: myStreamWatcher });
```

## Execution stream

`waitFor: 'TERMINAL'` polls `getExecution` by default. Ask for the stream and a
wait reacts to pushed frames instead — one connection instead of a request per
second per execution:

```ts
const client = new PredictAgentClient({ baseUrl, signer, executionStream: 'native' });
try {
  await client.executeMarketOrder(intent, { waitFor: 'TERMINAL' });
} finally {
  client.close(); // the client owns this socket
}
```

`'native'` opens the official `socket.io-client` against this client's base URL and
session — the one runtime dependency this package has, loaded with `await import`
so a caller that never streams never loads it. The seam is still there:
`executionStream` also accepts anything implementing `ExecutionStream`, and
`SocketExecutionStream` is exported for direct construction.

**A stream can only ever make a wait cheaper — it is never the answer, and it is
not necessarily faster.** The server publishes frames from a transactional outbox
on a ~5 s dispatcher tick, so a frame can arrive *later* than a 1 s poll would
have. Frames also get lost: the ready frame says `gap: true` when the replay cursor
was too old, and a socket can die without saying so. So the terminal state is
always confirmed with a REST read, the poll interval stays a floor on liveness, and
a dead stream degrades to plain polling instead of hanging a strategy.

### Surviving a restart

`executionStream: 'native'` keeps its replay cursor in memory, so a restart resumes
from *now* and the window it was down is covered by the REST poll. To replay that
window instead, construct the stream yourself and persist the cursor:

```ts
const stream = new SocketExecutionStream({
  baseUrl,
  token: () => session.token(),
  cursor: await store.readCursor(), // resume point from the last run
  onCursor: (cursor) => store.writeCursor(cursor),
  idleDisconnectMs: 30_000, // hold the socket between back-to-back waits
  onDegraded: (reason) => log.warn({ reason }, 'streaming stopped; polling'),
});
new PredictAgentClient({ baseUrl, signer, executionStream: stream });
```

The cursor only ever moves forward, so a replay that redelivers older frames cannot
rewind it. When the missed window is longer than the server's replay bound the
server serves nothing and flags `gap: true`; every waiter is woken to re-read over
REST, and so is every waiter on a plain reconnect, which loses frames just as
quietly without announcing it. After a bounded number of refused handshakes the
stream stops trying and calls `onDegraded` — a login loop against a server that has
already said no is worse than polling.

## Not implemented yet

- **Quote streaming** — see [Price source](#price-source). No longer blocked: the
  server protocol exists and its types are vendored in `src/contract.ts`. It is
  simply not built here, and a vendored type is not a capability. Note when it is
  built: the feed keeps no log, so a resumed subscription's snapshot is the entire
  recovery, `seq` must not be persisted, and a streamed price still has to be
  re-quoted through `POST /quotes` before it can be traded on.

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
