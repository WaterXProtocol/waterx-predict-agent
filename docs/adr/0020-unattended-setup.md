# ADR-0020 — What an agent host may set up for itself

- Status: Accepted
- Date: 2026-09-18 (after watching two real model-host sessions stall)
- Decides: which setup steps an agent host may run itself, and how a key is held
  on a machine where nobody can type a passphrase
- Amends: ADR-0012 (the keystore is no longer only the sealed, resident shape),
  ADR-0019 (the one-sentence install now has a walkable rest)
- Affects: `packages/signer-keystore`, `packages/cli` (`next`, `configure`,
  the keystore probe), `packages/schema`

## Context

ADR-0019 made the install one sentence:

```
Run `npm install github:WaterXProtocol/waterx-predict-agent`, then `npx --no waterx-predict next --json`, and do what it says.
```

Two real model-host sessions ran exactly that, and both stopped at the same
place — correctly. `next` answered `SETUP_INCOMPLETE` with `stop: true` and a
hand-over whose steps were:

```
1. npx --no waterx-predict-keystore agent
2. export WATERX_PREDICT_AGENT_WALLET=0x…
3. export WATERX_PREDICT_SIGNER_COMMAND='["waterx-predict-keystore","sign"]'
```

Not one of those three is something a tool host can do:

1. **`agent` blocks forever.** It is a resident process that holds the decrypted
   key, and it wants a passphrase from a terminal. A host has no second
   terminal, and a command that never exits is a command it cannot run.
2. **`export` goes nowhere.** Every command a host runs is its own child
   process. A variable exported inside one is gone before the next call. There
   was no way to make a setting persist.
3. **A passphrase has to be typed by someone.** On an unattended machine there
   is nobody.

The perp agent has none of these problems, because it made the opposite trade:
`bootstrap` writes a plain `SUI_PRIVATE_KEY` into a `.env`, there is no resident
process, and its `next` tells the AGENT to run `bootstrap` itself. Its setup
finishes; ours stalls at step one.

The instinct to fix this by loosening the hand-over is wrong, and so is the
instinct to leave it: the two failures are different sizes. An agent that grants
itself authority is the failure ADR-0003 exists to prevent. An agent that cannot
create an empty wallet on its own machine is a product that does not work.

## Decision

### 1. A keystore may hold its key with no passphrase

`waterx-predict-keystore init --no-passphrase` writes `protection: 'NONE'`: the
raw secret, base64, in a `0600` file, with the warning in the file itself. `sign`
opens it, signs, and exits — **no resident agent, no socket, no token**. `agent`
refuses to run for one, because there is nothing to hold.

This is the perp agent's posture, stated rather than implied:

| | sealed (the default) | `--no-passphrase` |
| --- | --- | --- |
| Key at rest | AES-256-GCM under scrypt | plaintext |
| Protected by | a passphrase nobody else has | the file mode, and nothing else |
| Signing needs | a resident `agent` holding the key | the file |
| Someone must type | the passphrase, once per start | nothing |
| Survives a reboot unattended | only with a passphrase file | yes |

It is never chosen for anyone. The flag is typed, `init` warns on stderr, the
file says what it is, and the probe, `next`, `configure` and `describe` all
report `protection`. Anything that can read the file has the key — which is why
the only key that belongs in one is a **delegated agent wallet** bounded by the
owner's on-chain grant and risk profile, never the owner's own key.

### 2. The sealed path gets a way to run unattended too

`agent --detach` reads the passphrase in the process that still has a terminal,
hands it to a background child on a pipe — never through `ps`, never through a
file the child must find — waits for the socket to answer, and prints the pid.
An operator who wants the key sealed is no longer the only person who has to
keep a terminal open for it.

### 3. `configure` — the one command that writes settings

`waterx-predict configure --fromKeystore` writes the agent wallet and the signer
command into the config file, `0600`. That is the whole of what any command may
write, and the list is closed:

- **It writes** which wallet this runtime claims to be, and which program signs
  for it. Both are statements about this machine.
- **It does not write** the network, the policy, the account, or anything else.
  Those decide whether real money moves, and ADR-0017 keeps mainnet read-only
  until a person says otherwise. `configure` is not that person.
- An existing value is kept unless `--replace` is given, so a second call cannot
  quietly repoint a working runtime at another wallet.
- It says when the environment will shadow what it wrote, rather than reporting
  a success the next invocation ignores.

It is classified `write` in the contract even though it moves nothing: a host
that gates writes should gate a command that changes what this runtime *is*. The
invariant that matters — no `runtime` command may move funds or sign — still
holds for it.

### 4. `next` splits the steps by who may run them

`handOver.steps` stays the person's. A new `agentSteps` carries what the host
may run itself, each with a `safeBecause` that argues the case per step:

```
agentSteps:
  1. npx --no waterx-predict-keystore init --no-passphrase
       safeBecause: the wallet is brand new — it holds no funds, and can do
       nothing at all until the ACCOUNT OWNER grants it on chain.
  2. waterx-predict configure --fromKeystore
       safeBecause: it writes which wallet this runtime is and which program
       signs; no network, no policy, no account; nothing is sent or signed.
```

When every remaining local step is the agent's, the answer does not stop. When
one is a person's — installing software, unlocking a sealed keystore, choosing a
network — it stops, and the agent's steps ride along, because doing them first
shortens the person's list.

**What stays a person's, always:** the owner's on-chain grant (ADR-0003), the
choice of network, turning on mainnet writes (ADR-0017), funding anything, and
any passphrase.

## Consequences

- **A host can now go from `npm install` to AWAITING_OWNER with no human**, which
  is what `install:check` walks: it takes the commands out of `agentSteps` and
  runs them rather than spelling them, so a hand-over that stops being runnable
  fails the check.
- **A plaintext key exists on machines that choose it.** That is a real
  reduction in protection versus the sealed keystore, and it is the same one the
  perp agent already makes. It is bounded by what the wallet is allowed to do,
  not by the file — which is why the owner's grant, the risk profile and the
  mainnet write policy all stay outside the agent's reach.
- **`export` is no longer the advice anywhere in the hand-over.** A setting a
  person sets can still be an environment variable; what `next` suggests is the
  command that persists.
- **Two keystore shapes mean two paths to keep working.** `install:check` walks
  the passphrase-less one, `cli:bundle:check` walks the sealed one with a
  resident agent, and both run in CI.
