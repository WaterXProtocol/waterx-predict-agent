# `waterx-predict` — the universal agent surface

The CLI is how a model, a shell script or a function-calling adapter reaches
WaterX Predict without linking against TypeScript. Every invocation writes
**exactly one JSON document to stdout** and exits with a **stable code**, so a
caller that cannot parse JSON can still branch, and a caller that can never has
to scrape prose.

**This build is read-only, and read-only is enforced rather than promised.** The
signer refuses `signTransaction` before a signer process is started, so no code
path here can produce a transaction signature. Nothing in this package places,
cancels or reconciles an order. The write plane is a separate work package,
tracked as backlog 1.9.

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
```

Steps 1 and 2 are in that order on purpose: discovery precedes setup, because a
runtime you must configure before you may ask what it needs is a runtime you are
guessing at.

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
  (`market search`).
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
| `account status`, `account allowance`, `account positions`, `account executions`, `account fills` | available |
| `market search` | **refused** — `NO_SERVER_ENDPOINT` (B2) |
| `market history` | **refused** — `NO_SERVER_ENDPOINT` (D-25) |
| `account risk-limits` | **refused** — `OWNER_AUTHENTICATED` (ADR-0003, B1) |
| `order preview`, `order execute`, `order execute-many`, `order get`, `strategy`, `runner` | not implemented in this build |

A refusal exits 7 with `error.code` `CAPABILITY_UNAVAILABLE` and a symbolic
`reason`, and it makes **no network call at all**. `market search` is the
clearest case: the API filters on category, status, tradeable and updatedAfter
only, so matching free text against a truncated page locally would hand back a
`marketId` this CLI chose rather than one the server resolved. Market identity
is resolved by the server or not at all.

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
interchangeable, and an ambiguous size is refused before anything is sent.

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
// stdin, one line
{ "version": 1, "type": "PERSONAL_MESSAGE", "agentWallet": "0x…", "messageBase64": "…" }
// stdout
{ "signature": "<base64>" }
```

The child is spawned without a shell, fed on stdin, and killed on the deadline.
Its stderr is forwarded to this process's stderr, redacted, and never enters the
envelope. A non-zero exit, non-JSON stdout, a missing `signature` or a timeout is
`SIGNER_FAILED` (exit 4) — never a fabricated signature and never a silent
success.

`type` is `PERSONAL_MESSAGE` because the login challenge *is* a personal
message. It moves no funds and is not interchangeable with a transaction
signature: Sui's intent prefixes differ, so this signer cannot be tricked into
authorizing a transfer by being handed transaction bytes as a "message".

Keystore, keychain and KMS providers are not implemented (backlog 1.8).

## Secrets

Tokens, signatures, signer stdin and the raw signer argv are never written to
stdout or stderr. A value that would leak is replaced with `[redacted]`,
including when the *server* echoes it back inside an error message. The signer
is reported by executable base name only, because an argument may be a path to a
key file. This is covered by `tests/secrets.test.ts`.

## Limitations

- Read-only. Nothing here trades.
- Paging is limit-only; there is no cursor, so a history longer than the cap
  cannot be fully reconstructed (backlog B6).
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
