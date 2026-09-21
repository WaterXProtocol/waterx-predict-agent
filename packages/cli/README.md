# `waterx-predict` — the universal agent surface

The CLI is how a model, a shell script or a function-calling adapter reaches
WaterX Predict without linking against TypeScript. Every invocation writes
**exactly one JSON document to stdout** and exits with a **stable code**, so a
caller that cannot parse JSON can still branch, and a caller that can never has
to scrape prose.

**This build trades, and what it may sign is decided by an enforced execution
policy rather than by convention.** The default policy is `interactive`: every
write needs one explicit approval naming the exact order. `read-only` is
enforced in the signer — `signTransaction` refuses before a signer process is
started, so no code path can produce a transaction signature — and
`delegated-auto` writes unattended only inside a scope an operator wrote down.
See [Execution policy](#execution-policy).

The package is `private: true` and is never published to a registry. It is run
from the workspace, or installed from the operator bundle — one tarball with the
SDK and the schema inside it (`pnpm cli:bundle`, ADR-0010, Accepted; no bundle
has been released yet):

```sh
npm install <release-asset-url>/waterx-predict-agent-cli-<version>.tgz \
            <release-asset-url>/waterx-predict-agent-signer-keystore-<version>.tgz
npx --no waterx-predict next --json
```

The second tarball is the keystore signer (ADR-0012). `next` sees what of it is
done on this machine and hands the operator the rest as commands — `init`
(a new agent wallet), `agent` (unlock once, leave it running), and the two
settings, with the wallet address filled in.

Keep `--no`: without it `npx` goes to the public registry when the binary is not
installed.

## Quickstart

An agent host installs both binaries from the repository (ADR-0019):

```sh
npm install github:WaterXProtocol/waterx-predict-agent
npx --no waterx-predict next --json   # and do what it says
```

npm warns that the root `prepare` script is not covered by `allowScripts`. That
script is what builds this workspace, so an install that skips it leaves nothing
to run — approve it, or use the release artifacts, which need no install script.

**Every answer points somewhere.** `meta.nextCommand` is on every envelope,
success or refusal, and whatever is in it runs exactly as printed — a command
needing a value only a person can choose (`<placeholder>`) or a person's consent
(`--yes`) is never put there, and the fallback is `waterx-predict next`, which
answers in every state (ADR-0022).

`next` answers with two lists. `handOver.steps` are a person's — installing
software, unlocking a sealed keystore, choosing a network, the owner's grant.
`agentSteps` are the ones a host may run itself, and on a fresh machine they are
the whole rest of the setup (ADR-0020):

```sh
npx --no waterx-predict-keystore init --no-passphrase  # a NEW, empty agent wallet
npx --no waterx-predict configure --fromKeystore       # persist which wallet, and who signs
npx --no waterx-predict next --json                    # → AWAITING_OWNER: now a person
```

`configure` is the only command that writes settings, and it writes exactly two:
the agent wallet and the signer command. It will not write the network, the
policy or the account — those decide whether real money moves. It writes a file
rather than suggesting `export` because a tool host runs every command in its own
process, where an exported variable is gone by the next call.

From a checkout, build and alias instead:

```sh
pnpm --filter @waterx/predict-agent-cli build
alias waterx-predict='node packages/cli/dist/src/main.js'

# 0. Ask where this agent stands. Works with nothing configured; see `next` below.
waterx-predict next --json

# 1. Ask what this thing is. No configuration, no network, no signer.
waterx-predict describe

# 2. Configure. The signer is an external command; no key enters this process.
#    With no deployment named this CLI uses MAINNET (ADR-0011) and says so on
#    every answer. To practise, name testnet.
#    Direct mode is the default (ADR-0013): public routes, no login, no Agent
#    API. WATERX_PREDICT_MODE=agent-api selects the authenticated Agent API.
export WATERX_PREDICT_ENVIRONMENT=testnet   # or mainnet; unset means mainnet
export WATERX_PREDICT_AGENT_WALLET='0x<64 hex>'
export WATERX_PREDICT_SIGNER_COMMAND='/path/to/your-signer'
#    …or persist the last two, which is what an unattended host does:
#    waterx-predict configure --agentWallet 0x<64 hex> --signerCommand '["/path/to/your-signer"]'

# 3. Get authorized. Prints the link an OWNER opens; --wait polls until they sign.
waterx-predict onboard --label momentum-bot --wait
#    → the accountId comes back from the server. Nobody copies it out of a browser.

# 4. Check the setup before trusting any read from it.
waterx-predict doctor --accountId 0x<64 hex>

# 5. Read.
waterx-predict market list --limit 10 --tradeable
waterx-predict market get --marketId 0x<64 hex>
waterx-predict account status --accountId 0x<64 hex>

# 6. Preview a trade. This signs nothing and places nothing.
waterx-predict order preview --input '{
  "accountId": "0x…", "marketId": "0x…", "outcomeId": "YES",
  "side": "BUY", "size": { "buyAmount": "25.00" }, "maxSlippageBps": 100
}'

# 7. Execute it, carrying the approval the preview published and a fresh quote.
waterx-predict order execute --approve apv2_… --approver "Alice" --input '{ …, "referenceQuoteId": "…" }'
```

Steps 1 and 2 are in that order on purpose: discovery precedes setup, because a
runtime you must configure before you may ask what it needs is a runtime you are
guessing at. Steps 6 and 7 are in that order because a write here is never the
incidental result of a single call.

Step 3 is the only one that addresses a person. Of the three things that must
exist before a write is accepted, two are automatable and one is not:

| | Who | Automated |
| --- | --- | --- |
| Account id | the owner's | **Yes** — `account list` answers for it |
| On-chain delegation | the owner signs, with their own wallet | **No**, and never (ADR-0003) |
| Risk profile (the mandate) | the owner | Yes, in the same signing session |

`onboard` prints a link that names this agent wallet and carries no token, no
secret and no pre-authorization — it confers no authority, because
everything it can do the owner does with their own wallet. This CLI cannot sign a
delegation, write a risk profile or raise a limit; a runtime that could grant its
own authority would make the authority meaningless.

Its statuses are chosen so nobody is sent to do the wrong thing:
`DELEGATION_MISSING` is the owner's to fix, `DELEGATION_UNKNOWN` means the chain
read **failed** and is not a refusal, `SUSPENDED` will not be fixed by signing
again, and `AMBIGUOUS` means more than one account is ready — choosing whose
money is traded is not this CLI's call. A `--wait` that runs out is not a failure
either: run it again.

## `next` — the loop

`waterx-predict next --json` is what an agent host runs, obeys, and runs again.
It answers in every state with exit 0 — the exit code says it answered, and
`data.state` says where things stand:

| State | Who acts | What it suggests |
| --- | --- | --- |
| `SETUP_INCOMPLETE` | operator | the settings to supply (`handOver.settings`) — the wallet and signer; the network defaults to mainnet unless a name it does not know was given. Nothing is sent |
| `SESSION_FAILED` | agent | `doctor` |
| `AUTHORIZATION_UNKNOWN` | agent | ask again — a failed read is not a refusal |
| `AWAITING_OWNER` | owner | hand over `handOver.authorizationUrl`, then `onboard --wait` |
| `ACCOUNT_CHOICE_NEEDED` | operator | ask the user which account (`needsFromUser`) |
| `ACCOUNT_UNREADABLE` | agent | ask again; no order until the account is read |
| `UNSETTLED_EXECUTION` | agent | `order reconcile` for each — before anything new |
| `STRATEGY_NEEDS_ATTENTION` | agent, or operator if the Runner is not driving | `strategy get` / `strategy list` |
| `TRADING_BLOCKED` | owner, or agent for a rolling window | `account risk-limits` |
| `READY` | agent | `market search` and `order preview`, with what the user must choose in `needsFromUser` |

`facts.deployment` says which network this is and why: `source: "DEFAULT"`
means nobody named one and this is mainnet (`realFunds: true`). A host tells
the user before the first preview.

Three guarantees, each tested: every suggestion is a **read** in the contract,
carried as `command`, `input` and `argv` the CLI accepts back; `stop: true`
means hand `handOver` to the named person and do not act for them; and the
states are checked worst-first, so nothing new is ever suggested beside an
order of unknown outcome. Its only signature is the login challenge.

## The envelope

```json
{
  "schemaVersion": "1",
  "ok": true,
  "command": "market.list",
  "requestId": "…",
  "data": { "markets": [], "count": 0, "caveats": ["…"] },
  "meta": { "defaultsApplied": { "accountId": "0x…" } }
}
```

On failure, `data` is absent and `error` is present:

```json
{
  "ok": false,
  "error": {
    "code": "MARKET_CLOSED",
    "message": "…",
    "retryable": false,
    "source": "SERVER",
    "details": {}
  }
}
```

- **One document, always.** A crash anywhere still produces a parseable
  envelope; only `ok`, `error` and the exit code change.
- **`command`** is the contract command name (`market.list`) when the invocation
  resolved to one. A refused capability has no contract entry — deliberately, so
  an adapter cannot advertise it — so it reports the invocation instead
  (`market history`).
- **`error.source`** says whose namespace `error.code` belongs to: `CLI` for
  this runtime's own refusals, `SERVER` for the exchange's, `TRANSPORT` when no
  response was seen at all.
- **`retryable`** is copied from the server when the server said it. This CLI
  does not decide on the server's behalf.
- **`requestId`** is generated locally and correlates stdout with stderr for one
  invocation. This API version returns no server-side trace id, so none is
  reported.
- **stderr** carries warnings and signer diagnostics. It is never part of the
  result, and stdout is never mixed with it.

## Exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | `OK` | Succeeded; the envelope has `ok: true`. |
| 1 | `USAGE` | Malformed invocation. Nothing was attempted. |
| 2 | `INVALID_INPUT` | The input failed the command schema. Nothing was sent. |
| 3 | `CONFIG` | Configuration missing, unusable, or holding a credential. |
| 4 | `AUTH` | Authentication failed, or the signer produced no signature. |
| 5 | `POLICY` | A limit, delegation or local policy refused. Retrying will not help. |
| 6 | `NOT_FOUND` | The named entity does not exist. |
| 7 | `UNAVAILABLE` | No quote, market closed, no Runner listening, or the capability has no endpoint behind it. |
| 8 | `RATE_LIMITED` | Back off and retry. |
| 9 | `TRANSPORT` | The request did not complete. No response was seen. |
| 10 | `REJECTED` | The server refused, definitively. |
| 11 | `AMBIGUOUS` | The outcome is unknown. Reconcile before deciding anything — `order get`, or `strategy list` after a create. |
| 70 | `INTERNAL` | A bug in this CLI. |

`describe` publishes this table verbatim under `exitCodes`, so a host does not
have to hard-code it. `AMBIGUOUS` is separate from `REJECTED` deliberately: it
means the runtime does not know whether the intent took effect, and retrying on
it without reconciling is how an agent places the same order twice.

## Commands

| Command | Status |
| --- | --- |
| `describe`, `command-schema`, `doctor` | available; the first two need no network |
| `onboard` | available; prints the owner's authorization link and reports what is still missing |
| `account list` | available; the only account read that needs no `accountId` |
| `market list`, `market get`, `market quote` | available |
| `market search` | available; the **server** resolves the text, exits 11 unless exactly one matched |
| `account status`, `account allowance`, `account positions`, `account executions`, `account fills` | available |
| `account risk-limits` | available; reads the mandate, cannot raise it |
| `account performance` | available; **API-attributed only**, with the excluded populations counted rather than hidden |
| `order preview` | available; places nothing, signs nothing |
| `order execute`, `order execute-many` | available; subject to the execution policy |
| `order get`, `order reconcile` | available; reads only |
| `market history` | **refused** — `NO_SERVER_ENDPOINT` (D-25) |
| `order cancel` | **refused** — `NO_SERVER_ENDPOINT`; a market order is filled or refused, never resting |
| `strategy create`, `strategy get`, `strategy list`, `strategy cancel`, `strategy events` | available; they talk to a **local Runner**, not to the exchange |
| `runner` | not implemented in this build; nothing here starts or supervises a daemon |

A refusal exits 7 with `error.code` `CAPABILITY_UNAVAILABLE` and a symbolic
`reason`, and it makes **no network call at all**. `market history` is the
clearest case: there is no endpoint that returns a price series, and a CLI that
assembled one out of repeated catalog reads would be publishing a history it
invented.

`market search` and `account risk-limits` were both on that list and are not any
more. The only thing that moves a command off it is a **server endpoint**, never
the client learning to approximate one:

- `market search` sends the text to `?search=` and reports the server's
  `resolution` verbatim. It never matches, scores or tie-breaks locally, and it
  never fills in a `marketId` the server left null. Anything but a unique match
  exits 11 (`AMBIGUOUS`) with `marketId: null` — the read succeeded, the
  identity did not. Candidate order is a reproducible tie-break (match
  specificity, then the round clock, then the id); it is not a ranking of which
  market is worth trading, and nothing here is trading advice.
- `account risk-limits` reads the effective mandate an owner granted this agent:
  the limits, the hour already consumed, the on-chain delegation, and what would
  refuse a write right now. It is **read-only by construction** — risk-profile
  writes stay with the owner-authenticated UI/API (ADR-0003), and an agent
  credential cannot raise its own limit. `limits: null` reports
  `{ "available": false, "reason": "NO_RISK_PROFILE" }`: absence is denial, not
  an unlimited default. A `null` delegation permission means the chain read
  **failed**, which is not the same as `false`.

## `onboard --open`

`onboard` prints the authorization link and stops. `--open` also hands it to
this machine's browser.

It is a **terminal affordance, and only that**. `--open` is a dispatcher flag,
so it is neither a field in any command's input schema nor an entry in the
adapters' operator-flag allowlist — a model host cannot request it and an
adapter cannot pin it. That is the same posture `--approve` has, for a related
reason: the link opens on the operator's desktop, and the person who has to see
that page is the ACCOUNT OWNER, who is frequently somewhere else entirely.

It refuses rather than guesses. No `DISPLAY` or `WAYLAND_DISPLAY` on Linux, `CI`
set, a platform this runtime has not been verified on — each is reported on
stderr and the command still succeeds, because the link above it is just as
valid and failing the command would throw away the answer that was asked for.

The outcome is on stderr and nowhere else. It is a fact about this terminal
rather than about the onboarding state, and a program driving this cannot pass
the flag in the first place.

## What `doctor` reports

Two things, and they answer different questions.

**`checks`** say what happened, as PASS, FAIL or SKIP. SKIP is load-bearing: a
check that could not run because a prerequisite failed is not a pass, and
reporting it as one is how an operator concludes a broken setup is healthy.

**`requirements`** say what to do, as fields rather than as a sentence a caller
has to parse. The six things that must exist before this runtime may trade,
each with `suppliedBy`, `why`, `supplyWith` and `settledBy`, plus `missing`,
`unchecked` and one `nextStep`. It is the same list
`@waterx/predict-agent-sdk`'s `describeInstallation()` reports before anything is
configured — one list, so an agent holding only the library and an operator
running `doctor` are never told two different stories. `doctor` settles three
more of them, because it can authenticate and read what an owner has granted.

`UNCHECKED` is not a soft `MISSING`. It means this invocation had no way to
look — no session, or a listing that failed — and reporting an owner's
delegation as absent on that basis sends a person to re-sign a grant they may
already have made. A `mayPlaceOrder` of `null` is the same fact one level down:
the chain read failed, so the requirement stays `UNCHECKED`.

**An outstanding grant is not a failing `doctor`.** A machine whose
configuration and signer are sound, waiting on a delegation nobody has signed
yet, is not a broken machine — the exit code keeps meaning "your setup is
wrong", and `nextStep` says "your owner has not signed yet". They are different
actions by different people, and `waterx-predict onboard` is where the second
one starts.

## Execution policy

What this runtime may sign, and on whose say-so. Three modes:

| Mode | Writes | How it is enforced |
| --- | --- | --- |
| `read-only` | none | `signTransaction` refuses **before a signer process is spawned**. Not a promise to behave — the build cannot produce a transaction signature. |
| `interactive` *(default)* | one approval per order | `order preview` publishes an approval token; `order execute` refuses without it. |
| `delegated-auto` | inside a stated scope | Every order is checked against ceilings the operator wrote down. Anything the scope does not name is refused. |

Set it in the config file (`policy.mode`), or with `WATERX_PREDICT_POLICY`, or
per invocation with `--policy`. **`--policy` may only narrow.** Widening is a
change to the configuration, made deliberately and in one place, so
`--policy read-only` on a delegated-auto machine is a useful safety belt and
`--policy delegated-auto` on an interactive one is a `CONFIG_INVALID` error.

Two independent things stand between a policy decision and a signature. The
policy check refuses the order; the **signing gate** then hands the signer
exactly as many permits as it authorized orders, and the signer consumes one per
transaction. A code path that reached the signer without being authorized would
not merely skip a check — it would run out of permits and refuse.

### The approval token

```sh
waterx-predict order preview --input '{…}'   # → data.policy.approvalToken: "apv1_…"
waterx-predict order execute --approve apv2_… --approver "Alice" --input '{…}'
```

The token is a digest of the **normalized intent** — account, market, outcome,
side, size unit and amount, position, slippage budget and worst acceptable
price. Change any of them and it stops matching, so an approval obtained for a
small buy cannot be carried onto a large one. The reference quote id is
deliberately *not* part of it: a quote lives seconds, and binding an approval to
one would make every approval stale before it could be used.

**It is not authentication.** Any caller that can run `order preview` can
compute it. Its job is to make a write impossible as the incidental side effect
of a single call: a host has to carry a value from the preview to the execution,
and a human-in-the-loop host puts the human at exactly that seam. Every place
this CLI reports a token says so, because a policy believed to be stronger than
it is, is worse than none.

### A delegated-auto scope

```jsonc
{
  "policy": {
    "mode": "delegated-auto",
    "scope": {
      "accounts": ["0x…"],          // required; "any account" is not a scope
      "markets": ["0x…"],           // optional allowlist
      "sides": ["BUY"],
      "maxBuyAmount": "50",         // required when BUY is allowed
      "maxCumulativeBuyAmount": "200",
      "maxSellShares": "100",       // required when SELL is allowed
      "maxSlippageBps": 200,
      "maxLegs": 5,
      "notAfter": "2026-09-01T00:00:00Z"
    }
  }
}
```

Every ceiling that applies to an allowed side is **mandatory**: an optional
ceiling is one somebody forgets, and a forgotten ceiling in an auto-approving
policy is an unbounded one, so an incomplete scope is refused at load time.
`delegated-auto` with no scope at all is a configuration error, not a blank
cheque, and every result under it carries a `meta.warnings` line naming the
policy and its end instant.

Scope checks run **locally first**, so an out-of-scope order costs no request at
all. A BUY is then additionally checked against the server's own
`effectiveBuyCapacity`: local policy can narrow what the exchange allows and can
never widen it. The owner's risk profile is enforced by the server regardless —
this CLI constrains what it will *ask for*, and never claims a delegation the
server granted (ADR-0003).

## The write plane

- **`order preview`** resolves the market on the server, mints a quote, computes
  the price-protection bound, reports capacity, and reports what the policy would
  decide — and **places and signs nothing**. It answers under `read-only` too,
  where it reports the refusal instead of performing it.
- **`order execute`** normalizes the intent, authorizes it, grants exactly one
  permit, then creates → signs → submits under **one idempotency key**. Pass
  `--input '{"idempotencyKey": "…"}'` to make a retry replayable across a
  restart; omit it and the SDK mints one.
- **`order get`** reads one execution. **`order reconcile`** waits for one to
  stop moving. Neither places, cancels or signs anything, so repeating them
  cannot cost anything.
- **`order execute-many`** runs independent legs with independent results.

**A timed-out wait is not a failure.** `order execute --input '{"waitFor":
"TERMINAL", "timeoutMs": 30000}'` that runs out returns `ok: true` with the
execution id, `execution.timedOut: true`, a `reconciliation` block, and **exit
11 (`AMBIGUOUS`)**. The order is on-chain and may still fill. Reconcile with
`order reconcile --executionId …`; never resubmit under a fresh idempotency key,
which places a second order.

**`execute-many` is never atomic**, and the result says so in a field
(`atomic: false`). Each leg carries its own quote, idempotency key, execution and
outcome, and each is reported `SUCCEEDED`, `FAILED` or `SKIPPED`. The whole batch
is authorized once, before any leg runs — so an out-of-scope leg refuses the
batch rather than trading the ones before it. `failurePolicy: "STOP"` prevents
legs that have not **launched** from launching; it cannot cancel or roll back one
already submitted. The exit code is the first failing leg's own class, so retry
logic does not have to branch on how the order was submitted — except that a leg
whose outcome is *unknown* outranks any known refusal, and the batch exits 11.
Retrying a batch on a refusal code while one leg is still filling is exactly the
mistake that ordering prevents.

**`preview` reports the mandate it would trade under, and can never raise it.**
Outside `read-only` mode it reads the effective limits alongside the quote and
returns them with the blockers, the delegation and the hour already consumed, so
a caller sees what would refuse a write *before* signing anything. That is a
report, not enforcement: the server decides, and this CLI does not pre-refuse on
a limit it merely read. Nothing is ever synthesized — a limit that was not read
says `{"available": false, "reason": "NOT_READ"}`, an account with no mandate
says `NO_RISK_PROFILE`, and neither is an unlimited default (ADR-0003).

## Strategies

The `strategy` family is the only one whose counterparty is **not the exchange**.
A durable conditional job — "buy when YES reaches 0.42" — is held by a `runnerd`
process on this machine: the price target, the job store and the signer all live
there, and nothing server-side stores a trigger. So these five commands are a
client for a local socket, and everything below follows from that.

```sh
INTENT="$(cat <<'JSON'
{
  "ownerAddress": "0x…",
  "accountId": "0x…",
  "agentWallet": "0x…",
  "expiresAt": "2026-08-20T00:00:00Z",
  "trigger": { "kind": "PRICE", "targetPrice": "0.42", "side": "BUY" },
  "legs": [{ "marketId": "mkt_…", "outcomeId": "YES", "side": "BUY",
             "buyAmount": "25.00", "maxSlippageBps": 150 }]
}
JSON
)"

waterx-predict strategy create --input "$INTENT"
waterx-predict strategy list --state PAUSED
waterx-predict strategy get --jobId job_…
waterx-predict strategy cancel --jobId job_… --reason 'thesis changed'
```

**Which Runner.** `--runner-dir`, else `WATERX_RUNNER_DIR`, else
`~/.waterx/runner`. The directory must exist, be owned by you and be mode `700`;
one another local account can read is **refused with exit 3 before anything is
dialled**, because a token another user can read lets their process stand in for
the Runner and be handed your wallet addresses and sizes. No Runner there at all
exits 7 and names the directory. A strategy is durable in *one* runtime
directory: a job created against another is elsewhere, not absent.

**Armed is not watching.** A Runner with no signer, no gateway or no price feed
still accepts a create and writes a real, durable job that nothing advances. When
that happens the envelope is `ok: true` with the real job id — you need it — and
the **exit code is 7**, with the missing pieces on stderr. Every reply carries
`runner.driving` for the same reason.

**A create with no answer is `AMBIGUOUS` (11), not a transport error.** The
Runner does **not** deduplicate creates — `strategyId` is an attribution label,
not an idempotency key — so a second create arms a second strategy that also
trades. On `CREATE_OUTCOME_UNKNOWN`, run `strategy list` and look for the job
before deciding anything. Nothing else in this CLI is retried this carefully;
nothing else in it can arm an unattended trade.

**A cancellation is recorded, and separately applied.** It is applied only if
that Runner holds the job's lease and no write has begun. `recorded: true,
applied: false` exits **11**, because an order already on its way to the chain
cannot be recalled and reporting the record as the stop would be a lie in exactly
that case.

**The rules are the Runner's, not this CLI's.** A mandatory `expiresAt` capped at
seven days, exactly one of the four sizing fields per leg, a percentage SELL
frozen to a share count at creation unless you asked for
`dynamicSellFractionOfPosition` — all of them are decided in one place, and this
CLI carries the symbolic refusal (`EXPIRY_REQUIRED`, `EXPIRY_TOO_FAR`,
`SIZE_AMBIGUOUS`) out unchanged. `--policy read-only` is the one local refusal: a
strategy signs and trades later, unattended, so this process will not arm one.

Under `describe`, `runner` remains **not implemented**: starting, stopping and
supervising the daemon is backlog 2.6. Run `runnerd` yourself, and keep the
device awake and online — a sleeping machine is a strategy that is not watching.

## Input

Three sources, applied in order: a JSON document (`--input '<json>'`, `--file
<path>`, `--stdin` — one at a time), then defaults this CLI can justify, then
typed flags. Flags win, because they are the most specific thing you typed.

Flag names are the schema's field names exactly: `--accountId`, `--marketId`,
`--limit`. A flag's value is converted to the type the command schema declares,
and a value that does not match is an **error, never a coercion** — `--limit
abc` fails rather than becoming `NaN` or `0`.

Structured fields cannot be flags; pass the whole document:

```sh
waterx-predict market quote --input '{
  "marketId": "0x…", "outcomeId": "YES", "side": "BUY",
  "size": { "buyAmount": "25.00" }
}'
```

**Money is a string.** Amounts, prices and sizes are decimal strings end to end,
because a JSON number cannot hold them exactly. **BUY commits a budget** via
`size.buyAmount`; **SELL closes shares** via `size.sellShares`. The two are never
interchangeable. An intent that could be read two ways — the wrong unit for the
side, both units at once, neither, a SELL naming no position, a BUY naming one —
is refused with **exit 2 (`INVALID_INPUT`)** and makes **no network call and no
signer call**. Guessing the unit here trades the wrong thing. (Exit 11
`AMBIGUOUS` is a different situation entirely: an unknown *outcome* after an
order may already exist. An ambiguous *intent* never gets that far.)

Any default this CLI supplies is reported back in `meta.defaultsApplied`, never
applied silently.

## Configuration

Precedence, lowest first: config file, environment, flags.

| Setting | Environment variable | Config key |
| --- | --- | --- |
| API base URL | `WATERX_PREDICT_BASE_URL` | `baseUrl` |
| Mode: `direct` (default) or `agent-api` | `WATERX_PREDICT_MODE` | `mode` |
| Sui network, for a host this build cannot name | `WATERX_PREDICT_NETWORK` | `network` |
| Direct-mode state directory (intent journal, market ids) | `WATERX_PREDICT_STATE_DIR` | — *(default `~/.waterx-predict`)* |
| Direct mode: deployment document, for a private deployment | `WATERX_PREDICT_DEPLOYMENT_URL` | `deploymentUrl` |
| Direct mode: Sui GraphQL endpoint | `WATERX_PREDICT_SUI_GRAPHQL_URL` | `suiGraphqlUrl` |
| Environment label | `WATERX_PREDICT_ENVIRONMENT` | `environment` |
| Agent wallet | `WATERX_PREDICT_AGENT_WALLET` | `agentWallet` |
| Default account | `WATERX_PREDICT_ACCOUNT_ID` | `defaultAccountId` |
| Signer command | `WATERX_PREDICT_SIGNER_COMMAND` | `signerCommand` |
| Execution policy | `WATERX_PREDICT_POLICY` | `policy` *(the scope is file-only)* |
| Timeout (ms) | `WATERX_PREDICT_TIMEOUT_MS` | `timeoutMs` |
| Session token | `WATERX_PREDICT_TOKEN` | — *(never in a file)* |

The file is `--config <path>`, else `$WATERX_PREDICT_CONFIG`, else
`$XDG_CONFIG_HOME/waterx-predict/config.json`, else
`~/.config/waterx-predict/config.json`.

**A config file containing a credential-shaped key is refused**, and the refusal
names the key path and never the value. An unknown key is refused too, rather
than ignored — a typo that silently disables a setting is worse than a stop.

## Direct mode (the default)

ADR-0013. The CLI trades the way `waterx-agent` (perps) does: the public,
unauthenticated WaterX routes, with the agent wallet as `delegateSender` on the
owner's account, and the backend sponsoring gas. There is no login, no session
token and no `/agent-api` request.

- **The grant is the on-chain delegation.** `onboard` prints the same console
  link; the owner picks an account and signs once. The page's limits step
  writes to the Agent API, which this mode does not use — if it fails after the
  wallet signed, the agent is still authorized.
- **Nothing is signed unread.** The sponsored bytes are decoded and checked
  against the intent: this wallet as sender, gas paid by someone else, only
  WaterX prediction calls at the deployment's current packages
  (`config.waterx.app`), the account, market, side, budget, price cap, share
  floor and expiry this CLI asked for. A mismatch is `TRANSACTION_REFUSED`
  (exit 10) and nothing is signed.
- **The ceiling is the execution policy.** There is no server-side risk
  profile, allowance or blocker list: `order preview` and `account status`
  report `DIRECT_MODE_NO_SERVER_MANDATE`, and `delegated-auto` is bounded by its
  scope alone.
- **Idempotency is local.** The intent journal
  (`~/.waterx-predict/direct-intents.json`, `0600`) records the transaction
  digest *before* submitting. A replay with the same `idempotencyKey` reads the
  order back; a new key is a new order. `next` holds on anything in that
  journal that has not settled.
- **Unavailable:** `account allowance`, `risk-limits`, `executions`, `fills`
  and `performance` answer `CAPABILITY_UNAVAILABLE` — no public route serves
  them. Positions cover the owner's main account only. Market ids are opaque
  handles (`wxp1.…`) from `market list` / `search`; execution ids are `dx1.…`.
- **Approvals name who gave them, and every decision is kept** (ADR-0018).
  `--approve` requires `--approver <name>`; issued and spent approvals, budget
  reservations, account adoptions and each write's executions are appended to
  `~/.waterx-predict/write-audit.jsonl` (`0600`, never rewritten).
  `doctor --probeWrite` also builds and verifies a close when a position is held.
- **Approvals are issued, expire and are spent once** (ADR-0014).
  `order preview` issues one into `~/.waterx-predict/write-ledger.json`
  (`0600`); it lasts ten minutes and authorizes exactly one write. A
  `delegated-auto` scope's `maxCumulativeBuyAmount` is counted in the same
  ledger, across invocations.
- **The chain is read first.** An order's state comes from the registry: an
  order that can no longer fill is `EXPIRED`, with `refund` saying its escrow
  waits for a cancel the owner makes. The deployed contract shapes are checked
  against the ones the verifier binds before anything is signed
  (`doctor` → `contract-shapes`); `doctor --probeWrite` has the backend build a
  1 wxUSD order and verifies it without signing (ADR-0015).
- **Accounts.** A grant the backend index has not listed is found from the
  chain's grant events, and a named account (`WATERX_PREDICT_ACCOUNT_ID`) is
  verified from its on-chain object. Once an account is in use, `next` never
  switches to another unless it is named.
- **Mainnet is read-only until the operator opts in** (ADR-0017). With no
  policy configured, mainnet reads and previews and places nothing.
  `waterx-predict policy` lists the three modes with what each allows, and the
  operator takes one with `waterx-predict policy set --mode interactive --yes`
  (ADR-0021). Narrowing needs no `--yes`; widening is a person's act, and
  `delegated-auto` is refused until a `policy.scope` is written down.

## The signer

No private key ever enters this process. The only provider is an external
command: the CLI writes one JSON line to the child's stdin and reads one JSON
document from its stdout.

```jsonc
// stdin, one line — the login challenge
{ "version": 1, "type": "PERSONAL_MESSAGE", "agentWallet": "0x…", "messageBase64": "…" }
// stdin, one line — a sponsored order
{ "version": 1, "type": "TRANSACTION", "agentWallet": "0x…", "transactionBytesBase64": "…" }
// stdout, for either
{ "signature": "<base64>" }
```

The child is spawned without a shell, fed on stdin, and killed on the deadline.
Its stderr is forwarded to this process's stderr, redacted, and never enters the
envelope. A non-zero exit, non-JSON stdout, a missing `signature` or a timeout is
`SIGNER_FAILED` (exit 4) — never a fabricated signature and never a silent
success.

The two `type`s are never interchangeable. `PERSONAL_MESSAGE` is the login
challenge, which moves no funds; `TRANSACTION` is sponsored order bytes, which
does. Sui's intent prefixes differ, so this signer cannot be tricked into
authorizing a transfer by being handed transaction bytes as a "message" — and a
signer that wants to refuse one kind can see which kind it was asked for.

A `TRANSACTION` request costs a permit from the signing gate, and **the permit
is spent before the child is started**. A gate checked afterwards would already
have produced the signature it existed to prevent. Under `read-only`,
`signTransaction` throws without spawning anything at all, so no code path in
this build can produce a transaction signature.

Keystore, keychain and KMS providers are not implemented (backlog 1.8).

## Secrets

Tokens, signatures, signer stdin and the raw signer argv are never written to
stdout or stderr. A value that would leak is replaced with `[redacted]`,
including when the *server* echoes it back inside an error message. The signer
is reported by executable base name only, because an argument may be a path to a
key file. This is covered by `tests/secrets.test.ts`.

## Limitations

- A market order cannot be cancelled. There is no cancel endpoint, because a
  market order is filled or refused, never resting. `order cancel` says so
  rather than pretending to try.
- `execute-many` is never atomic. Legs succeed, fail or are skipped
  independently, and a partial batch is a normal outcome, not an error.
- A wait that times out is not a failure: it exits `AMBIGUOUS` (11) and the
  order may still fill. Reconcile it — never resubmit it.
- Risk limits are owner-authenticated. An agent credential may **read** its
  effective limits and can never raise them (ADR-0003); every write stays on the
  owner-authenticated controller and is not reachable from this CLI.
- The market catalog pages by `--limit` only. It has no cursor — the page is
  projected in memory and ordered partly by round-clock facts, so there is no
  stable key to anchor on — and `--cursor` is refused there rather than ignored.
  Account history (`positions`, `executions`, `fills`) does page by `--cursor`:
  each response carries `nextCursor` plus a `hasMore` reading, where `hasMore:
  null` means the server did not answer and the walk may be incomplete.
- Quotes are size-blind: `availableSize` and `expectedFillSize` come back null
  and a large order can be correctly priced and still fail to fill (backlog B5).
- Positions, executions and fills cover API-attributed activity only. A
  direct-chain trade by the same delegated key is not included.
- `serverCapabilities` in `describe` is this build's own static knowledge, not
  something the server advertised — there is no capability document to query
  (backlog B7). Prefer the server's own errors when they disagree.
- A strategy needs a `runnerd` running on this machine, and this CLI cannot
  start one (backlog 2.6). It also cannot keep the device awake: a laptop that
  sleeps is a strategy that stops watching, without saying so.
- Supported platforms are macOS and Linux. Windows is not claimed.

## Development

```sh
pnpm --filter @waterx/predict-agent-cli typecheck
pnpm --filter @waterx/predict-agent-cli test
pnpm --filter @waterx/predict-agent-cli build
```

Tests never open a socket, spawn a process or read a real file: every one goes
through `tests/harness.ts`, which replaces the process environment rather than
extending it, so a test cannot pass because the developer's machine happens to
be configured.

This package depends on `@waterx/predict-agent-schema` for validation and
`@waterx/predict-agent-sdk` for execution, never the reverse — a dependency test
in the workspace suite enforces the direction (ADR-0001 §4).
