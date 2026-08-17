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
