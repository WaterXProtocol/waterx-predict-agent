# ADR-0030 — A batch's budget is settled against the legs that signed, not the command

- Status: Accepted
- Date: 2026-10-01 (found by the external-beta test pass: a two-leg batch kept
  both legs' budget after placing one)
- Decides: what a partly-placed batch gives back of the cumulative budget it
  reserved
- Amends: ADR-0014 §2 (the reservation is returned only if the command signed
  nothing)
- Affects: `packages/cli/src/ledgers.ts`, `packages/cli/src/commands/order.ts`

## Context

ADR-0014 §2 gave the cumulative ceiling a durable reservation and one rule for
giving it back:

> The reservation is returned only if the command signed nothing. A signed order
> whose fate is unknown counts.

That rule was written while the only writer was a single order, where *the
command* and *the order* are the same thing. For `order execute-many` they are
not, and the difference is money.

A batch reserves **once**, for its whole total, before any leg is signed. The
order is deliberate: authorizing leg by leg would place the first leg before
discovering the second is out of scope, so the batch has to be refusable before
it starts. But settlement stayed per command, so one signature anywhere in the
batch made the whole reservation permanent.

The external-beta pass placed the case: two legs, 2.2 wxUSD each, under a 5
wxUSD cumulative scope. Leg 0 filled. Leg 1 was refused on an expired quote —
before any signature, nothing sent, nothing on chain. The scope was then 4.4
wxUSD down for 2.2 wxUSD of trading, and nothing but rewriting the scope could
give it back, which starts a fresh budget and therefore hides the problem rather
than fixing it.

An unattended runtime is exactly where this bites: the budget is the bound on a
loop nobody is watching, and a loop that loses room on every failed leg stops
early for a reason its operator cannot see in the number they set.

## Decision

### 1. A reservation can be reduced to what its write committed

`SpendLedger` gains `settle(id, committed)` beside `reserve` and `release`. It
rewrites the reservation's amount inside the same exclusive-lock transaction
every other update uses.

It may only ever **reduce**. The reservation is the amount the ceiling was
checked against, so honouring a larger settlement would let a write commit money
past a ceiling nothing cleared; a larger amount is ignored. Settling to zero or
less is recorded as a release, so "counts for nothing" has one representation. An
unparseable amount changes nothing: budget comes back on evidence, and a number
nobody can read is not evidence.

`release` is unchanged and remains the whole-reservation case.

### 2. What a batch committed is attributed from the signing gate

The gate spends exactly one permit per leg that reaches the signer. So

> signatures spent **equals** legs that succeeded

is proof that no failed or skipped leg was ever signed — every signature is
accounted for by a leg that worked — and the budget of the rest provably did not
leave. In that case the batch settles to the sum of the succeeded legs' amounts.

When the counts differ, some leg signed and then failed. Nothing in this process
says which, so **the whole reservation stands**. The same holds when the call
threw and there is no per-leg account at all.

The asymmetry is deliberate and is the reason this is safe to do. Over-counting a
ceiling costs an operator a refusal they can see and lift. Under-counting hands
an unattended loop room it has already spent.

### 3. The single-order case is unchanged

One leg means the gate's own count is the whole attribution: signed or not. It
keeps ADR-0014 §2 exactly, and is now the degenerate case of one rule rather
than a separate one.

### 4. Both amounts are written down

A settlement appends `spend.settled` with `reserved` and `committed`. "Reserved
4.4, committed 2.2" is the whole account of a batch that placed one leg of two,
and the difference is what came back. A settlement that would change nothing
writes nothing: a ledger line saying a decision was made where none was makes a
budget harder to read, not easier.

## Consequences

- **The ledger file grows a third spend verb.** A reader of the file sees
  `amount` already reduced, and the audit log is where the reduction is
  explained. A build that does not know `settle` is not a risk the format has to
  carry: the record shape is unchanged, and a reduced amount is a valid record
  under the old reader.
- **Security is unchanged in the direction that matters.** No path can raise a
  reservation, and nothing new can be reached from a request: `settle` is called
  by the command that holds the authorization, with an amount derived from legs
  that command normalized and from a counter only the signer increments.
- **A signed-then-failed leg still over-counts.** This buys back the case the
  process can prove and no more. Narrowing it further would mean attributing a
  signature to a leg, which means a per-leg reservation — a bigger change with
  its own failure mode, since N reservations can be partly written where one
  cannot.
- **`order preview` is unaffected.** It reserves nothing and still reports a
  would-be excess as `DENIED`.
