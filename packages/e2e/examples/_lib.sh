# Shared helpers for the examples. Source it; do not run it.
#
# Dependency-free on purpose: `node` is already required to run the CLI at all,
# so an example that also needed `jq` would fail on a machine where the thing
# being demonstrated works perfectly.
#
# Put the CLI on PATH first:
#   export PATH="$PWD/packages/e2e/node_modules/.bin:$PATH"

set -euo pipefail

# The exit codes this CLI uses. Named, because `[ "$STATUS" -eq 11 ]` in an
# example teaches nobody anything.
EXIT_OK=0
EXIT_CONFIG=3
EXIT_POLICY=5
EXIT_UNAVAILABLE=7
EXIT_REJECTED=10
EXIT_AMBIGUOUS=11

# Runs its arguments, keeping the exit status instead of letting `set -e` end the
# script. Every command in this contract answers with one JSON envelope on EVERY
# path, failure included — so a non-zero exit still leaves something to read.
#
# Afterwards: $OUT is stdout, $STATUS is the exit code.
try() {
  set +e
  OUT="$("$@" 2>/dev/null)"
  STATUS=$?
  set -e
}

# Reads a dotted path out of the last envelope. Prints nothing for a missing or
# null value, so `[ -z "$(field …)" ]` is a usable test.
field() {
  printf '%s' "$OUT" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const found = process.argv[1]
        .split(".")
        .reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), JSON.parse(raw));
      process.stdout.write(found === undefined || found === null ? "" : String(found));
    });
  ' "$1"
}

# Notes go to stderr. stdout of an example belongs to whatever it produces.
say() { printf '%s\n' "$*" >&2; }

# Stops with an explanation when the runtime is not configured.
#
# Examples are read by people who have NOT finished onboarding, and "connection
# refused" is a worse answer than the list of what is missing and who supplies
# it. `describe` is the right question: it needs no configuration and no network.
require_configured() {
  try waterx-predict describe
  if [ "$STATUS" -ne "$EXIT_OK" ]; then
    say "The CLI is not installed or not built. Run \`pnpm build\` at the workspace root."
    exit "$EXIT_CONFIG"
  fi

  BASE_URL="$(field data.api.baseUrl)"
  if [ -z "$BASE_URL" ]; then
    say "NOT PROVISIONED: no API base URL."
    say "  OPERATOR supplies WATERX_PREDICT_BASE_URL, or \"baseUrl\" in ~/.config/waterx-predict/config.json."
    exit "$EXIT_CONFIG"
  fi

  ACCOUNT_ID="$(field data.identity.defaultAccountId)"
  if [ -z "$ACCOUNT_ID" ]; then
    say "NOT PROVISIONED: no default account id."
    say "  The ACCOUNT OWNER reads it from the WaterX account UI and hands it to the operator."
    say "  The agent cannot discover it; account scoping is not its choice to make."
    exit "$EXIT_CONFIG"
  fi

  ENVIRONMENT="$(field data.api.environment)"

  # `interactive`, `delegated-auto` or `read-only`. An example that places more
  # than one order in a call has to know which one it is running under: under
  # `interactive` an unapproved write is refused locally and costs nothing, and
  # under `delegated-auto` the same call TRADES.
  POLICY_MODE="$(field data.policy.mode)"
}

# Refuses to go on unless the deployment is labelled non-production.
#
# An UNLABELLED deployment is treated as production. That is the whole point of
# an allowlist: a label nobody anticipated is refused rather than trusted.
require_non_production() {
  case "${ENVIRONMENT:-}" in
    test | testnet | devnet | localnet | local | staging | sandbox)
      say "Environment: $ENVIRONMENT."
      ;;
    "")
      say "REFUSING: no environment label is configured, so this deployment is treated as production."
      say "  OPERATOR supplies WATERX_PREDICT_ENVIRONMENT=testnet."
      exit "$EXIT_CONFIG"
      ;;
    *)
      say "REFUSING: the environment is labelled \"$ENVIRONMENT\", which is not a known non-production one."
      exit "$EXIT_CONFIG"
      ;;
  esac
}

# The owner's Sui address, for the commands that arm something.
#
# Deliberately NOT defaulted from the configuration, and not derived from the
# agent wallet: nothing this process holds knows who the owner is, and inventing
# one would attribute a later trade to the wrong account. `accountId` and
# `agentWallet` are defaulted by the CLI; this is the one identity field that an
# ACCOUNT OWNER has to hand over.
require_owner_address() {
  OWNER_ADDRESS="${WATERX_PREDICT_OWNER_ADDRESS:-}"
  if [ -z "$OWNER_ADDRESS" ]; then
    say "NOT PROVISIONED: no owner address."
    say "  The ACCOUNT OWNER supplies their own 0x… Sui address; export it as"
    say "  WATERX_PREDICT_OWNER_ADDRESS. It is not defaulted and not derivable"
    say "  from the agent wallet — a strategy armed under the wrong owner is a"
    say "  trade attributed to the wrong account."
    exit "$EXIT_CONFIG"
  fi
}

# Stops unless a local Runner answers, and says whether it is DRIVING.
#
# Reachable is not running. A Runner with no signer, no gateway or no price feed
# still stores a strategy and still answers reads, and a job it holds is one
# nothing will ever advance. The distinction is on every reply, so an example
# that arms something has to look at it rather than at the exit code alone.
#
# Sets: RUNNER_INSTANCE_ID, RUNNER_DRIVING ("true" or "false").
require_runner() {
  try waterx-predict strategy list
  if [ "$STATUS" -eq "$EXIT_UNAVAILABLE" ]; then
    say "NOT PROVISIONED: no local Runner answered."
    say "  OPERATOR starts one in another terminal and leaves it running:"
    say "    waterx-predict-runnerd"
    say "  The Runner is self-hosted: this device stays awake and online, or"
    say "  nothing watches the market. There is no managed runner."
    exit "$EXIT_CONFIG"
  fi
  if [ "$STATUS" -ne "$EXIT_OK" ]; then
    say "The Runner refused a read: $(field error.code) — $(field error.message)"
    exit "$STATUS"
  fi

  RUNNER_INSTANCE_ID="$(field data.runner.instanceId)"
  RUNNER_DRIVING="$(field data.runner.driving)"
  say "Runner: $RUNNER_INSTANCE_ID, driving=$RUNNER_DRIVING."
}

# An ISO-8601 instant N hours from now, for `expiresAt`.
#
# `expiresAt` is mandatory and capped at seven days in this beta. The cap is
# REFUSED and never clamped, so this helper computes a real horizon rather than
# passing something the Runner would have to correct.
hours_from_now() {
  node -e 'process.stdout.write(new Date(Date.now() + Number(process.argv[1]) * 3600000).toISOString())' "$1"
}
