# ADR-0025 — The operator's choice comes right after the owner's signature

- Status: Accepted
- Date: 2026-09-21
- Decides: what a runtime says and offers in the moment after a grant lands
- Amends: ADR-0021 (the chooser is now the first thing offered, not the last),
  ADR-0022 (so it is also what the pointer names)
- Affects: `packages/cli` (`next`, `onboard`)

## Context

Getting this runtime to the point where it can trade needs **two permissions
from two different people**:

| | Who | How |
| --- | --- | --- |
| The delegation | the ACCOUNT OWNER | one signature in their own wallet, on the authorize page |
| The execution policy | the AGENT OPERATOR | `policy set --mode <mode> --yes` on this machine (ADR-0021) |

The first is the one everybody thinks about, and the whole hand-over is built
around it: the link, the QR code, the page that opens itself (ADR-0024). The
second was reachable and easy to miss — and on mainnet it is `read-only` by
default (ADR-0017), so **an agent that has just been authorized still cannot
place an order.**

Two surfaces said otherwise, both at exactly the wrong moment:

- `onboard --wait`, the second the grant landed, printed *"Authorized. This
  agent may now trade on the account below."* Under the default policy that is
  false.
- `next` then answered `READY`, whose headline ended *"Ask the user what to
  trade"*, with the policy posture buried mid-sentence — and its first
  suggestion, the one `meta.nextCommand` names, was `market.search`. So the
  loop's own pointer led away from the only thing that was blocking it.

A session reading those two screens has been told it is ready, twice, and will
find out otherwise at the first order.

## Decision

**In the moment after the signature, the next thing put in front of the
operator is the choice they still have to make.**

- `onboard` no longer says "may now trade" when the policy is `read-only`. It
  says the runtime still places no order, that the policy is the operator's,
  and points at `next` — which is where the account is adopted (ADR-0015) and
  the modes are offered.
- `next`, when writes are refused, puts `runtime.policy` **first** among its
  suggestions, so it is what `meta.nextCommand` names, and leads the headline
  with it: what it cannot do, why, and both commands — the chooser, and the
  one that takes a mode.
- The chooser still offers three modes rather than one, and choosing stays the
  operator's (ADR-0021). Nothing here decides for them; it decides *when* they
  are asked.

The order is therefore: the page opens → the owner signs → `onboard` reports
the grant and points onward → `next` adopts the account and offers the three
modes → `policy set --mode <mode> --yes` → `next` → trade.

## Consequences

- **`READY` no longer means "go".** It means the owner's half is done. The
  headline says so in the first sentence, and the state stays `READY` because
  the alternative — a state for every combination of grant and policy — would
  put the same fact in two places.
- **The pointer changes with the posture.** A host that follows
  `meta.nextCommand` walks into the chooser instead of a market list.
- **What is not live-walked:** the leg after a real owner signature. The chain
  up to the authorize page was walked on testnet; `READY` under a read-only
  policy is covered through the real dispatcher in tests, because a grant needs
  a person's wallet.
