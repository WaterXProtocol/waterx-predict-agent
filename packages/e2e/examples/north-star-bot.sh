#!/usr/bin/env bash
#
# The north star, end to end:
#
#   "Buy $N of <market> YES if it is under 0.60, sell half when it reaches 0.80,
#    and stop watching in three days."
#
# One sentence, and every hard part of this runtime is in it: a market that must
# be resolved by the server, an entry that is conditional, an exit that has to
# outlive the shell, a horizon that is mandatory, and a chain of decisions where
# every step can fail on its own.
#
# WHAT THIS SCRIPT WILL NOT PRETEND:
#
#   * A trigger fires LEGS, not a sequence. There is no "buy, then arm the exit"
#     inside one strategy: the exit needs a position id that does not exist until
#     the entry has filled. So the bot does the entry itself and arms the exit
#     after — and when the entry is the part that has to wait, it arms the entry
#     and says plainly that it must be re-run once that fills.
#   * "Under 0.60" is checked against an EXECUTABLE ask, from a quote. Not a
#     catalog price and not a mid.
#   * A submitted order whose wait ran out is neither filled nor failed. It is
#     reconciled, never re-placed.
#   * The exit is armed on a LOCAL Runner. This device stays awake and online or
#     nothing is watching; there is no managed runner to fall back on.
#
# Requires: a non-production environment, a local Runner, an owner address.
# Places up to ONE real order, and arms ONE durable strategy.

cd "$(dirname "$0")"
. ./_lib.sh

require_configured
require_non_production
require_owner_address
require_runner

MARKET_SEARCH="${1:-arsenal}"
BUY_AMOUNT="${2:-1}"
ENTRY_CEILING="${3:-0.60}"
EXIT_TARGET="${4:-0.80}"
EXPIRES_IN_HOURS="${5:-72}"
MAX_SLIPPAGE_BPS="${6:-100}"
OUTCOME_ID="YES"
STRATEGY_LABEL="north-star-example"

# Compares two decimal prices without turning either into a float: pads both
# sides and compares text. Nothing computed here is ever used AS money — sizes
# and prices are passed on as the strings they were typed as.
price_le() {
  node -e '
    const pad = (value) => {
      const [whole, fraction = ""] = String(value).split(".");
      return whole.padStart(12, "0") + fraction.padEnd(12, "0");
    };
    process.stdout.write(pad(process.argv[1]) <= pad(process.argv[2]) ? "le" : "gt");
  ' "$1" "$2"
}

# ── 1. the market, resolved by the server ────────────────────────────────────
try waterx-predict market search --search "$MARKET_SEARCH" --tradeable true --limit 5
if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "Search failed: $(field error.code) — $(field error.message)"
  exit "$STATUS"
fi
MARKET_ID="$(field data.marketId)"
if [ "$(field data.resolution.status)" != "RESOLVED" ] || [ -z "$MARKET_ID" ]; then
  say "The search did not resolve to one market. Name it exactly, or list ids:"
  say "  waterx-predict market list --tradeable true"
  exit "$EXIT_REJECTED"
fi
say "Market: $MARKET_ID"

# ── 2. is the entry condition true NOW? ──────────────────────────────────────
QUOTE_INPUT="$(
  cat <<JSON
{
  "marketId": "$MARKET_ID",
  "outcomeId": "$OUTCOME_ID",
  "side": "BUY",
  "size": { "buyAmount": "$BUY_AMOUNT" }
}
JSON
)"
try waterx-predict market quote --input "$QUOTE_INPUT"
if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "No executable price: $(field error.code) — $(field error.message)"
  exit "$STATUS"
fi
ASK="$(field data.quote.expectedPrice)"
say "Executable ask: $ASK (ceiling $ENTRY_CEILING)."
# That quote is a DECISION input and is deliberately not carried into the order
# below: by the time an approval has been collected it would have aged, and
# `order preview` mints the one the execution is actually built on.

EXPIRES_AT="$(hours_from_now "$EXPIRES_IN_HOURS")"

# ── 3a. the condition is not true: arm the ENTRY and stop ────────────────────
# A durable BUY that waits for the ask to come to it. The exit cannot be armed
# in the same breath — it needs the position the entry has not created yet.
if [ "$(price_le "$ASK" "$ENTRY_CEILING")" != "le" ]; then
  say "Above the ceiling, so nothing is bought now. Arming a durable entry instead."
  ENTRY="$(
    cat <<JSON
{
  "ownerAddress": "$OWNER_ADDRESS",
  "accountId": "$ACCOUNT_ID",
  "strategyId": "$STRATEGY_LABEL-entry",
  "expiresAt": "$EXPIRES_AT",
  "trigger": { "kind": "PRICE", "targetPrice": "$ENTRY_CEILING" },
  "legs": [
    {
      "marketId": "$MARKET_ID",
      "outcomeId": "$OUTCOME_ID",
      "side": "BUY",
      "buyAmount": "$BUY_AMOUNT",
      "maxSlippageBps": $MAX_SLIPPAGE_BPS
    }
  ]
}
JSON
  )"
  try waterx-predict strategy create --input "$ENTRY"
  ENTRY_STATUS="$STATUS"
  ENTRY_JOB="$(field data.strategy.jobId)"

  if [ "$ENTRY_STATUS" -eq "$EXIT_AMBIGUOUS" ]; then
    say "AMBIGUOUS: the create had no answer. Do NOT re-run — a second create arms a second entry."
    say "  waterx-predict strategy list --strategyId $STRATEGY_LABEL-entry"
    exit "$EXIT_AMBIGUOUS"
  fi
  if [ -z "$ENTRY_JOB" ]; then
    say "Refused: $(field error.code) — $(field error.message)"
    exit "$ENTRY_STATUS"
  fi
  say "Entry armed: job $ENTRY_JOB, state $(field data.strategy.state), driving=$(field data.driving)."
  if [ "$ENTRY_STATUS" -eq "$EXIT_UNAVAILABLE" ]; then
    say "ARMED AND ASLEEP: nothing is driving this Runner. Missing: $(field data.driverGaps)."
  fi
  say ""
  say "Re-run this script once the entry has filled and the exit will be armed against"
  say "the position it created. Watch the price meanwhile:"
  say "  node ../../sdk/examples/watch-quotes.mjs --marketId $MARKET_ID --outcomeId $OUTCOME_ID --side BUY --target $ENTRY_CEILING"
  say "To stop it:"
  say "  waterx-predict strategy cancel --jobId $ENTRY_JOB --reason 'thesis changed'"
  exit "$EXIT_OK"
fi

# ── 3b. the condition is true: enter now ─────────────────────────────────────
INTENT="$(
  cat <<JSON
{
  "accountId": "$ACCOUNT_ID",
  "marketId": "$MARKET_ID",
  "outcomeId": "$OUTCOME_ID",
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

APPROVAL="$(field data.policy.approvalToken)"
QUOTE_ID="$(field data.quote.quoteId)"
APPROVE_ARGS=()
if [ -n "$APPROVAL" ]; then
  APPROVE_ARGS=(--approve "$APPROVAL")
fi

ORDER="$(
  cat <<JSON
{
  "accountId": "$ACCOUNT_ID",
  "marketId": "$MARKET_ID",
  "outcomeId": "$OUTCOME_ID",
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
  say "AMBIGUOUS: submitted, outcome unknown. Reconcile — do NOT resubmit."
  say "  waterx-predict order reconcile --executionId $EXECUTION_ID"
  exit "$EXIT_AMBIGUOUS"
fi
if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "Entry refused: $(field error.code) — $(field error.message)"
  if [ -n "$EXECUTION_ID" ]; then
    say "An execution id exists, so something may have been submitted:"
    say "  waterx-predict order reconcile --executionId $EXECUTION_ID"
  fi
  exit "$STATUS"
fi

try waterx-predict order reconcile --executionId "$EXECUTION_ID" --timeoutMs 120000
if [ "$STATUS" -eq "$EXIT_AMBIGUOUS" ]; then
  say "Still not terminal. The order stands; no exit is armed against a fill nobody has seen."
  say "  waterx-predict order reconcile --executionId $EXECUTION_ID"
  exit "$EXIT_AMBIGUOUS"
fi

try waterx-predict order get --executionId "$EXECUTION_ID"
say "Entry: $(field data.execution.status), $(field data.execution.fill.filledShares) shares at $(field data.execution.fill.avgFillPrice)."
if [ "$(field data.execution.status)" != "FILLED" ]; then
  say "The entry did not fill, so there is nothing to arm an exit against."
  exit "$EXIT_REJECTED"
fi

# ── 4. the position the entry created ────────────────────────────────────────
# Attribution is not instant. Bounded polling, and an honest answer if it has not
# appeared: an exit armed against a guessed position id is worse than no exit.
POSITION_ID=""
ATTEMPT=0
while [ "$ATTEMPT" -lt 5 ] && [ -z "$POSITION_ID" ]; do
  try waterx-predict account positions --accountId "$ACCOUNT_ID" --limit 10
  INDEX=0
  while [ "$INDEX" -lt 10 ]; do
    if [ "$(field data.positions.$INDEX.marketId)" = "$MARKET_ID" ] &&
      [ "$(field data.positions.$INDEX.outcomeId)" = "$OUTCOME_ID" ]; then
      POSITION_ID="$(field data.positions.$INDEX.positionId)"
      break
    fi
    INDEX=$((INDEX + 1))
  done
  ATTEMPT=$((ATTEMPT + 1))
  if [ -z "$POSITION_ID" ]; then sleep 2; fi
done

if [ -z "$POSITION_ID" ]; then
  say "The fill is not attributed to a position yet. The entry stands; nothing was lost."
  say "Arm the exit once it appears:  ./target-exit.sh $EXIT_TARGET 0.5 $EXPIRES_IN_HOURS"
  exit "$EXIT_UNAVAILABLE"
fi
say "Position: $POSITION_ID"

# ── 5. the exit, armed to outlive this shell ─────────────────────────────────
EXIT_STRATEGY="$(
  cat <<JSON
{
  "ownerAddress": "$OWNER_ADDRESS",
  "accountId": "$ACCOUNT_ID",
  "strategyId": "$STRATEGY_LABEL-exit",
  "expiresAt": "$EXPIRES_AT",
  "trigger": { "kind": "PRICE", "targetPrice": "$EXIT_TARGET" },
  "legs": [
    {
      "marketId": "$MARKET_ID",
      "outcomeId": "$OUTCOME_ID",
      "side": "SELL",
      "positionId": "$POSITION_ID",
      "sellFractionOfPosition": "0.5",
      "maxSlippageBps": $MAX_SLIPPAGE_BPS
    }
  ]
}
JSON
)"
try waterx-predict strategy create --input "$EXIT_STRATEGY"
EXIT_STATUS="$STATUS"
EXIT_JOB="$(field data.strategy.jobId)"

if [ "$EXIT_STATUS" -eq "$EXIT_AMBIGUOUS" ]; then
  say "AMBIGUOUS: the exit create had no answer. Do NOT re-run this script."
  say "  waterx-predict strategy list --strategyId $STRATEGY_LABEL-exit"
  exit "$EXIT_AMBIGUOUS"
fi
if [ -z "$EXIT_JOB" ]; then
  say "The exit was refused: $(field error.code) — $(field error.message)"
  say "THE ENTRY STANDS AND IS UNPROTECTED. Arm an exit by hand: ./target-exit.sh"
  exit "$EXIT_STATUS"
fi

say "Exit armed: job $EXIT_JOB, sells half at $EXIT_TARGET, expires $EXPIRES_AT."
if [ "$EXIT_STATUS" -eq "$EXIT_UNAVAILABLE" ]; then
  say "ARMED AND ASLEEP: nothing is driving this Runner. Missing: $(field data.driverGaps)."
  say "The position is NOT protected until a driving Runner is up."
fi

# ── 6. the record ────────────────────────────────────────────────────────────
try waterx-predict strategy get --jobId "$EXIT_JOB"
printf '%s\n' "$OUT"

say ""
say "Bought $BUY_AMOUNT at or under $ENTRY_CEILING; selling half at $EXIT_TARGET; watching until $EXPIRES_AT."
say "Watch the same price this job is watching:"
say "  node ../../sdk/examples/watch-quotes.mjs --marketId $MARKET_ID --outcomeId $OUTCOME_ID --side SELL --target $EXIT_TARGET"
say "Stop it:"
say "  waterx-predict strategy cancel --jobId $EXIT_JOB --reason 'thesis changed'"
