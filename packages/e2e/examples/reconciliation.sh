#!/usr/bin/env bash
#
# Reconciliation: recovering an execution whose outcome is unknown, without
# resubmitting it.
#
# A wait that runs out of time is NOT a failure and NOT a cancellation. The order
# was submitted; the only thing that ended was the caller's patience. So the CLI
# answers `ok: true` with exit 11 (AMBIGUOUS) and a reconcile instruction — never
# an error a retry loop would treat as "it didn't happen" and place again.
#
# This is the single most dangerous moment in the whole surface: a duplicate
# order costs real money and cannot be un-placed. Everything here exists to make
# the safe move the easy one.
#
#   waterx-predict order reconcile --executionId <id>
#
# Reconcile is idempotent and safe to repeat. It places nothing, cancels nothing
# and signs nothing — it reads, and waits.
#
# Read-only. Places no order. Safe to run anywhere it is configured.
#
# Usage: reconciliation.sh [executionId]
#        With no argument it reconciles every non-terminal execution it finds.

cd "$(dirname "$0")"
. ./_lib.sh

require_configured

reconcile_one() {
  execution_id="$1"
  say "── $execution_id"

  # `--timeoutMs` bounds THE WAIT, and it is independent of `--timeout-ms`, which
  # bounds the invocation. Reconcile widens the invocation deadline to outlive
  # the wait it was given, so a long reconcile is not cut off by a short one.
  try waterx-predict order reconcile --executionId "$execution_id" --timeoutMs 30000 --pollIntervalMs 1000

  if [ "$STATUS" -eq "$EXIT_AMBIGUOUS" ]; then
    # Still not terminal. Nothing has gone wrong and nothing has been lost: the
    # id stays valid indefinitely, and the answer is to ask again later.
    say "   still in flight ($(field data.execution.status)) — the order stands."
    say "   Run the same command again later. Do NOT place a replacement."
    return 0
  fi

  if [ "$STATUS" -ne "$EXIT_OK" ]; then
    say "   could not reconcile: $(field error.code) — $(field error.message)"
    say "   This says nothing about the ORDER. Retry the read before concluding anything."
    return 1
  fi

  say "   resolved: $(field data.execution.status)"
  say "   filled:   $(field data.execution.fill.filledShares) shares at $(field data.execution.fill.avgFillPrice)"
  say "   digest:   $(field data.execution.transactionDigest)"

  # A terminal status is the authoritative answer, and only then are the fill
  # facts trustworthy. Absent `fill` on a terminal execution means the chain
  # event carried no share count — which is not zero shares.
  return 0
}

if [ "$#" -ge 1 ]; then
  reconcile_one "$1"
  exit $?
fi

# ── with no id: find what is still open ──────────────────────────────────────
# The history plane is the recovery plane. An agent that lost its process, its
# in-memory state or its whole machine can still find every order it placed,
# because the server has them and the account is the record.
try waterx-predict account executions --accountId "$ACCOUNT_ID" --limit 50

if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "Could not list executions: $(field error.code) — $(field error.message)"
  exit "$STATUS"
fi

OPEN_IDS="$(
  printf '%s' "$OUT" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const rows = JSON.parse(raw).data.executions ?? [];
      // `terminalAt` is the servers own record of when an execution finished.
      // Re-deriving that from a hard-coded status list here would drift the day
      // a status is added, and the drift would read as "nothing to reconcile".
      for (const row of rows.filter((row) => row.terminalAt === null)) {
        process.stdout.write(`${row.executionId}\n`);
      }
    });
  '
)"

if [ -z "$OPEN_IDS" ]; then
  say "Nothing in flight on this account's first page of history."
  say "If more history exists, walk it: --cursor $(field data.nextCursor)"
  exit "$EXIT_OK"
fi

say "In flight:"
say "$OPEN_IDS"
say

FAILED=0
while IFS= read -r id; do
  [ -n "$id" ] || continue
  reconcile_one "$id" || FAILED=1
done <<<"$OPEN_IDS"

exit "$FAILED"
