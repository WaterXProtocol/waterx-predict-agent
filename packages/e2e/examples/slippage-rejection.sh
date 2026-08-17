#!/usr/bin/env bash
#
# Slippage rejection: price protection refusing an order rather than filling it
# worse than asked.
#
# The point is that a REJECTED order is a correct outcome, not an error to retry
# around. It exits 10, it placed nothing, and the right response is to re-quote
# and decide again — never to loosen the bound and resubmit blindly, which is how
# price protection gets quietly turned off.
#
# The demonstration uses `maxSlippageBps: 0`: zero tolerance against a live book
# that has moved at all. Nothing about that is special-cased; it is the ordinary
# bound set to its strictest value.
#
# Requires: a non-production environment. Attempts ONE order, which is expected
# to be refused — but a market that has not moved may fill it, so this still
# spends real testnet funds.

cd "$(dirname "$0")"
. ./_lib.sh

require_configured
require_non_production

MARKET_ID="${1:-}"
if [ -z "$MARKET_ID" ]; then
  try waterx-predict market list --tradeable true --limit 1
  MARKET_ID="$(field data.markets.0.marketId)"
fi
if [ -z "$MARKET_ID" ]; then
  say "No tradeable market to price. Pass a marketId as the first argument."
  exit "$EXIT_CONFIG"
fi

# ── the bound, as the preview reports it ─────────────────────────────────────
# A preview costs nothing and places nothing, so the bound can be inspected
# BEFORE anything is at risk. `estimate.effective` is the local computation
# against this quote; the server recomputes it against the submission-time quote
# and the chain may tighten it further — never loosen it.
INTENT="$(
  cat <<JSON
{
  "accountId": "$ACCOUNT_ID",
  "marketId": "$MARKET_ID",
  "outcomeId": "YES",
  "side": "BUY",
  "size": { "buyAmount": "1" },
  "maxSlippageBps": 0
}
JSON
)"

try waterx-predict order preview --input "$INTENT"
if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "Preview refused: $(field error.code) — $(field error.message)"
  exit "$STATUS"
fi

say "Quote:  $(field data.quote.expectedPrice)"
say "Bound:  $(field data.priceProtection.estimate.effective) ($(field data.priceProtection.estimate.bound), binding=$(field data.priceProtection.estimate.binding))"
say "Policy: $(field data.policy.decision)"

APPROVAL="$(field data.policy.approvalToken)"
QUOTE_ID="$(field data.quote.quoteId)"
APPROVE_ARGS=()
if [ -n "$APPROVAL" ]; then
  APPROVE_ARGS=(--approve "$APPROVAL")
fi

# ── the execution, and its refusal ───────────────────────────────────────────
ORDER="$(
  cat <<JSON
{
  "accountId": "$ACCOUNT_ID",
  "marketId": "$MARKET_ID",
  "outcomeId": "YES",
  "side": "BUY",
  "size": { "buyAmount": "1" },
  "maxSlippageBps": 0,
  "referenceQuoteId": "$QUOTE_ID",
  "waitFor": "SUBMITTED",
  "timeoutMs": 60000
}
JSON
)"

try waterx-predict order execute "${APPROVE_ARGS[@]}" --input "$ORDER"

case "$STATUS" in
  "$EXIT_REJECTED")
    # This is the outcome the example is about. The order did NOT partially fill
    # and did not sit in a book: this is a market order under a price cap, so it
    # either fills inside the cap or it does not happen.
    say "REJECTED — $(field error.code): $(field error.message)"
    say
    say "Nothing was placed. The correct response is to re-price and decide again:"
    say "  waterx-predict market get --marketId $MARKET_ID"
    say
    say "Do NOT widen maxSlippageBps and resubmit reflexively. The bound is the"
    say "only thing standing between a moved book and a fill you did not want."
    exit "$EXIT_OK"
    ;;
  "$EXIT_POLICY")
    say "Refused locally by the execution policy before anything was signed: $(field error.message)"
    exit "$EXIT_OK"
    ;;
  "$EXIT_AMBIGUOUS")
    EXECUTION_ID="$(field data.executionId)"
    say "AMBIGUOUS: submitted, outcome unknown. Reconcile — do NOT resubmit."
    say "  waterx-predict order reconcile --executionId $EXECUTION_ID"
    exit "$EXIT_AMBIGUOUS"
    ;;
  "$EXIT_OK")
    # Possible and not a bug: the book did not move between the quote and the
    # submission, so a zero-slippage order was fillable.
    say "Filled inside a zero-slippage bound — the book did not move. Execution $(field data.executionId)."
    exit "$EXIT_OK"
    ;;
  *)
    say "Unexpected: exit $STATUS, $(field error.code) — $(field error.message)"
    exit "$STATUS"
    ;;
esac
