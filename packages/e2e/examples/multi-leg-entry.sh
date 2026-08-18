#!/usr/bin/env bash
#
# Multi-leg entry: several orders in one call, and no atomicity anywhere.
#
# `order execute-many` is CLIENT-SIDE orchestration. There is no backend batch
# behind it, no transaction that covers both legs, and nothing that unwinds one
# because the other failed. That is the whole reason this example exists: a
# caller who believes a batch is atomic will build a hedge that is silently
# half-on.
#
#   1. every leg is priced by its OWN quote — a quote prices one market, one
#      outcome, one side and one size, and cannot be shared between legs;
#   2. the whole batch is authorized ONCE, by a token derived from the per-leg
#      tokens IN ORDER, so reordering the legs is a different intent;
#   3. results are reported per leg as SUCCEEDED, FAILED or SKIPPED, and the
#      three mean different things afterwards;
#   4. `failurePolicy: STOP` stops legs that have not LAUNCHED. It cannot cancel
#      or roll back one already submitted;
#   5. a leg whose wait ran out is AMBIGUOUS, and the answer is reconcile —
#      never a second order.
#
# The two legs here are the opposite outcomes of one market, which is the case
# that makes non-atomicity concrete: if YES fills and NO is refused, the position
# is not hedged, and nothing in this contract will unwind the leg that worked.
#
# Requires: a non-production environment. Places up to TWO real orders there.

cd "$(dirname "$0")"
. ./_lib.sh

require_configured
require_non_production

MARKET_SEARCH="${1:-arsenal}"
BUY_AMOUNT="${2:-1}"
MAX_SLIPPAGE_BPS="${3:-100}"

# ── 1. a market identity, from the server ────────────────────────────────────
try waterx-predict market search --search "$MARKET_SEARCH" --tradeable true --limit 5
if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "Search failed: $(field error.code) — $(field error.message)"
  exit "$STATUS"
fi

RESOLUTION="$(field data.resolution.status)"
MARKET_ID="$(field data.marketId)"
if [ "$RESOLUTION" != "RESOLVED" ] || [ -z "$MARKET_ID" ]; then
  say "The search resolved as $RESOLUTION rather than to a single market."
  say "Name the market exactly, or pick an id from: waterx-predict market list --tradeable true"
  exit "$EXIT_REJECTED"
fi
say "Market: $MARKET_ID"

# ── 2. one quote per leg ─────────────────────────────────────────────────────
# Prints the quote id, or nothing if the quote was refused. A quote lives
# seconds, so the second leg's quote is already older than the first by the time
# the batch runs: keep batches small, and expect a refusal rather than a worse
# price if one goes stale — the executor re-checks it and will not execute
# against a quote that has expired.
quote_for() {
  QUOTE_INPUT="$(
    cat <<JSON
{
  "marketId": "$MARKET_ID",
  "outcomeId": "$1",
  "side": "BUY",
  "size": { "buyAmount": "$BUY_AMOUNT" }
}
JSON
  )"
  try waterx-predict market quote --input "$QUOTE_INPUT"
  if [ "$STATUS" -ne "$EXIT_OK" ]; then
    say "Quote for $1 refused: $(field error.code) — $(field error.message)"
    return 0
  fi
  say "$1: $(field data.quote.expectedPrice) per share, quote expires $(field data.quote.expiresAt)."
  printf '%s' "$(field data.quote.quoteId)"
}

YES_QUOTE="$(quote_for YES)"
NO_QUOTE="$(quote_for NO)"
if [ -z "$YES_QUOTE" ] || [ -z "$NO_QUOTE" ]; then
  say "Both legs need their own executable quote. Nothing was sent."
  exit "$EXIT_REJECTED"
fi

# ── 3. the batch ─────────────────────────────────────────────────────────────
# `orders` is an array, so it cannot be typed as flags. Legs carry no waitFor of
# their own: the wait is a property of this call, not of an order.
BATCH="$(
  cat <<JSON
{
  "orders": [
    {
      "accountId": "$ACCOUNT_ID",
      "marketId": "$MARKET_ID",
      "outcomeId": "YES",
      "side": "BUY",
      "size": { "buyAmount": "$BUY_AMOUNT" },
      "referenceQuoteId": "$YES_QUOTE",
      "maxSlippageBps": $MAX_SLIPPAGE_BPS
    },
    {
      "accountId": "$ACCOUNT_ID",
      "marketId": "$MARKET_ID",
      "outcomeId": "NO",
      "side": "BUY",
      "size": { "buyAmount": "$BUY_AMOUNT" },
      "referenceQuoteId": "$NO_QUOTE",
      "maxSlippageBps": $MAX_SLIPPAGE_BPS
    }
  ],
  "concurrency": 2,
  "failurePolicy": "STOP",
  "waitFor": "SUBMITTED",
  "timeoutMs": 60000
}
JSON
)"

# ── 4. authorize the batch ───────────────────────────────────────────────────
# A single-leg approval comes back from `order preview`. A BATCH approval is
# derived from the per-leg tokens joined in order, and rather than recomputing
# that digest here, this asks the runtime for it: under `interactive` a write
# with no approval is refused LOCALLY — no quote is minted, no signer process is
# started, nothing is sent — and the refusal names the token this exact batch
# needs.
#
# The branch is a safety requirement, not a style choice. Under `delegated-auto`
# there is no approval to collect and the same probe call would simply TRADE.
APPROVE_ARGS=()
if [ "$POLICY_MODE" = "interactive" ]; then
  try waterx-predict order execute-many --input "$BATCH"
  if [ "$STATUS" -ne "$EXIT_POLICY" ]; then
    say "Expected a local approval refusal (exit $EXIT_POLICY), got $STATUS: $(field error.code)"
    exit "$STATUS"
  fi
  EXPECTED="$(field error.details.expectedApproval)"
  if [ -z "$EXPECTED" ]; then
    say "The refusal named no expected approval: $(field error.message)"
    exit "$EXIT_POLICY"
  fi
  APPROVE_ARGS=(--approve "$EXPECTED")
fi

# ── 5. execute ───────────────────────────────────────────────────────────────
try waterx-predict order execute-many "${APPROVE_ARGS[@]}" --input "$BATCH"
BATCH_STATUS="$STATUS"

say "atomic=$(field data.atomic), legs=$(field data.legs)"
say "succeeded=$(field data.summary.succeeded) failed=$(field data.summary.failed) skipped=$(field data.summary.skipped) ambiguous=$(field data.summary.ambiguous)"

for INDEX in 0 1; do
  say "  leg $INDEX $(field data.results.$INDEX.intent.outcomeId): $(field data.results.$INDEX.status) $(field data.results.$INDEX.executionId)$(field data.results.$INDEX.error.code)"
done

# ── 6. what to do about each outcome ─────────────────────────────────────────
# AMBIGUOUS outranks a refusal: a leg with no known outcome may already be
# filling, and re-running the batch would place it twice.
if [ "$BATCH_STATUS" -eq "$EXIT_AMBIGUOUS" ]; then
  say "AMBIGUOUS: at least one leg was submitted and its outcome is unknown."
  say "Reconcile each execution id above — do NOT re-run this script:"
  say "  waterx-predict order reconcile --executionId <id> --timeoutMs 120000"
  exit "$EXIT_AMBIGUOUS"
fi

if [ "$BATCH_STATUS" -ne "$EXIT_OK" ]; then
  say "At least one leg was refused: $(field data.results.0.error.message)$(field data.results.1.error.message)"
  say "A SKIPPED leg sent nothing and exactly it can be resubmitted alone."
  say "A SUCCEEDED leg stands: no failure of another leg unwinds it."
fi

# The whole envelope, for the record. Per-leg execution ids are the only handle
# on what happened, and a summary line is not one.
printf '%s\n' "$OUT"
exit "$BATCH_STATUS"
