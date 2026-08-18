#!/usr/bin/env bash
#
# Restart recovery: kill the Runner, start it again, and prove the job survived.
#
# A conditional order in this design is not a process — it is a ROW. The Runner
# owns a durable job store, and a strategy that is armed is armed whether or not
# any Runner is currently running. This example makes that observable, because
# "it kept working" is exactly the claim nobody should take on trust:
#
#   1. the job id and the strategy label are the SAME across the restart. A
#      recovered job is the same job, not a new one that looks like it;
#   2. the Runner instance id CHANGES. Without that, the script would happily
#      "prove" recovery against a process that never went away;
#   3. no duplicate appears. A restart that re-armed anything would show two
#      strategies under one label, and both of them would trade;
#   4. a write that was in flight when the process died is not silently forgotten:
#      it is an open side effect with no recorded outcome, and the Runner
#      reconciles it rather than assuming either answer. `strategy events` is
#      where that is visible.
#
# It does not prove that the job FIRES correctly after a restart. That needs a
# trigger to become true, which is the market's decision and not this script's.
#
# Requires: a non-production environment, a local Runner, and a strategy already
# armed on it. Places no order. Writes nothing except the cancellation you make
# yourself.
#
# The restart itself is the OPERATOR's: either export a command that performs it
#
#   export WATERX_RUNNER_RESTART='launchctl kickstart -k gui/$UID/waterx-runnerd'
#
# or leave it unset and restart the daemon by hand when this script asks.

cd "$(dirname "$0")"
. ./_lib.sh

require_configured
require_non_production
require_runner

JOB_ID="${1:-}"

# ── 1. something to recover ──────────────────────────────────────────────────
if [ -z "$JOB_ID" ]; then
  try waterx-predict strategy list --state WATCHING
  JOB_ID="$(field data.strategies.0.jobId)"
fi

if [ -z "$JOB_ID" ]; then
  say "NOT PROVISIONED: this Runner is holding no watching strategy to recover."
  say "  The OPERATOR arms one first — ./target-exit.sh — and passes its job id:"
  say "    ./restart-recovery.sh <jobId>"
  exit "$EXIT_CONFIG"
fi

try waterx-predict strategy get --jobId "$JOB_ID"
if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "No such job on this Runner: $(field error.code) — $(field error.message)"
  say "A job created against a different runtime directory is not absent, it is elsewhere."
  exit "$STATUS"
fi

BEFORE_STRATEGY_ID="$(field data.strategy.strategyId)"
BEFORE_STATE="$(field data.strategy.state)"
BEFORE_UPDATED_AT="$(field data.strategy.updatedAt)"
BEFORE_INSTANCE="$(field data.runner.instanceId)"
BEFORE_OPEN="$(field data.strategy.openSideEffects.length)"

say "Before: job $JOB_ID, label $BEFORE_STRATEGY_ID, state $BEFORE_STATE, updated $BEFORE_UPDATED_AT."
say "        runner $BEFORE_INSTANCE, leasedHere=$(field data.leasedHere), open side effects $BEFORE_OPEN."

# ── 2. the restart ───────────────────────────────────────────────────────────
# Nothing in this build supervises the daemon, so the restart belongs to whoever
# started it. This script will not background a runnerd of its own: a daemon
# spawned by an example is one nobody knows is running.
if [ -n "${WATERX_RUNNER_RESTART:-}" ]; then
  say "Restarting via WATERX_RUNNER_RESTART…"
  set +e
  sh -c "$WATERX_RUNNER_RESTART"
  RESTART_STATUS=$?
  set -e
  if [ "$RESTART_STATUS" -ne 0 ]; then
    say "The restart command exited $RESTART_STATUS. Nothing below would mean anything."
    exit "$EXIT_UNAVAILABLE"
  fi
else
  say ""
  say "Restart the Runner now: stop \`waterx-predict-runnerd\` and start it again."
  say "Press Enter when it is back up."
  read -r _ || true
fi

# ── 3. wait for it to answer again, with a bound ─────────────────────────────
# A bounded wait, because "the Runner is coming back" and "the Runner is not
# coming back" look identical for the first few seconds and only one of them
# should be waited on forever.
ATTEMPT=0
while [ "$ATTEMPT" -lt 30 ]; do
  try waterx-predict strategy list --strategyId "$BEFORE_STRATEGY_ID"
  if [ "$STATUS" -eq "$EXIT_OK" ]; then break; fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "No Runner answered within 30s. The job is still in the store; nothing is advancing it."
  exit "$EXIT_UNAVAILABLE"
fi

HOLDING="$(field data.strategies.length)"
AFTER_INSTANCE="$(field data.runner.instanceId)"

# ── 4. what survived, and what must not have been duplicated ─────────────────
try waterx-predict strategy get --jobId "$JOB_ID"
if [ "$STATUS" -ne "$EXIT_OK" ]; then
  say "The job did NOT survive the restart: $(field error.code) — $(field error.message)"
  exit "$EXIT_REJECTED"
fi

AFTER_STATE="$(field data.strategy.state)"
say "After:  job $JOB_ID, label $(field data.strategy.strategyId), state $AFTER_STATE."
say "        runner $AFTER_INSTANCE, leasedHere=$(field data.leasedHere), open side effects $(field data.strategy.openSideEffects.length)."

if [ "$BEFORE_INSTANCE" = "$AFTER_INSTANCE" ]; then
  say "The Runner instance id did not change, so nothing was actually restarted."
  say "This run proves NOTHING about recovery. Restart it for real and try again."
  exit "$EXIT_REJECTED"
fi

if [ "$HOLDING" != "1" ]; then
  say "Expected exactly one strategy under label $BEFORE_STRATEGY_ID, found $HOLDING."
  say "More than one means something re-armed on start, and every copy of it trades."
  exit "$EXIT_REJECTED"
fi

say "Survived: same job, same label, new Runner process, no duplicate."

# ── 5. the part a state field cannot tell you ────────────────────────────────
# An attempt with no recorded outcome is the evidence that a request may have
# left the Runner unanswered. It is neither a fill nor a failure, and the Runner
# reconciles it against the exchange rather than guessing.
try waterx-predict strategy events --jobId "$JOB_ID"
printf '%s\n' "$OUT"

say ""
say "The strategy is still armed. To stop it:"
say "  waterx-predict strategy cancel --jobId $JOB_ID --reason 'done with the example'"
