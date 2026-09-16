# ADR-0012 — The keystore signer ships beside the CLI

- Status: Proposed
- Date: 2026-09-16
- Decides: how an operator who installed the CLI bundle gets a signer, and
  when that signer may be handed to anyone outside this repository
- Amends: ADR-0009 D-28, for this one artifact and only once this ADR is
  Accepted; ADR-0010, whose one-sentence setup now installs two tarballs
- Leaves unchanged: ADR-0001 §7 (no key material in the CLI or the Runner),
  ADR-0003 (the owner's mandate), ADR-0011 (mainnet by default)
- Affects: `packages/signer-keystore`, `packages/cli` (`next`),
  `packages/release`

## Context

ADR-0010 made the CLI installable in one command. The first thing `next` then
asks for is an agent wallet and a signer — and nothing an operator could install
provided one. Both signer providers were `private`; the bundle had no signer in
it. The sentence "install this, then do what `next` says" stopped at its first
step, with a hand-over asking the operator for a program they did not have.

The keystore provider (`packages/signer-keystore`) is the one that fits an agent
host: it holds a dedicated agent wallet, is unlocked once by a person, and signs
while nobody watches. The browser provider needs a person present for every
signature and makes the person's own wallet the agent wallet; it is not what an
agent host installs.

## Decision

### 1. A second tarball, installed in the same command

The keystore ships as its own operator artifact,
`waterx-predict-agent-signer-keystore-<version>.tgz`, built by the same
`pnpm cli:bundle` and held to the same rules as the CLI's (ADR-0010 §1):
`private: true`, no lifecycle scripts, third-party dependencies from the
registry, an SBOM inside and at `sbom/bundle/`, one line in `SHA256SUMS`, and the
same version as the CLI.

It is **not** placed inside the CLI's tarball. The CLI must never import it —
that would bring the Sui SDK and a key path into the process that decides
policy — and npm does not link a bundled package's binary anywhere a shell can
find it. Installed in the same `npm install`, both binaries land in
`node_modules/.bin`, which `npx` puts on PATH for everything it runs, so the
signer command `["waterx-predict-keystore","sign"]` resolves with no path in it.

The sentence becomes:

```
Run `npm install <cli.tgz-url> <keystore.tgz-url>`, then `npx --no waterx-predict next --json`, and do what it says.
```

### 2. `next` walks the operator through it, from what is on the machine

`next` looks — without importing the keystore and without dialing its socket —
at whether the binary resolves on PATH, whether `keystore.json` exists (reading
its public `address` and nothing else), and whether the agent's socket exists.
From that it hands the operator only the steps still undone, as commands:
install, `init`, `agent`, the two settings, with the address filled in once the
keystore has one. The layout it reads is a copy of the keystore's own, held
equal by `tests/workspace.test.ts`.

It does not attempt a signature while a keystore step is undone, and it reports
a configured agent wallet that the keystore does not hold before the first
signature rather than after it.

### 3. Released only with its own decision

`pnpm cli:bundle --release` refuses unless ADR-0010 **and** this ADR are
Accepted. All or nothing: a CLI released without its signer is a CLI that stops
at its first question.

### 4. What accepting this means

A key-holding program becomes installable by people outside this repository.
The protections are the keystore's own, unchanged: scrypt and AES-256-GCM at
rest, a `0700` runtime directory asserted rather than repaired, a per-start
token on a `0600` socket, a refusal to sign for any address it does not hold,
and a passphrase that never comes from an environment variable. What it cannot
protect against is being given the wrong key: `init` creates a new wallet by
default, and every hand-over says never to import the account owner's.

## What this forbids

- Placing the keystore inside the CLI's tarball, or the CLI importing it.
- A `next` that dials the keystore socket or reads anything from
  `keystore.json` but its `address`.
- Releasing the CLI bundle without the keystore, or the keystore alone.
- Any instruction that tells an operator to `--import` the account owner's key.
- Reading this ADR as authorizing the browser signer, the Runner, the adapters
  or the MCP server.

## Consequences

- **The install pulls the Sui SDK.** The keystore needs it to sign; its SBOM
  lists it and its twenty-component closure. The CLI's SBOM still does not.
- **A decrypted key is resident while the agent runs.** That is the keystore's
  documented trade (its README), now reachable by more people. The key it holds
  should be a delegated agent wallet bounded by the owner's risk profile.
- **`next` can be wrong about a live agent.** A socket file can outlive the
  process that made it. `next` reports it as present, not as running; the
  session that follows proves it, and a signer failure there sends the operator
  back to `agent`.
- **The walk is checked, not just the install.** `pnpm cli:bundle:check`
  installs both, runs `init` and `agent`, and follows `next` to READY against a
  local stub, verifying the login signature with the installed Sui SDK.
