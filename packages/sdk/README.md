# @waterx/predict-agent-sdk

TypeScript client for the **WaterX Predict Agent Trading API** — quotes, protected
market orders, positions and allowance for autonomous strategies.

**One runtime dependency.** Global `fetch` for HTTP, `node:crypto` for
idempotency keys, and a structural signer interface a Sui `Keypair` already
satisfies. Nothing here touches the chain: the backend builds every PTB, so you
are not pulling Move bindings or a protocol SDK into your process. The one
dependency is `socket.io-client`, which the server's stream protocol requires — it
is loaded lazily, so nothing but [the execution stream](#execution-stream) and
[the quote stream](#price-source) pays for it.

> Status: **0.1.0, pre-release.** The API it targets is gated off by default on
> the server side, so confirm your account is enabled before planning around it.

## If you are an agent, read this first

This package ships the operating rules in its own tarball, so they are on disk
the moment it installs — no repository to find, no documentation site to fetch:

```
node_modules/@waterx/predict-agent-sdk/AGENT_INSTRUCTIONS.md
```

Thirty-two rules with symbolic ids, and a command table whose `SDK` column
names the method on this client for each one — or says which surface you would
need instead, because several commands are composed by the `waterx-predict` CLI
and the durable `strategy.*` family is driven by a local Runner process.

For the exact shape of a call, this package's own types are the contract. The
same contract is published as plain JSON in
`@waterx/predict-agent-schema/agent-commands.json`, for a surface that cannot
import a Node module — **this package does not depend on it**, so that file is
present only if you installed it as well.

Read it before the first order. Each rule corresponds to a refusal you would
otherwise meet with real money in flight — a JSON number where a decimal string
belongs, a `buyAmount` on a SELL, a timeout reported as a failure and retried
under a fresh key.

Then ask this installation what it still needs. It answers with nothing
configured, no network and no signer, which is the state you are in when the
question matters:

```bash
npx @waterx/predict-agent-sdk
```

Six things stand between a fresh install and an order, and they come from two
different people. Three are yours — which network, an agent wallet, and a signer
for it. Neither a hostname nor an account id is among them, by design. The other
three — an authorized account, an on-chain delegation and a risk profile — are
the account owner's, they are granted in one signature at the console, and
nothing in this package can provision them for you (ADR-0003).

**Once you have a client, ask it instead.** The offline report cannot settle the
owner's three, so it reports them `UNCHECKED`; `diagnose()` settles all six in
one authenticated call, and answers the question the offline one cannot:

```ts
const report = await client.diagnose({ label: 'momentum-bot' });

report.writes.permitted;   // true / false / undefined — undefined ONLY if the chain read failed
report.writes.gatedBy;     // 'ON_CHAIN_DELEGATION'
report.ready;              // may this agent place an order right now
report.limits;             // the mandate it would run under
report.authorizationUrl;   // present whenever the owner still has to act
report.nextStep;           // who acts next, and what they do
```

**What gates a write, since this is the thing most easily got wrong.** A write
made through this library reaches the API directly, and the API admits or
refuses it on the account owner's **on-chain delegation** and their risk profile
— `DELEGATION_REVOKED`, `DELEGATION_PERMISSION_DENIED`, `RISK_LIMIT_EXCEEDED`.

The `waterx-predict` CLI's execution policy is a different gate: `interactive`,
its per-intent approval token and its `POLICY_DENIED` refusal are enforced
inside that CLI's own process, over that process's own signer. `POLICY_DENIED`
is not in `PredictAgentErrorCode` and never reaches this wire. **So a
`waterx-predict` binary that is absent from PATH says nothing about whether this
agent may trade** — it says the composed commands are out of reach. Read
`writes.permitted` rather than inferring an answer from what is installed.

### Recipes: the scripts, already written

```
node_modules/@waterx/predict-agent-sdk/recipes/
```

`diagnose` · `onboard` · `markets` · `order` · `positions` · `reconcile`.
Runnable, `--json` on every one, and each is the whole of one job — including
the durable idempotency store, so nothing about a write has to be composed at
the terminal. Copy them into your project to edit them; see
[`recipes/README.md`](recipes/README.md).

### Loading this as a skill

`SKILL.md` ships beside the instructions: a trigger and a route, ~90 lines,
citing the rules rather than restating them. For a host that reads skills from
a project directory:

```bash
mkdir -p .claude/skills/waterx-predict
cp node_modules/@waterx/predict-agent-sdk/SKILL.md .claude/skills/waterx-predict/
```

For a host that reads a single project file, append it to `AGENTS.md`. For an
MCP client, none of this is needed — the adapter returns the full instructions
at `initialize`.

How far the skill takes it depends on the surface, and it says which. Through
the CLI or a tool adapter, the default `interactive` policy issues the approval
at the command core per order, a tool call cannot supply one, and the write is
refused `POLICY_DENIED` — there, the completed task is a previewed order and the
exact line a person runs to approve it. Holding only this library, that policy is
not running: the gate is the owner's on-chain delegation, `client.diagnose()`
reads whether it permits an order, and a permitted one is yours to place.

## Install

```bash
pnpm add @waterx/predict-agent-sdk
```

## Quick start

```ts
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { PredictAgentClient, createFileIntentStore } from '@waterx/predict-agent-sdk';

// A Sui Keypair satisfies AgentSigner structurally — no adapter needed.
// Where the key comes from is YOUR decision, and it is the load-bearing one on
// this page. See "Where the key lives" below before you copy this line.
const signer = Ed25519Keypair.fromSecretKey(await loadAgentSecretKey());

// Name the network. The host comes from the SDK — never type one.
// The intent store is what makes an idempotency key survive a restart; see
// "One intent, one key, across restarts" below for why you want one.
const client = new PredictAgentClient({
  deployment: 'testnet',
  signer,
  intentStore: createFileIntentStore('.waterx/intents.json'),
});
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

## Onboarding: what a person still has to do

Three things must exist before a write is accepted, and exactly one of them is
irreducibly human:

| | Who | Automatable |
| --- | --- | --- |
| Account id | the owner's | **Yes** — `listAuthorizedAccounts()` answers for it |
| On-chain delegation | the owner signs with their own wallet | **No**, and never (ADR-0003) |
| Risk profile (the mandate) | the owner | Yes, in the same signing session |

So the flow is: build a link that names this agent, hand it to the owner, poll
until the grants land. All three in one call:

```ts
await client.authenticate();

const onboarding = await client.startOnboarding({ label: 'momentum-bot' });
console.log(onboarding.url);          // hand this to the owner

const ready = await onboarding.wait({
  onChange: (state) => console.log(state.status, state.nextStep.action),
});
if (ready.status === 'READY') {
  // ready.account.accountId — nobody copied it out of a browser.
}
```

**Do the waiting.** Printing the link and stopping there turns one signature
into a conversation: the owner signs in another window, comes back to a dead
terminal, and has to tell the agent they are done before anything moves. The
poll costs a line and removes that entirely.

`buildAuthorizationUrl` and `waitForAuthorization` remain exported for a caller
assembling the flow differently — `startOnboarding` is the two of them plus the
console lookup, which is the combination almost everybody wants.

The link carries the agent's address and nothing else: no token, no secret, no
pre-authorization. Everything it can do, the owner does with their own wallet in
their own session, so it is safe to paste into a chat.

`describeOnboarding` is the same decision without the polling, and its statuses
are chosen so nobody is sent to do the wrong thing:

- `DELEGATION_MISSING` — the owner never signed. **They** must act.
- `DELEGATION_UNKNOWN` — the chain read failed. Retry; do **not** ask the owner
  to sign a grant they may already have made.
- `SUSPENDED` — the owner switched this agent off. Re-signing will not help.
- `AMBIGUOUS` — more than one account is ready, and choosing whose money a
  strategy trades is not this SDK's call.

A timeout is not a failure here either: the owner may sign a minute later, so the
result carries `timedOut` and the last state, and you resume by calling again.

## Naming a recurring market

`searchMarkets` resolves free text server-side and refuses to pick when more
than one market matches. For most markets that refusal is answerable by asking a
better question. For a recurring series it is not: twelve rounds of "BTC 5m Up
or Down" share a title and an alias set and differ **only** by when they close,
so every search answers `AMBIGUOUS` with twelve candidates and no phrasing
narrows them.

The expiry is the discriminator, and `resolveMarket` takes it:

```ts
const resolved = await client.resolveMarket({
  search: 'BTC 5m Up or Down',
  closesAt: '2026-09-02T08:15:00Z',   // the round you mean
  tradeable: true,
});

resolved.status;      // 'RESOLVED' — resolved.market.marketId is the id
resolved.narrowedBy;  // 'SERVER' if the catalog narrowed it, 'CLIENT' if this did
```

Supplying an expiry is you naming the round, not this SDK guessing an identity —
**given no expiry, an ambiguous answer passes straight through and nothing is
picked.** What comes back then is the candidates with their top of book already
spread, so a choice a person does have to make is one question with the prices
in it rather than an id list followed by a second question about what any of them
cost.

One limitation is reported rather than hidden. `matchCount` counts the whole
catalog and `markets` is one page of it, so when the page could not hold every
match a local narrowing cannot prove uniqueness: the result stays `AMBIGUOUS`
with `pageTruncated: true`, and the fix is a larger `limit`.

## What an order actually costs

`maxSlippageBps` bounds movement away from the quote. It does **not** protect
against the spread you cross to reach it, and on short-dated rounds the spread
is the dominant cost — a book at `0.4825 / 0.5275` is about 890 bps wide, so a
buy inside a 100 bps slippage bound still marks roughly nine percent underwater
the instant it fills. Entry takes the ask; the mark takes the bid.

```ts
const quote = await client.getQuote({ marketId, outcomeId: 'YES', side: 'BUY', size });
const { market } = await client.getMarket(marketId);

const cost = describeQuoteCost(quote, {
  outcome: market.outcomes.find((o) => o.outcomeId === 'YES'),
});

cost.spread?.spreadBps;             // 892
cost.immediateMarkToMarketBps;      // 853 — what this buy is down on arrival
cost.sizeConfidence;                // 'TOP_OF_BOOK_ONLY' — price protected, QUANTITY not
cost.fee;                           // { available: false, basis: 'EMBEDDED_IN_PRICE' }
cost.concerns;                      // the same facts as sentences, worst first
```

`sizeConfidence` is the second half. A `TOP_OF_BOOK_ONLY` quote at
`liquidityTier: 'C'` has null `expectedFillSize` and `availableSize` — the price
is protected and the fill quantity is not vouched for at all, so a large order
may not fill at any price. At five units that does not matter; at the per-order
ceiling an owner signed, it does. Pass `requestedSize` and a priced depth that
does not cover it reports `PARTIAL` rather than looking like success.

Every basis-point figure rounds **up**: these are costs, and a cost that rounds
down is a cost a threshold lets through.

## One intent, one key, across restarts

`executeMarketOrder` has always minted an idempotency key and reused it for
every retry of the create. That key lives in a local variable, so it covers
retries and not restarts — and a caller who crashed between the create and the
terminal read was left with no way to ask what happened, only a way to send a
second order under a fresh key.

Give the client a store and the key is reserved against the intent's own digest:

```ts
import { createFileIntentStore } from '@waterx/predict-agent-sdk';

const client = new PredictAgentClient({
  deployment: 'testnet',
  signer,
  intentStore: createFileIntentStore('.waterx/intents.json'),
});

// After a restart: what did this project start and never see land?
const store = createFileIntentStore('.waterx/intents.json');
for (const record of await store.pending()) {
  if (record.executionId === undefined) continue;   // retry the SAME intent; the key replays
  const execution = await client.getExecution(record.executionId);
  // Reconcile by READING. Never resend under a fresh key.
}
```

The digest covers the whole intent **minus** `idempotencyKey` and
`referenceQuoteId` — a quote lives three seconds, so including it would mint a
new key on every retry. Everything else discriminates, including fields this
contract has not grown yet: an allowlist would silently drop a new field and let
two different orders collide on one key, which is the failure you cannot see.

**The one consequence worth knowing.** Reservation is content-addressed, so a
deliberate second identical order — same account, market, outcome, side, size
and bound — replays the first key and is deduped by the server. Distinguish it
with `clientOrderId`, which the digest counts.

The store is not a lock. It serializes its own reads and writes and rewrites the
file atomically, so one process cannot lose its own record; two processes
sharing one file can still interleave a read-modify-write. One store per
process, one file per project.

## The things that will bite you

**Where the key lives is your decision, and the SDK deliberately does not make
it.** `AgentSigner` is two methods — `signTransaction` and `signPersonalMessage`
— so anything that can hold a key and sign with it satisfies it: a KMS, an HSM,
a hardware wallet, a separate process. A Sui `Keypair` matches structurally, and
that convenience is the trap: the shortest line that produces one reads a raw
private key out of `process.env`.

Do not ship that. A key in an environment variable is readable by every
dependency in the process, is inherited by every child process you spawn, lands
in crash dumps and `docker inspect`, and is one careless log line from a CI
transcript. This is an agent wallet holding a delegated mandate, so the loss is
bounded by the owner's risk profile rather than by their whole account — but
bounded is not small, and the bound is somebody else's to set.

What this repository does with the same problem: the CLI and the Runner never
hold a key at all. They spawn a signer as a separate PROCESS over a documented
protocol and receive a signature back, so a key never enters the process that
talks to the exchange. If you are writing something long-lived, do that. If you
are writing a script, at minimum read the key from wherever you already keep
secrets rather than from the environment, and never write it to a file this repo
would not have written `0600`.

Whatever you choose: **the private key is never sent anywhere, never logged, and
never returned by any call in this SDK.**

**Name the deployment; never type a hostname.** The SDK ships every host it
talks to, so a URL in your code is a hostname nobody needed to know — and one
that can differ from the intended one by a hyphen, silently, against real money.

```ts
new PredictAgentClient({ deployment: 'testnet', signer });   // or 'production'
new PredictAgentClient({ baseUrl: 'https://…', signer });    // a private host
```

Exactly one, never both: they can name different networks, and choosing between
them for you would decide where your orders go. A private or preview deployment
has no name, and `baseUrl` is what it has instead. The lookup behind the names
is exported as `PREDICT_AGENT_ENDPOINTS` if you need the string itself.

**There is no default, and there will not be one.** Which network this is
decides whether an order spends real money. A default of `testnet` would make a
production caller fail in ways that look like a broken install; a default of
`production` would point somebody's first experiment at real funds. An
unconfigured client throws, and the message names both ways to answer it.

**Nobody types an account id either.** `listAuthorizedAccounts()` reports the
accounts an owner has granted this agent and `describeOnboarding()` turns that
into a decision. Where exactly one is ready it is resolved for you; where more
than one is, this SDK asks rather than choosing whose money trades.

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
| `diagnose(options?)` | All six requirements, whether a write is permitted, the mandate, and the authorization link. Opens a session if none is held |
| `startOnboarding(options?)` | The owner's link, the current state, and the `wait()` that polls for the signature |
| `getQuote(request)` | ~3 s lifetime, never extended |
| `executeMarketOrder(intent, options?)` | create → sign → submit; optional terminal wait |
| `executeMany(intents, options?)` | Independent legs, bounded concurrency |
| `waitForExecution(id, options?)` | Wait for terminal facts; also the reconciliation entry point |
| `getExecution(id)` | Poll one execution |
| `listExecutions(accountId, page?)` | Your order history on that account, newest first |
| `getFills(accountId, page?)` | Filled executions only, by fill time |
| `getPositions(accountId, page?)` | Positions you opened, with cost basis |
| `getPerformance(accountId, strategyId?)` | Order outcomes, rejection reasons and realized PnL, lifetime-to-date |
| `getAllowance(accountId)` | API allowance, real balance, and the binding minimum |
| `getEffectiveLimits(accountId)` | The mandate: limits, window usage, delegation, blockers |
| `searchMarkets(query)` | Free text → one market id, **resolved server-side** |
| `resolveMarket(query)` | `searchMarkets` plus the expiry discriminator, and candidates priced |
| `agentWallet` | The address this client authenticates as. Not the key |

`getAllowance` reports `apiAllowance` and `accountSpendableBalance` separately
because a direct-chain spend moves one without the other. Size against
`effectiveBuyCapacity`, which is the smaller.

`getEffectiveLimits` is the mandate itself, and it is **read-only** — an agent
credential can see its limits and can never raise them. `limits: null` means no
owner granted this agent a risk profile; that is denial, not an unlimited
default. A `null` delegation permission means the on-chain read **failed**, which
is not the same as `false`.

`getPerformance` is scoped `API_ATTRIBUTED_ONLY` and there is no other mode: the
same delegated key can trade directly on chain, and that activity never had an
execution row to attribute, so it is absent rather than blended in at a guess.
`successRate` divides by **terminal** orders, not by created, so orders still in
flight cannot look like failures. Every rate is `null` — not `"0"` — when its
denominator is zero. `excluded` counts what was left out: `claimedPositions` is
the one that biases `winRate` downward and by the most, because a resolved market
is claimed from the FE and its payout never passes through this API. There is no
time window; every figure is lifetime-to-date, because the exclusions have no
recorded instant to window on.

`diagnose()` is the one call to make first, and the one to make again whenever
something stops working. It merges the offline `describeInstallation()` with an
authenticated `listAuthorizedAccounts()`, so the three requirements the offline
report can only report `UNCHECKED` come back settled, and `writes.permitted`
answers "may this agent trade" as a read fact rather than an inference from what
is on PATH. It reads the mandate in the same call, because that is the next
question every caller asks. It is also the one method here that opens a session
on its own when none is held — a diagnosis that refused to authenticate would
answer the question with an error about not having authenticated — and
`authenticatedHere` says whether it did.

Free functions for a caller that has not built a client, or has built a
different one: `diagnose(client, options)`, `startOnboarding(client, options)`,
`resolveMarket(client, query)`, `describeQuoteCost(quote, options)`,
`describeSpread(outcome)`, `createFileIntentStore(path)`,
`createMemoryIntentStore()`, `intentDigest(intent)`.

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

By default a wait polls `POST /quotes`. Pass `quoteStream: 'native'` and the
trigger reads the server's quote stream instead:

```ts
const client = new PredictAgentClient({ baseUrl, signer, quoteStream: 'native' });
try {
  await client.waitForPriceAndExecute(intent, { pollIntervalMs: 5_000 });
} finally {
  client.close(); // the client owns this socket
}
```

**What that changes is the cost of watching, not the price you trade at.** The
order is still built on a fresh `POST /quotes` and still re-checked against the
target immediately before submission — a streamed frame carries `INDICATIVE_ONLY`
and has no quote id to reference. What you save is one quote mint per tick per
watched market.

It buys no latency. The server has no upstream push: it re-reads a cache every
~2 s behind a publisher on a ~5 s cadence, which is why every frame carries
`POLLED_UPSTREAM` and its own freshness facts. `pollIntervalMs` becomes a
*ceiling* rather than a period — the wait wakes when a frame says the price moved.

Failure behaviour, all of it degrading to the same place:

| What happens | What the client does |
| --- | --- |
| Sequence break, or a heartbeat that has moved on | Report the gap, keep the frame — it is complete current state |
| Reconnect | Re-subscribe every topic with `resume: true`; the snapshot is the whole recovery |
| Two heartbeats missed | Invalidate every cached price and rebuild the connection |
| Silent past that budget, or the handshake refused repeatedly | Give up, call `onDegraded`, poll `POST /quotes` from then on |
| `MARKET_CLOSED` / `UNKNOWN_MARKET` / `INVALID_REQUEST` | Terminal for the round — never re-asked |
| `NOT_QUOTABLE` / `SUBSCRIPTION_LIMIT` / `RATE_LIMITED` | Temporary — retried on a timer |
| Frame marked `stale`, or no price yet | Fall back to `POST /quotes` for that tick |

`quoteStream` also accepts anything implementing `QuoteStream`, and
`SocketQuoteStream` / `QuoteStreamPriceWatcher` are exported for direct
construction. To replace price observation wholesale — a different venue, a local
book — supply a `priceWatcher`; the trigger, re-verify and single-submission logic
are unaffected:

```ts
new PredictAgentClient({ baseUrl, signer, priceWatcher: myWatcher });
```

An adapter of your own owes one thing above all: emit `UNAVAILABLE` whenever it
can no longer prove the feed is live. Updates are change-only, so a quiet market
and a dead socket are indistinguishable by frame arrival alone, and a watcher that
is never told will keep serving an hour-old price.

To watch a market directly rather than through a wait, `examples/watch-quotes.mjs`
subscribes to one topic, prints every frame and every `UNAVAILABLE` reason, and
says when a target *would* fire — against the ask for a BUY and the bid for a
SELL, and never against a stale frame. It is a non-production example: it refuses
an unlabelled environment, and its signer cannot sign a transaction at all.

```sh
pnpm build   # the example imports this package's build output
node packages/sdk/examples/watch-quotes.mjs --marketId <id> --side BUY --target 0.60
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
