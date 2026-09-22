# ADR-0027 — The choice shows itself, and is never answered for anybody

- Status: Accepted
- Date: 2026-09-22
- Decides: that the policy chooser prints itself when a grant lands, why it is
  not a prompt, and that a conflicting setting names where it is written
- Amends: ADR-0025 (the "when" is now immediate), ADR-0026 (the screen is
  reused)
- Affects: `packages/cli` (`onboard`, `next`, `config`)

## Context

A session walked the whole chain on mainnet from a bare machine: install,
`keystore init --no-passphrase`, `configure --fromKeystore --replace`,
`onboard --wait`, the page opening itself, the owner's signature, `next`. Then:

```
onboard --wait   → "Authorized. This runtime still places no order … Run `waterx-predict next`"
next             → "… `waterx-predict policy` lists the three modes …"
policy           → the three modes
```

**Three commands after the signature before a person saw their options.** Each
was correct and each pointed at the next, but the moment a person's attention is
actually on the screen is the moment they finish signing — and at that moment
the tool said what to run rather than showing it.

The same session exposed a second thing. `next` reported:

> The agent wallet is `0x3c92…`, but the keystore holds `0xd436…`

It never said **where** `0x3c92…` was written. The host went looking, checked
`~/.waterx`, found only the keystore, and concluded the address was "a
package-shipped default, not something you own a key for" — which was wrong; it
was in `~/.config/waterx-predict/config.json` from an earlier run. It then
passed `--replace` on that false premise. Harmless there, because the wallet
really was a leftover. The shape is not harmless.

## Decision

### 1. `onboard` prints the three the moment the grant lands

When a wait ends in `READY` and the execution policy is `read-only`, the
chooser screen (ADR-0026) is printed there, under the line that says the
runtime still places no order. One command after the signature, not three.

### 2. It is printed, never applied — and never asked

**No prompt.** Not "press 1, 2 or 3", not a confirmation dialog:

- An unattended host cannot answer a prompt. That is the failure ADR-0020
  removed when it stopped telling hosts to run a blocking `keystore agent`;
  reintroducing it on the money decision would be worse.
- An attended one should not answer it *for* the person who owns the decision.
  A model driving a terminal can type `2` as easily as a person can, and the
  whole point of `--yes` is that it is a person saying so in a command they
  chose to run (ADR-0021).

So the screen ends where every option ends: an exact command, unwrapped, for a
person to copy. `policy set` stays the act of consent.

### 3. A setting that can conflict says where it is written

`next`'s mismatch names the source: `(from /Users/…/config.json)` or
`(from WATERX_PREDICT_AGENT_WALLET)`. `ResolvedConfig` carries
`agentWalletSource` for it, the way `policy.source` has always been carried.

A value somebody has to go and find is a value that gets guessed at, and a
guess about which wallet is real is the wrong thing to be guessing about.

## Consequences

- **The path from signature to choice is one command.** `next` still says it
  too, for a host that arrives from elsewhere, and `policy` still prints it on
  demand — three places, one rendering, because `renderChooser` is the only one.
- **Nothing here decides anything.** ADR-0021 decided the three are offered,
  ADR-0025 when, ADR-0026 how they are rendered, and this one that they arrive
  by themselves. The choice stays a typed command.
- **`onboard` now depends on `policy.ts`** for the rendering. The alternative —
  a second copy of the screen — is the drift that this repository keeps
  refusing elsewhere.
