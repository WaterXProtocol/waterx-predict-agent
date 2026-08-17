#!/usr/bin/env bash
#
# Delegation revocation: what an owner taking the mandate away looks like from
# inside the agent, and the one distinction that must never be collapsed.
#
#   mayPlaceOrder: true   the owner granted it
#   mayPlaceOrder: false  the owner did NOT grant it, or revoked it
#   mayPlaceOrder: null   the ON-CHAIN READ FAILED — the state is UNKNOWN
#
# `null` is not a revocation. An agent that treated it as one would tear down a
# perfectly healthy position because an RPC node was briefly unreachable; an
# agent that treated it as permission would trade on a mandate it never
# confirmed. Neither is acceptable, so `null` means STOP AND DO NOT DECIDE.
#
# This example READS. It never grants, revokes or widens anything: those are
# owner-authenticated operations, and an agent runtime able to perform them would
# make the delegation meaningless (ADR-0003 §1).
#
# Read-only. Places no order. Safe to run anywhere it is configured.

cd "$(dirname "$0")"
. ./_lib.sh

require_configured

# One read carries the whole mandate: the delegation, the owner's risk profile,
# the allowance ledger and the current usage against it.
try waterx-predict account risk-limits --accountId "$ACCOUNT_ID"

if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "Could not read the mandate: $(field error.code) — $(field error.message)"
  say
  say "This is NOT evidence that the delegation was revoked. Nobody got an answer."
  exit "$STATUS"
fi

MAY_PLACE="$(field data.delegation.mayPlaceOrder)"
LIMITS_AVAILABLE="$(field data.limits.available)"

say "Delegation checked at: $(field data.delegation.checkedAt)"
say

case "$MAY_PLACE" in
  true)
    say "GRANTED: the agent wallet may place orders on this account."
    ;;
  false)
    # A revoked delegation is a first-class state, not an error. Everything
    # already submitted stays submitted — revocation stops NEW writes; it does
    # not unwind an order that is already on chain.
    say "REVOKED (or never granted): the agent wallet may NOT place orders."
    say
    say "What this does and does not mean:"
    say "  - New writes will be refused. Reads continue to work."
    say "  - Orders ALREADY submitted are unaffected. Reconcile them; do not assume they died:"
    say "      waterx-predict account executions --accountId $ACCOUNT_ID --limit 20"
    say "  - Only the ACCOUNT OWNER can restore it, in an owner-authenticated session."
    say "    This runtime must not, and cannot, do it."
    ;;
  "")
    # The tri-state's whole reason for existing.
    say "UNKNOWN: the server could not read the delegation from chain."
    say
    say "This is NOT a revocation. Nothing has been decided, so decide nothing:"
    say "  - Do not place new orders — the mandate is unconfirmed."
    say "  - Do not close positions — there is no evidence anything changed."
    say "  - Retry the read. If it stays unknown, that is an infrastructure problem"
    say "    to escalate, not a signal to trade on."
    exit "$EXIT_AMBIGUOUS"
    ;;
  *)
    say "Unexpected delegation state: $MAY_PLACE"
    exit "$EXIT_AMBIGUOUS"
    ;;
esac

say

# The second half of the mandate, and a separate question. A delegation without a
# risk profile is an agent that authenticates and is then bounded by nothing it
# can read — which the contract answers by refusing, not by defaulting to open.
if [ "$LIMITS_AVAILABLE" = "true" ]; then
  say "Risk profile: max order $(field data.limits.maxOrderAmount), max slippage $(field data.limits.maxSlippageBps) bps,"
  say "              $(field data.limits.maxOrdersPerHour) orders/h, suspended=$(field data.limits.isSuspended)."
else
  say "NO RISK PROFILE: $(field data.limits.reason)"
  say
  say "Absence is denial, not an unlimited default. The agent is simply not"
  say "onboarded on this account (ADR-0003 §5)."
  say
  say "The ACCOUNT OWNER supplies it, owner-authenticated:"
  say "  PUT accounts/$ACCOUNT_ID/agents/<agentWallet>/risk-profile"
  say
  say "This harness must not attempt it. Widening a limit is an owner operation"
  say "and stays one."
fi

say
# Blockers are plain codes, and an EMPTY list is not a promise of a fill: it says
# the limits published here do not currently refuse an order. The chain decides
# the rest.
if [ "$(field data.tradingBlocked)" = "true" ]; then
  say "Trading is currently blocked. Codes:"
  printf '%s' "$OUT" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      for (const code of JSON.parse(raw).data.blockers) process.stderr.write(`  ${code}\n`);
    });
  '
else
  say "No blockers reported — which is not a promise that an order would fill."
fi
