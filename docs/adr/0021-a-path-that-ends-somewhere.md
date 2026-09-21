# ADR-0021 — An install that can fail legibly, and a policy somebody can choose

- Status: Accepted
- Date: 2026-09-21
- Decides: what an unbuilt install says, and how the execution policy is chosen
  and set
- Amends: ADR-0017 (the opt-in is now a command, not only an environment
  variable), ADR-0019 (the git install reports its own failure), ADR-0020 (the
  list of things a person must still do is now reachable by a person)
- Affects: `bin/`, `packages/cli` (`policy`, `config`, `next`),
  `packages/schema`

## Context

Two failures with one shape: a path that a real installer walks and that ends
nowhere. Both were found in the perp agent's install sessions first
(`waterx-agent` #25, #28, #30), and both were present here unchanged.

**1. An install with no build in it.** `prepare` compiles this workspace at
install time (ADR-0019), and npm ≥ 11 warns that the script is "not yet covered
by allowScripts". Where install scripts are actually refused —
`--ignore-scripts`, an approval policy nobody answers, a locked-down CI — the
package installs "successfully" with no `dist/`. Measured here on npm 11.16.0,
what the caller then got on their FIRST command was:

```
$ npx --no waterx-predict next --json
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/dist/install/cli/main.js'
exit 1, stdout empty
```

Exit 1 is `USAGE` in this contract, and an empty stdout breaks the one promise
every other answer keeps. An automated caller could not tell an unbuilt install
from a crash.

**2. A policy nothing could set.** ADR-0017 makes mainnet read-only until the
operator opts in, and the opt-in lived in an environment variable. `next` said
so on its READY answer: *"places no order until the operator sets
`WATERX_PREDICT_POLICY=interactive`"*. That is an `export` — the exact advice
ADR-0020 removed everywhere else, because a tool host runs every command in its
own process and a variable it exports dies with that process. `configure`
deliberately refuses to write the policy. So nothing in this package could turn
writes on, and the documented loop — run `next`, do the one thing it says, run
it again — ended one step short of a trade.

It also named ONE mode. A screenshot of a real perp install showed the agent
relaying `--set interactive` verbatim as *the* next step, which was the only
suggestion it had been given. Choosing between three modes is the part that
belongs to the person, and a decision needs all of its options in front of it.

## Decision

### 1. The binaries report a missing build themselves

`bin/waterx-predict.mjs` and `bin/waterx-predict-keystore.mjs` check for the
entry point before importing it. When it is absent: `BUILD_MISSING`, exit 3
(`CONFIG` — a configuration problem, not a crash), the human text on stderr,
and — when `--json` was asked for — one envelope on stdout, so the one-document
promise survives the failure a first install is most likely to meet.

**The remedies in that message are the measured ones**, which are not the
obvious ones. Measured on npm 11.16.0:

| | Fixes it? |
| --- | --- |
| `npm install github:WaterXProtocol/waterx-predict-agent` | **yes** — npm runs `prepare` for a git dependency |
| `npm rebuild waterx-predict-agent-runtime` | no — reports "rebuilt dependencies successfully" and runs no `prepare` |
| Re-installing a packed tarball of this repository | no — npm runs `prepare` for a git dependency and a directory, not for a tarball |

`bin/missing-build.mjs` holds the text, and imports nothing but Node:
everything else in this package is the thing that is missing.

### 2. `policy` is a choosing screen, and `policy set` changes it

- **`runtime.policy`** is a READ, so `next` may suggest it — and in the
  read-only posture it does, instead of naming a mode in a sentence. It returns
  all three in rank order, each with what it `means`, what it `costs`, and the
  `command` that takes it as a field of its own, unwrapped: a command broken
  across a terminal wrap is one nobody can copy.
- **`runtime.policy-set`** writes `policy.mode` into the config file, 0600,
  leaving `policy.scope` untouched — the scope is the operator's document, and
  the cumulative budget is counted against it (ADR-0014).
- **Narrowing needs no ceremony.** Refusing to let somebody turn writes off
  would be absurd, so `--mode read-only` just works, from any mode.
- **Widening needs `--yes`**, which is a DISPATCHER flag and not an input
  field, for the same reason `--approve` is one (ADR-0018): a model host
  reaches this CLI through `--input <json>`, so a confirmation carried in the
  input would let one generated document both propose the change and consent to
  it. The refusal names the exact command to repeat.
- **`delegated-auto` is refused without a scope**, and the prerequisite is
  named where the option is OFFERED rather than at the refusal — an option that
  cannot be taken yet has to say so rather than let somebody walk into it.
- **They are not three neutral radio buttons.** `delegated-auto` is the one
  where this process signs against real money with nobody watching. Hiding it
  leaves the people who need it unable to find it; flattening it nudges
  everyone toward it. So it is listed, last, with what it costs.

### 3. The `export` advice is gone from the surfaces an agent reads

The mainnet read-only warning rides on **every** answer (`meta.warnings`), and
the read-only refusal carries a `remedy`. Both said "set
`WATERX_PREDICT_POLICY`". Both now name the chooser and the command. An
environment variable still works and still wins over the file — and `policy
set` says so when it has just written something the environment will shadow.

## Consequences

- **The documented loop now reaches a trade.** From a bare machine: the two
  agent steps of ADR-0020, the owner's grant, then `policy` → `policy set
  --mode interactive --yes` → `order preview` → `order execute --approve`.
  Walked here end to end on 2026-09-21.
- **`ExecutionPolicy` gained `hasConfiguredScope`**, separate from `scope`,
  which stays "the scope this invocation would enforce". Nothing may mistake
  "a scope exists on disk" for "an auto-approving policy is running".
- **A new CLI error code, `BUILD_MISSING`**, reachable only from the `bin/`
  shims: by the time any other code is loaded, the build it describes is there.
- **Two commands for one concept.** `policy` and `policy set` are separate
  contract entries because `next` may only suggest reads, and setting the
  policy is a person's write. The alternative — one command with a `--set`
  flag — would have made the whole thing unsuggestible.
