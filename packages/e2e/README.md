# @waterx/predict-agent-e2e

The non-production end-to-end harness. It drives the **installed**
`waterx-predict` binary — resolved through `node_modules`, spawned as its own
process, read back through its stdout envelope and exit code — through one whole
trade: `describe`, `doctor`, market list/search/get/quote, order
preview/execute, terminal wait, order get, order reconcile, account
positions/fills.

**This is not a production runner and it is not a Runner.** It has no job store,
no durable state and no recovery of its own; it exits when it is done. It never
runs against production or mainnet. It is a test harness for the contract
assumptions the durable Runner will later be built on, and it exists so those
assumptions are checked against a real server *before* they are written into a
job store.

## Status on this machine: the E2E has NOT run

No testnet environment is configured here — no `WATERX_PREDICT_*` variables and
no `~/.config/waterx-predict/config.json`. So the live path has never executed,
and nothing in this package should be read as evidence that it passes.

What *does* run today is `describe`, which answers with no configuration and no
network. The other twelve steps report `NOT_RUN` with the named gaps
responsible, all seven gaps come back `MISSING` or `UNCHECKED`, and the harness
exits **10 (PARTIAL)** — "1 step passed and 12 could NOT run. This is not a
passing end-to-end."

```
pnpm build            # the harness drives built output, so build first
node packages/e2e/dist/src/main.js
```

One step out of thirteen is not an end-to-end, and the exit code says so. The
only way to reach 0 here is to provision the list below and run it again.

## What it will not do

- **It never trades against production.** The write step needs *two* independent
  conditions: `--allow-write`, and an environment label this build recognises as
  non-production (`test`, `testnet`, `devnet`, `localnet`, `local`, `staging`,
  `sandbox`). An unlabelled deployment is treated as production — the allowlist
  is deliberate, so a label nobody anticipated is refused rather than trusted.
- **It never provisions a delegation or a risk profile.** Both are
  owner-authenticated operations under [ADR-0003](../../docs/adr/0003-risk-profile-ownership.md).
  An agent runtime that could grant its own delegation, or widen its own limits,
  would be defeating the control rather than implementing it. The harness reads
  them and reports; it has no code path that writes them.
- **It never substitutes a mock for a live path.** Every result carries the
  transport it came from. If anything in a report was obtained from a `STUB`,
  the whole report is `INVALID` — not green, and not partially green.
- **It never reports a step that did not run as passing.** `NOT_RUN` carries no
  evidence field at all, so "passed without running" is not a state this
  program can represent.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | `PASSED` — every step ran against the installed CLI and was correct |
| 10 | `PARTIAL` — some steps passed, others could not run. **Not a pass** |
| 11 | `NOT_RUN` — nothing ran. Nothing has been established either way |
| 12 | `FAILED` — something ran and was wrong |
| 70 | `INVALID` — the report cannot be trusted (a stub stood in for a live path) |

stdout is exactly one JSON report. stderr is the human account of it, including
the provisioning list. Neither ever contains a token, a signature, sponsored
transaction bytes or a key — the harness never holds one.

## The seven provisioning gaps

A run that cannot happen still produces a deliverable: this list, with the
supplier of each entry named. `SATISFIED` means observed present, `MISSING`
means observed absent, and `UNCHECKED` means the check could not run — saying a
delegation is missing when nobody could reach the server is a claim about a
conversation that never happened.

| Gap | Supplied by | Settled by |
| --- | ----------- | ---------- |
| `baseUrl` — Agent API base URL | Operator | `describe` → `api.baseUrl` |
| `environment` — environment label | Operator | `describe` → `api.environment` |
| `agentWallet` — agent wallet address | Operator | `describe` → `identity.agentWallet` |
| `signerCommand` — external signer command | Operator | `describe` → `signer.configured` |
| `defaultAccount` — Predict account id | Account owner (handed to the operator) | `describe` → `identity.defaultAccountId` |
| `delegation` — delegation to the agent wallet | **Account owner, owner-authenticated** | `account risk-limits` → `delegation.mayPlaceOrder` |
| `ownerRiskProfile` — agent risk profile | **Account owner, owner-authenticated** | `account risk-limits` → a mandate rather than `NO_RISK_PROFILE` |

`delegation.mayPlaceOrder` is tri-state on purpose. `true` is granted, `false`
is refused, and **`null` means the on-chain read failed** — not that the
delegation was revoked. The harness reports `null` as `UNCHECKED`, because
tearing down a healthy setup on the strength of a failed RPC call is a worse
outcome than not knowing.

## Onboarding runbook (two actors)

Under ADR-0003 the operator and the account owner are different people with
different sessions, and the split is the control. Neither half is optional.

### 1. Operator — configure the runtime

Either environment variables or `~/.config/waterx-predict/config.json`; flags
beat environment, environment beats the file.

```sh
export WATERX_PREDICT_BASE_URL=https://<testnet-agent-api>
export WATERX_PREDICT_ENVIRONMENT=testnet          # required before any write
export WATERX_PREDICT_AGENT_WALLET=0x…             # the ADDRESS, never a key
export WATERX_PREDICT_SIGNER_COMMAND=/opt/waterx/sign
export WATERX_PREDICT_ACCOUNT_ID=0x…               # from the owner, step 2
```

The signer command reads a signing request on stdin and answers `{"signature":
"…"}` on stdout. It is the only component that touches a private key. This
runtime never receives one, and neither does any model or agent subprocess.

Check the result — this reaches nothing and needs no credential:

```sh
waterx-predict describe
```

### 2. Account owner — hand over the account id

The owner reads the Predict account id from the WaterX account UI and gives it
to the operator. The agent cannot discover it; account scoping is not something
it gets to choose.

### 3. Account owner — grant the delegation *(owner-authenticated)*

In an owner session, grant the agent wallet a delegation on the account, with an
allowance and a validity window. Without it the agent authenticates successfully
and then has every write refused.

**Not automatable from here.** This harness has no code path that attempts it.

### 4. Account owner — set the agent risk profile *(owner-authenticated)*

`PUT accounts/:accountId/agents/:agentWallet/risk-profile`, through the owner UI
or the owner API: max order amount, max slippage, orders and notional per hour,
max in-flight executions.

Absence is **not** an unlimited default. With no profile, `account risk-limits`
reports `NO_RISK_PROFILE` and the agent is simply not onboarded — a first-class
state, distinct from "allowed to do anything" (ADR-0003 §5). Widening a limit is
an owner operation and stays one.

### 5. Either actor — verify, then run

```sh
waterx-predict doctor
waterx-predict account risk-limits --accountId 0x…

node packages/e2e/dist/src/main.js                  # read-only, no order placed
node packages/e2e/dist/src/main.js --allow-write \
  --buyAmount 1 --maxSlippageBps 100                # ONE real testnet order
```

## Examples

`examples/` holds runnable scripts, each one linted against the real command
contract by this package's tests — the same check that would have caught a
documented recovery command spelling a flag the CLI does not accept.

| Example | What it shows |
| ------- | ------------- |
| `one-shot-entry.sh` | Preview, approve, execute, wait, reconcile — one entry, start to finish |
| `slippage-rejection.sh` | Price protection refusing an order rather than filling it worse |
| `delegation-revocation.sh` | What a revoked delegation looks like, and why `null` is not a revocation |
| `reconciliation.sh` | Recovering an execution whose outcome is unknown, without resubmitting it |

Examples that need streams, the Runner or strategies are not here; they belong
with the components that implement them.
