#!/usr/bin/env bash
#
# One-shot entry: preview, approve, execute, wait, reconcile.
#
# The shape of a complete entry with nothing durable behind it. There is no job
# store here and no process that outlives the script — that is what the Runner
# will be for. What this shows is the contract an entry has to satisfy anyway:
#
#   1. a market identity comes from the SERVER, never from a guess;
#   2. an order is built on an executable QUOTE, not on a catalog price;
#   3. `preview` costs nothing, places nothing, and hands back an approval token
#      that binds this exact intent;
#   4. `execute` carries price protection, and returns once the order is on-chain;
#   5. running out of time is AMBIGUOUS, and the answer to it is `reconcile` —
#      never a second order.
#
# Requires: a non-production environment. Places ONE real order there.

cd "$(dirname "$0")"
. ./_lib.sh

require_configured
require_non_production

MARKET_SEARCH="${1:-arsenal}"
BUY_AMOUNT="${2:-1}"
MAX_SLIPPAGE_BPS="${3:-100}"

# ── 1. a market identity, from the server ────────────────────────────────────
# Free text is resolved BY THE SERVER. If it matches more than one market the
# answer is AMBIGUOUS and no id is returned — the caller picks, not the CLI.
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

# ── 2. preview ───────────────────────────────────────────────────────────────
# `size` is a structured field, so it cannot be a flag. The whole document goes
# through --input, which is the only way to express it.
INTENT="$(
  cat <<JSON
{
  "accountId": "$ACCOUNT_ID",
  "marketId": "$MARKET_ID",
  "outcomeId": "YES",
  "side": "BUY",
  "size": { "buyAmount": "$BUY_AMOUNT" },
  "maxSlippageBps": $MAX_SLIPPAGE_BPS
}
JSON
)"

try waterx-predict order preview --input "$INTENT"
if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "Preview refused: $(field error.code) — $(field error.message)"
  exit "$STATUS"
fi

say "Preview: $(field data.quote.expectedPrice) per share, worst acceptable $(field data.priceProtection.estimate.effective)."
say "Policy:  $(field data.policy.decision)"

APPROVAL="$(field data.policy.approvalToken)"
QUOTE_ID="$(field data.quote.quoteId)"

# Under `interactive` the token is required. Under `delegated-auto` the scope has
# already decided and there is no token to carry — its absence is correct there,
# so demanding one would break a valid configuration.
APPROVE_ARGS=()
if [ -n "$APPROVAL" ]; then
  APPROVE_ARGS=(--approve "$APPROVAL")
fi

# ── 3. execute ───────────────────────────────────────────────────────────────
# `waitFor: SUBMITTED` returns once the transaction is on-chain, not once the
# fill has settled. The settle is step 4, and it is a separate bound on purpose:
# a submitted order exists whether or not anyone is still waiting for it.
ORDER="$(
  cat <<JSON
{
  "accountId": "$ACCOUNT_ID",
  "marketId": "$MARKET_ID",
  "outcomeId": "YES",
  "side": "BUY",
  "size": { "buyAmount": "$BUY_AMOUNT" },
  "maxSlippageBps": $MAX_SLIPPAGE_BPS,
  "referenceQuoteId": "$QUOTE_ID",
  "waitFor": "SUBMITTED",
  "timeoutMs": 60000
}
JSON
)"

try waterx-predict order execute "${APPROVE_ARGS[@]}" --input "$ORDER"
EXECUTION_ID="$(field data.executionId)"

if [ "$STATUS" -eq "$EXIT_AMBIGUOUS" ]; then
  # The order was SUBMITTED and the wait ran out. It is not cancelled, and the
  # id stays valid. Placing another order here would be the single worst thing
  # this script could do.
  say "AMBIGUOUS: submitted, outcome unknown. Reconcile — do NOT resubmit."
  say "  waterx-predict order reconcile --executionId $EXECUTION_ID"
  exit "$EXIT_AMBIGUOUS"
fi

if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "Execution refused: $(field error.code) — $(field error.message)"
  if [ -n "$EXECUTION_ID" ]; then
    say "An execution id exists, so something may have been submitted. Reconcile it:"
    say "  waterx-predict order reconcile --executionId $EXECUTION_ID"
  fi
  exit "$STATUS"
fi

say "Submitted: $EXECUTION_ID"

# ── 4. wait for terminal ─────────────────────────────────────────────────────
# `reconcile` is the wait AND the recovery. Same command either way, which is
# why there is nothing to remember when it does time out.
try waterx-predict order reconcile --executionId "$EXECUTION_ID" --timeoutMs 120000

if [ "$STATUS" -eq "$EXIT_AMBIGUOUS" ]; then
  say "Still not terminal after 120s. The order stands; reconcile again later."
  say "  waterx-predict order reconcile --executionId $EXECUTION_ID"
  exit "$EXIT_AMBIGUOUS"
fi

# ── 5. read the authoritative result ─────────────────────────────────────────
try waterx-predict order get --executionId "$EXECUTION_ID"
# `fill` is ABSENT until the chain event is observed. A missing share count is
# not a zero, and booking one as zero is how a strategy loses track of a position
# it actually holds.
say "Status: $(field data.execution.status), terminal=$(field data.execution.terminal)."
say "Fill:   $(field data.execution.fill.filledShares) shares at $(field data.execution.fill.avgFillPrice) (empty means not yet observed)."

try waterx-predict account positions --accountId "$ACCOUNT_ID" --limit 5
printf '%s\n' "$OUT"
