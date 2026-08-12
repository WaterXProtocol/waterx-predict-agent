# ADR-0005 — Mandatory strategy expiry

- Status: Accepted
- Date: 2026-08-12
- Plan ID: D-22
- Affects: `waterx-predict-agent-sdk`

## Context

A watch job holds a signer-backed authorization to place one order at some future
moment. An unbounded watcher is therefore an unbounded standing authorization: it
survives the conversation that created it, the user's memory of creating it, and
any change in intent. A local Runner makes this worse, not better — a job can sit
inert across days of sleep and then fire on a target set in a different context.

## Decision

1. **`expiresAt` is mandatory.** Every durable strategy job carries an explicit
   expiry. There is no default that means "forever", and omitting it is a
   validation error at schema level, not a value filled in silently.
2. **The beta maximum is seven days** from job creation. A longer request is
   rejected with a distinct error naming the cap; it is not clamped silently.
3. **No automatic extension.** Nothing extends an expiry — not a pause (ADR-0004),
   not a reconnect, not a near-miss on the target, not a Runner restart. Extending
   is a user decision expressed by creating a new job.
4. **Expiry is evaluated against wall-clock time, not uptime.** A Runner that was
   asleep past `expiresAt` expires the job on restart. Downtime does not buy the
   job extra life.
5. **Expiry before submission places nothing.** The job ends `EXPIRED` and no
   order exists. If expiry falls *after* a logical execution has been created,
   expiry does not cancel or reverse it — the job follows that execution to a
   terminal state and reconciles by execution ID. Expiry stops the watcher; it is
   not a kill switch for work already in flight.
6. **Expiry is an observable event.** An `EXPIRED` job emits to the durable event
   log and to the configured notification sink, so a user learns their strategy
   stopped rather than assuming it is still watching.

## Consequences

- Long-horizon intents ("if it hits 0.9 before the final") are not directly
  expressible past seven days. That is deliberate for the beta: the runtime cannot
  honestly promise multi-week unattended coverage on a self-hosted Runner that the
  user may shut down at any time (ADR-0001).
- The cap is a beta parameter, not an architectural constant. Raising it needs a
  new ADR and evidence that long-lived jobs survive restart, re-authentication,
  and policy change — but `expiresAt` being mandatory is architectural and does
  not get revisited.
- Rule 5 is the subtle one. Expiry and in-flight execution can race, and treating
  expiry as cancellation would report a placed order as never having existed.
- Job creation must reject an `expiresAt` already in the past, and `preview` must
  show the resolved absolute expiry so a user can see when the watcher stops.
