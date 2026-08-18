#!/usr/bin/env bash
#
# Target exit: arm a durable SELL that fires later, without you.
#
# This is the first example that leaves something behind. Everything before it
# finished when the script did; a strategy is a job in the local Runner's store
# that outlives this shell, survives a restart, and can move funds hours from now
# with nobody watching. That is why `strategy create` is a WRITE even though it
# places no order today.
#
#   1. a SELL sells a POSITION, so the positionId comes from the server — a
#      fraction of a position nobody read is a share count nobody chose;
#   2. `sellFractionOfPosition` freezes a share count NOW against that read. The
#      job sells the shares you meant, not a fraction of whatever the position
#      has grown into later. `dynamicSellFractionOfPosition` is the other mode,
#      and it is a different decision, not a default;
#   3. the trigger price is an EXECUTABLE bid floor for a SELL (and an ask
#      ceiling for a BUY) — not a mid, not a last trade;
#   4. `expiresAt` is mandatory and capped at seven days. The cap is refused,
#      never clamped: nothing here watches a market forever;
#   5. a Runner that answers is not a Runner that is DRIVING. An armed job on a
#      Runner with no price feed is armed and asleep, and the reply says so.
#
# Requires: a non-production environment, a local Runner, an owner address and an
# existing position. Places no order now. Arms one that can place an order later.

cd "$(dirname "$0")"
. ./_lib.sh

require_configured
require_non_production
require_owner_address
require_runner

TARGET_PRICE="${1:-0.80}"
SELL_FRACTION="${2:-0.5}"
EXPIRES_IN_HOURS="${3:-72}"
MAX_SLIPPAGE_BPS="${4:-100}"

# ── 1. the position this exit is for ─────────────────────────────────────────
# Newest first. A real strategy picks by market rather than by recency; the point
# here is that the id is READ, never constructed.
try waterx-predict account positions --accountId "$ACCOUNT_ID" --limit 5
if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "Could not read positions: $(field error.code) — $(field error.message)"
  exit "$STATUS"
fi

POSITION_ID="$(field data.positions.0.positionId)"
POSITION_MARKET="$(field data.positions.0.marketId)"
POSITION_OUTCOME="$(field data.positions.0.outcomeId)"
POSITION_SHARES="$(field data.positions.0.shares)"

if [ -z "$POSITION_ID" ]; then
  say "NOT PROVISIONED: this account holds no position the API attributed to this agent."
  say "  The OPERATOR opens one first — ./one-shot-entry.sh — and re-runs this."
  say "  Positions opened directly on chain by the same key are not listed here."
  exit "$EXIT_CONFIG"
fi

if [ -z "$POSITION_SHARES" ]; then
  # null shares means the settling event carried no share count. It is NOT zero,
  # and a fraction of an unknown count is not a size anyone chose.
  say "The position's share count is unknown, so a frozen fraction cannot be computed."
  say "Use an explicit sellShares leg, or wait for the fill to be observed."
  exit "$EXIT_REJECTED"
fi

say "Position: $POSITION_ID — $POSITION_SHARES shares of $POSITION_OUTCOME in $POSITION_MARKET."
say "Current sell-side price: $(field data.positions.0.currentPrice) (empty means no fresh quote)."

# ── 2. the horizon ───────────────────────────────────────────────────────────
EXPIRES_AT="$(hours_from_now "$EXPIRES_IN_HOURS")"
say "Expires: $EXPIRES_AT (${EXPIRES_IN_HOURS}h). Past that the job stops watching, and does not sell."

# ── 3. arm it ────────────────────────────────────────────────────────────────
# `legs` and `trigger` are structured, so the whole document goes through
# --input. `agentWallet` is defaulted from the configuration — it is the same
# wallet that will have to sign at the trigger — but `ownerAddress` is not, and
# is the one identity field the account owner has to state.
#
# A SELL target BELOW the current bid is not an error: it is already true, and
# the job fires at the next observation. If you mean "sell now", place an order.
STRATEGY_LABEL="target-exit-example"
STRATEGY="$(
  cat <<JSON
{
  "ownerAddress": "$OWNER_ADDRESS",
  "accountId": "$ACCOUNT_ID",
  "strategyId": "$STRATEGY_LABEL",
  "expiresAt": "$EXPIRES_AT",
  "trigger": { "kind": "PRICE", "targetPrice": "$TARGET_PRICE" },
  "legs": [
    {
      "marketId": "$POSITION_MARKET",
      "outcomeId": "$POSITION_OUTCOME",
      "side": "SELL",
      "positionId": "$POSITION_ID",
      "sellFractionOfPosition": "$SELL_FRACTION",
      "maxSlippageBps": $MAX_SLIPPAGE_BPS
    }
  ]
}
JSON
)"

try waterx-predict strategy create --input "$STRATEGY"
CREATE_STATUS="$STATUS"
JOB_ID="$(field data.strategy.jobId)"

if [ "$CREATE_STATUS" -eq "$EXIT_AMBIGUOUS" ]; then
  # No answer arrived. A create is NOT idempotent — strategyId is a label, not a
  # key — so a retry would arm a second strategy and both would sell.
  say "AMBIGUOUS: the outcome of the create is unknown. Do NOT re-run this."
  say "Look before deciding anything:"
  say "  waterx-predict strategy list --strategyId $STRATEGY_LABEL"
  exit "$EXIT_AMBIGUOUS"
fi

if [ -z "$JOB_ID" ]; then
  say "Refused: $(field error.code) — $(field error.message)"
  exit "$CREATE_STATUS"
fi

say "Armed: job $JOB_ID, state $(field data.strategy.state)."

if [ "$CREATE_STATUS" -eq "$EXIT_UNAVAILABLE" ]; then
  # The job is real and durable. Nothing is advancing it.
  say "ARMED AND ASLEEP: this Runner is not driving. Missing: $(field data.driverGaps)."
  say "The job above exists and will still be there when a driving Runner starts."
fi

# ── 4. read it back ──────────────────────────────────────────────────────────
# `leasedHere` says whether the Runner that answered is the one holding the job.
# A job leased nowhere is being advanced by nobody.
try waterx-predict strategy get --jobId "$JOB_ID"
say "State: $(field data.strategy.state), leasedHere=$(field data.leasedHere), pastExpiry=$(field data.strategy.expiry.pastExpiry)."

# The audit trail: every transition and every attempted side effect, including
# the ones with no recorded outcome. A snapshot, not a subscription.
try waterx-predict strategy events --jobId "$JOB_ID"
printf '%s\n' "$OUT"

say ""
say "This strategy is now armed and will outlive this shell. To stop it:"
say "  waterx-predict strategy cancel --jobId $JOB_ID --reason 'done with the example'"
say "A cancellation is RECORDED immediately; whether it was APPLIED is a separate"
say "fact in the same reply, and an order already on its way to the chain cannot"
say "be recalled."
