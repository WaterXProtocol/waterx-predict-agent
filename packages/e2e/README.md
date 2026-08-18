# @waterx/predict-agent-e2e

The non-production end-to-end harness. It drives the **installed**
`waterx-predict` binary — resolved through `node_modules`, spawned as its own
process, read back through its stdout envelope and exit code — through twenty
steps in two halves.

**The immediate half**, which is one whole trade: `describe`, `doctor`, market
list/search/get/quote, order preview/execute, terminal wait, order get, order
reconcile, account positions/fills.

**The durable half**, which is a different shape and a different trust boundary:
two independent quotes and a non-atomic multi-leg entry, a `strategy list` that
finds a **local** Runner, a conditional job armed on it with a price target and a
mandatory expiry, that job surviving a restart *the operator commands*, and —
last, and never withheld — its cancellation. Nothing server-side holds a target,
so everything after `strategy list` is answered by a process on this machine.

**This is not a production runner, and it is not itself a Runner.** It has no job
store, no durable state and no recovery of its own; it exits when it is done. It
never runs against production or mainnet, and it never starts, stops or
supervises a Runner — the restart is a command the operator supplies, and this
package neither constructs one nor backgrounds anything.

## Status on this machine: the E2E has NOT run

No testnet environment is configured here — no `WATERX_PREDICT_*` variables and
no `~/.config/waterx-predict/config.json` — and no Runner is listening. So the
live path has never executed, and nothing in this package should be read as
evidence that it passes.

What *does* run today is `describe`, which answers with no configuration and no
network. The other nineteen steps report `NOT_RUN` with the named gaps
responsible, all ten gaps come back `MISSING` or `UNCHECKED`, and the harness
exits **10 (PARTIAL)** — "1 step(s) passed and 19 could NOT run. This is not a
passing end-to-end."

```
pnpm build            # the harness drives built output, so build first
node packages/e2e/dist/src/main.js
```

One step out of twenty is not an end-to-end, and the exit code says so. The only
way to reach 0 here is to provision the list below and run it again.

## What it will not do

- **It never trades against production.** Every writing step needs *two*
  independent conditions: its own opt-in flag, and an environment label this
  build recognises as non-production (`test`, `testnet`, `devnet`, `localnet`,
  `local`, `staging`, `sandbox`). An unlabelled deployment is treated as
  production — the allowlist is deliberate, so a label nobody anticipated is
  refused rather than trusted.
- **It never lets one opt-in authorize another.** There are three, because they
  are three different decisions: `--allow-write` places ONE order,
  `--allow-multi-leg` places TWO in one call, and `--allow-strategy` arms a job
  that can trade **later, after this process has exited**. Agreeing to the
  smallest never grants the largest.
- **It never leaves a strategy armed on purpose.** `strategy cancel` is
  deliberately *not* gated: withholding it would end a run by leaving a live job
  on the operator's Runner. It goes last, it runs whatever else failed, and if
  the cancellation was recorded but not applied it says so rather than implying
  the job is stopped.
- **It never invents a way to stop a process.** Crash recovery is proven with
  the operator's own restart command, supplied via `--runner-restart`. There is
  no `pkill`, no signal and no pid lookup anywhere in this package, and a
  restart that fails is reported as `NOT_RUN` — nothing was asked of the CLI, so
  nothing about it was established.
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

## The ten provisioning gaps

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
| `ownerAddress` — account owner address | Account owner (handed to the operator) | supplied with `--ownerAddress 0x…`; nothing infers it |
| `runner` — a local Runner answering its socket | Operator | `strategy list` → a reply naming `runner.instanceId`, driving |
| `runnerRestart` — a command that restarts the Runner | Operator | supplied with `--runner-restart "<cmd>"`; none is invented |

The first seven are WP05A's list, unchanged. The last three are what the durable
half additionally needs, and none of the three is inferable: an owner address
attributes a trade to a person, a Runner is a process someone chose to start, and
a restart command belongs to whoever started it.

`runner` is `MISSING` in two distinct ways. No Runner answered at all
(`RUNNER_UNREACHABLE`) is the obvious one. The other is a Runner that answers but
reports `driving: false` — a strategy armed on it would be **armed and asleep**,
a real job in a real store that nothing advances, so that is not "provisioned
with a caveat". Any *other* refusal is `UNCHECKED`: something said no for a
reason this harness has not established.

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

### 2. Account owner — hand over the account id and the owner address

The owner reads the Predict account id and their own Sui address from the WaterX
account UI and gives both to the operator. The agent cannot discover either;
account scoping is not something it gets to choose, and a guessed owner address
attributes a trade to the wrong person.

Both are identifiers. The key behind the owner address stays with the owner and
never reaches this runtime.

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

### 5. Operator — start a Runner, and know how you restart it

The durable half is answered by a Runner on this machine, not by the server.
Start one in another terminal and leave it running:

```sh
waterx-predict-runnerd
```

The first Runner is **self-hosted**: it runs on the operator's own machine, and a
strategy is watched only while that machine is awake and that process is up.
There is no managed runner to fall back to.

The restart step needs *your* command for restarting *your* daemon — a
service-manager kick, a supervisor command, whatever you actually use. It must
return promptly and by itself; a command that runs the daemon in the foreground
would hang the step rather than restart anything. This harness never constructs
one.

### 6. Either actor — verify, then run

```sh
waterx-predict doctor
waterx-predict account risk-limits --accountId 0x…
waterx-predict strategy list                        # is a Runner up, and driving?

node packages/e2e/dist/src/main.js                  # read-only, nothing placed
node packages/e2e/dist/src/main.js --allow-write \
  --buyAmount 1 --maxSlippageBps 100                # ONE real testnet order

# The durable half. The strategy is armed with a BUY ceiling far below the
# market, so it waits rather than fills — and it is cancelled before the run
# ends, whatever else happened.
node packages/e2e/dist/src/main.js \
  --allow-write --allow-multi-leg --allow-strategy \
  --ownerAddress 0x… \
  --runner-restart "systemctl --user restart waterx-predict-runnerd"
```

Each opt-in is separate on purpose. `--allow-strategy` is the one that leaves
something behind: a job that can trade **after this process has exited**. The run
always tries to cancel it, and reports loudly if the cancellation was recorded
but not applied.

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
| `multi-leg-entry.sh` | Several orders in one call — client-side, non-atomic, per-leg outcomes |
| `target-exit.sh` | Arming a durable SELL on the local Runner that fires later, without you |
| `restart-recovery.sh` | Killing the Runner and proving the same job — not a copy — came back |
| `north-star-bot.sh` | The whole thing: buy under a ceiling, sell half at a target, stop in three days |

The last four need a local Runner. Start one in another terminal
(`waterx-predict-runnerd`) and leave it running: the first Runner is
self-hosted, so the device it runs on has to stay awake for a strategy to be
advanced. An armed job survives a restart either way; nothing advances it while
no Runner is up.

The stream example is not here. It lives at
`packages/sdk/examples/watch-quotes.mjs`, with the package that implements the
stream, because a subscription lives as long as the process holding it and there
is no CLI command shaped like that. This package's tests still execute it, and
lint the commands it prints.
