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

The package is `private: true` and publishes nothing yet (backlog 3.6). Run it
from the workspace.

## Quickstart

```sh
pnpm --filter @waterx/predict-agent-cli build
alias waterx-predict='node packages/cli/dist/src/main.js'

# 1. Ask what this thing is. No configuration, no network, no signer.
waterx-predict describe

# 2. Configure. The signer is an external command; no key enters this process.
export WATERX_PREDICT_BASE_URL='https://<your-agent-api-host>'
export WATERX_PREDICT_AGENT_WALLET='0x<64 hex>'
export WATERX_PREDICT_SIGNER_COMMAND='/path/to/your-signer'

# 3. Check the setup before trusting any read from it.
waterx-predict doctor --accountId 0x<64 hex>

# 4. Read.
waterx-predict market list --limit 10 --tradeable
waterx-predict market get --marketId 0x<64 hex>
waterx-predict account status --accountId 0x<64 hex>

# 5. Preview a trade. This signs nothing and places nothing.
waterx-predict order preview --input '{
  "accountId": "0x…", "marketId": "0x…", "outcomeId": "YES",
  "side": "BUY", "size": { "buyAmount": "25.00" }, "maxSlippageBps": 100
}'

# 6. Execute it, carrying the approval the preview published and a fresh quote.
waterx-predict order execute --approve apv1_… --input '{ …, "referenceQuoteId": "…" }'
```

Steps 1 and 2 are in that order on purpose: discovery precedes setup, because a
runtime you must configure before you may ask what it needs is a runtime you are
guessing at. Steps 5 and 6 are in that order because a write here is never the
incidental result of a single call.

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
| 7 | `UNAVAILABLE` | No quote, market closed, or the capability has no endpoint behind it. |
| 8 | `RATE_LIMITED` | Back off and retry. |
| 9 | `TRANSPORT` | The request did not complete. No response was seen. |
| 10 | `REJECTED` | The server refused, definitively. |
| 11 | `AMBIGUOUS` | The outcome is unknown. Reconcile before deciding anything. |
| 70 | `INTERNAL` | A bug in this CLI. |

`describe` publishes this table verbatim under `exitCodes`, so a host does not
have to hard-code it. `AMBIGUOUS` is separate from `REJECTED` deliberately: it
means the runtime does not know whether the intent took effect, and retrying on
it without reconciling is how an agent places the same order twice.

## Commands

| Command | Status |
| --- | --- |
| `describe`, `command-schema`, `doctor` | available; the first two need no network |
| `market list`, `market get`, `market quote` | available |
| `market search` | available; the **server** resolves the text, exits 11 unless exactly one matched |
| `account status`, `account allowance`, `account positions`, `account executions`, `account fills` | available |
| `account risk-limits` | available; reads the mandate, cannot raise it |
| `order preview` | available; places nothing, signs nothing |
| `order execute`, `order execute-many` | available; subject to the execution policy |
| `order get`, `order reconcile` | available; reads only |
| `market history` | **refused** — `NO_SERVER_ENDPOINT` (D-25) |
| `order cancel` | **refused** — `NO_SERVER_ENDPOINT`; a market order is filled or refused, never resting |
| `strategy`, `runner` | not implemented in this build |

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
waterx-predict order execute --approve apv1_… --input '{…}'
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
