# ADR-0004 — Market lifecycle effects on a durable job

- Status: Accepted
- Date: 2026-08-12
- Plan ID: D-18
- Affects: `waterx-predict-agent-sdk`, `bucket-backend-mono`

## Context

A durable watch job outlives the market condition it watches. A match is
suspended, a round closes, an event is postponed, a market resolves. The job must
react without ever doing the two things that would be worst: firing an order into
a market the user no longer meant, or silently sitting in `WATCHING` forever on a
market that can never trade again.

Verified contract state at the time of this ADR:

- `PredictMarketStatus` is `PREGAME | IN_PLAY | CLOSED | RESOLVED`. `CLOSED` and
  `RESOLVED` are both untradeable; only `PREGAME` and `IN_PLAY` can quote.
- `PredictAgentMarket.tradeable` is false whenever an execution would be refused,
  with a free-text `tradeabilityReason?: string`.
- There is no `SUSPENDED` or `POSTPONED` status, no cancellation status, and no
  machine-readable reason code. `PredictMarketEvent.startsAt` is the only
  scheduling signal, and it is optional.

## Decision

### Classification

1. **Transient unavailability pauses.** A market that is still `PREGAME` or
   `IN_PLAY` but currently `tradeable: false` moves the job to `PAUSED`. The job
   keeps its identity, its normalized intent, and its idempotency key, and it
   resumes `WATCHING` when the market becomes tradeable again.
2. **`CLOSED`, `RESOLVED`, and cancellation are terminal.** The job ends in a
   terminal state naming the market lifecycle as the cause. It is not retried and
   not resumed.
3. **A paused job still expires.** `PAUSED` does not stop the clock. If
   `expiresAt` passes while paused, the job ends as `EXPIRED` (see ADR-0005).
4. **Postponement is not special-cased.** A postponed event surfaces as either
   transient untradeability or a terminal status, and is handled by rules 1–3. A
   moved `startsAt` is not on its own a reason to end or extend a job.

### Prohibitions

5. The runtime **never switches markets**. If the market the job resolved at
   creation is terminal, the job is terminal. Finding a "replacement" market —
   a rescheduled fixture, a new round, a similar title — is a new user intent and
   requires a new job.
6. The runtime **never extends `expiresAt`** to wait out a pause.
7. A pause **never** relaxes protection. On resume the job re-quotes, re-verifies
   the target, and re-reads delegation, risk, and position state exactly as a
   first trigger would (ADR-0001).

### Backend dependency

8. Distinguishing transient from terminal currently depends on `status` plus
   `tradeable`, which is sufficient for rules 1–3 but coarse: `tradeabilityReason`
   is free text and cannot be classified programmatically, and cancellation has no
   distinct representation. The backend will add a **closed-set machine-readable
   tradeability reason code**, and the runtime must treat it as an open set —
   tolerating a value a newer server introduces by falling back to the coarse
   `status` + `tradeable` classification rather than crashing or guessing.
9. Until that code exists, the runtime classifies on `status` and `tradeable`
   only, and carries `tradeabilityReason` through to the user as opaque text. It
   must not pattern-match English strings to make a control-flow decision.

## Consequences

- A user whose market is suspended sees `PAUSED` with the reason, not a job that
  looks healthy and not one that vanished.
- Because a paused job still expires, a long suspension can end a job without it
  ever firing. That is the intended conservative outcome: expiry is a promise that
  the watcher stops.
- Rule 5 means a postponed fixture reliably ends jobs. Users will ask for
  automatic rescheduling; granting it needs a new ADR, because it lets a job fire
  against a market the user never saw.
- Job state must persist the resolved market identity, so a terminal market
  decision is made against what the job actually resolved at creation rather than
  against a re-resolution performed later.
