# ADR-0018 — An approval names who gave it, and every write decision is kept

- Status: Accepted
- Date: 2026-09-17 (the owner asked for the audit and check gaps against the perp agent to be closed)
- Decides: what an approval must carry, what is recorded about writes, and
  which remaining freshness checks this runtime adds
- Amends: ADR-0014 (approvals, spend and adoption ledgers), ADR-0015 §4 (the write probe)
- Affects: `packages/cli` (`run`, `ledgers`, `commands/order`, `commands/next`,
  `commands/doctor`), `packages/e2e`

## Context

After ADR-0014/0015 the state file said what holds now, and forgot everything
else.
- An approval, once spent, was pruned a day later.
- Nothing said who approved an order.
- An account adoption recorded what was chosen, not who chose it.

The perp agent (`waterx-agent`) requires `approve --approver` and keeps
approvals, submissions and adoptions as append-only JSONL.

Two freshness checks the perp agent has were also open here:
- the age of the deployment document;
- the age of the price an order is capped from.

## Decision

### 1. `--approve` requires `--approver <name>`

- **What it is.** A dispatcher flag, like `--approve`, and for the same
  reason: it is a person's statement, not part of the intent. Tool adapters
  cannot pin it.
- **Rules.**
  - `--approve` without it is a usage error.
  - So is `--approver` without `--approve`.
  - The name is 1–64 letters, digits, spaces and `._@-`.
- **Where it is recorded.** On the spent approval, and in the audit log.

The name is what the operator typed. It is not authentication, as the token is
not. It turns "an approval was used" into "Alice approved this at 10:02".

### 2. `write-audit.jsonl`: append-only, durable, private

- **The file.** It sits beside the ledger in the state directory, mode `0600`.
  One JSON line per event, fsync'd before the command continues, never
  rewritten or pruned.
- **Events.**
  - `approval.issued`
  - `approval.spent` (with `approvedBy` and the command)
  - `spend.reserved` / `spend.released`
  - `account.adopted` (with `basis`, `namedBy` and the account replaced)
  - `write.result`: the executions a write produced, or the refusal that
    ended it, with the approver.
- **What it never holds.** No key, signature, transaction bytes or session.
- **Programmatic use.** The in-memory ledger exposes the same events, for a
  host that keeps them itself.

### 3. The write probe covers the close side

`doctor --probeWrite` also builds and verifies a close of at most one share of
a position the account holds, with its floor, and signs nothing. With no
position the check is skipped, and it says why.

### 4. The two freshness checks need no new code, and why

- **Deployment document.** `FetchedDeployment` re-reads it every five minutes
  and refuses when the re-read fails. It never signs against an older copy,
  which is stricter than the perp agent's default, where grace is zero minutes
  unless an operator widens it.
- **Price age.** The backend's public quote routes are live-or-nothing. Its
  quote service ages each price out after `predictQuoteTtlMs` and answers
  `null` (`bucket-backend-mono`, `predict-live-quote.service.ts`,
  `live-quote.ts`). A `null` price already refuses an order here. The routes
  carry no timestamp, so a second, client-side check would have nothing to
  compare. Revisit if the routes ever start serving a price without that
  age-out.

## Consequences

- **Breaking change for scripts.** A script calling `order execute --approve`
  must add `--approver`; the e2e harness names itself `e2e-harness`. Nothing
  has been released, so no installed copy breaks.
- **The audit file grows without bound.** Rotating it is the operator's call,
  as with any log. This runtime never truncates it.
- **Still not a boundary.** A process running as this user can still append to
  or edit these files. The log records the decisions this runtime made, not
  proof against tampering.
