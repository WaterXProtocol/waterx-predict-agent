# ADR-0023 — Say what the account is carrying

- Status: Accepted
- Date: 2026-09-21
- Decides: that `next` reports the account's exposure on every state, and what
  it refuses to report
- Amends: ADR-0022 (the answer gains one more field that is not a state)
- Affects: `packages/cli` (`next`, `exposure`)

## Context

`next` fetched the positions and the unsettled executions on every call — it
needs them to decide a state — and then used them as booleans. Positions became
a count. Unsettled executions became "is this list empty". Everything else was
thrown away before the answer was built.

So this was a reachable answer:

```
READY — Authorized on 0x… with nothing in flight. Ask the user what to trade.
```

on an account holding positions in a market that had stopped quoting, and a BUY
submitted an hour earlier whose escrow was still locked. Both facts were in
memory when that sentence was written.

The perp agent hit the same thing on a live mainnet account — ten positions,
$11.85 of free margin against $312 of notional, a short priced off a dead feed —
and answered `read-only` (`waterx-agent` #28). The numbers were all in reads it
had already made.

## Decision

`next` carries `notes`: what the account is carrying, whatever state it is in.

### What they are

A pure function (`exposureNotes`) of the positions and unsettled executions the
call already fetched:

| kind | what it says |
| --- | --- |
| `DEPLOYED` | how many positions and how much they cost — the number that needs no quote |
| `UNPRICED_POSITION` | no live sell-side quote: value and PnL are unknown, not zero, and an exit may not exist at any price |
| `UNSETTLED_TOO_LONG` | submitted past the keeper's five-minute grace and still not settled; its escrow is held |
| `BELOW_KEEPER_MINIMUM` | a BUY under the keeper's 2 wxUSD minimum fill: it will be cancelled rather than filled (measured on mainnet, order 38308, `below_min_fill`) |

### The three rules

1. **No note costs a request.** Anything that would need one belongs in a
   command a person can run, not in a line that rides on every answer.
2. **They ride on every state and change none of them.** `decideNext` decides
   the state first and attaches the notes to whatever comes back. A dead quote
   matters whether this runtime is `READY` or halfway through setup, and a note
   that could change the state would be a second state machine.
3. **It refuses to measure what it cannot.** `null` in a position's
   `currentPrice` or `unrealizedPnl` means "not known", never zero — zero would
   read as break-even. So the notes report **cost deployed**, which is always
   known, and say how many positions could not be priced, instead of totalling
   a portfolio value over a missing quote.

Each note carries a `look`: a command that is runnable as printed, under the
same rule as `meta.nextCommand` (ADR-0022). They are printed BEFORE the
headline, because what the account is carrying outranks what the runtime is
waiting for.

## Consequences

- **`NextFacts.account.positions` is the summaries, not a count.** They were
  always fetched; what was missing was anything that read them. `facts.account`
  in the answer still reports a count, and what the positions hold is in
  `notes`.
- **`NextFacts.now` is injected**, so the age of an unsettled order is measured
  against one instant and `decideNext` stays pure.
- **More states now carry something to read.** The cost of that is length; the
  alternative is an agent being told `READY` beside a locked escrow.
- **This is not a risk engine.** It reports what is already known and points at
  the command that looks closer. Anything requiring a fresh read — a market's
  phase, a balance, a resolution — stays a command somebody runs.
