# ADR-0028 — Mainnet is not a question, and the pointer survives the cut

- Status: Accepted
- Date: 2026-09-22
- Decides: that the network is stated rather than offered, and that the
  envelope's own fields are serialized before its payload
- Amends: ADR-0011 (the default is unchanged; how it is presented is not),
  ADR-0022 (the pointer now survives a truncated read)
- Affects: `packages/cli` (`config`, `next`, `envelope`),
  `packages/adapters` (AGENT_INSTRUCTIONS)

## Context

### The network read as an unmade decision

ADR-0011 made mainnet the default. Everything that reported it, though, was
phrased as though somebody still had to choose:

- every envelope carried *"No deployment was named, so this runtime uses
  production … Set `WATERX_PREDICT_ENVIRONMENT=testnet` to practise"*;
- the hand-over said *"the wallet, its passphrase and **the network** are
  theirs. **Unless they name a network**, this runtime uses production"*;
- the one setup step for it was `export WATERX_PREDICT_ENVIRONMENT=mainnet`.

Three consequences, all observed. A model host relayed *"if you meant to
practise, set `WATERX_PREDICT_ENVIRONMENT=testnet` before authorizing"* — advice
it could not follow, because a variable exported in one child process is gone by
the next (ADR-0020). The hand-over listed the network among the things a person
must supply, so an operator was being asked for something the product had
already decided. And "no deployment was named" describes an omission, when what
is actually true is that this runtime is for mainnet.

The guardrail against spending real money by accident was never the network. It
is the execution policy, which starts read-only and needs a typed `--yes`
(ADR-0017, ADR-0021).

### The pointer sat past the cut

ADR-0022 promises `meta.nextCommand` on every answer. `next --json` is about 143
lines and `meta` was serialized last, so the pointer was on line 136 — and three
real sessions piped this through `head -100`. The guarantee existed and the
reader could not see it.

## Decision

### 1. The network is stated, not offered

- The every-answer warning becomes *"This runtime trades on production
  (mainnet, …), where orders spend real funds."* The policy warning that
  follows it says what stops an order; saying it twice trains a reader to skim
  both.
- The hand-over no longer lists the network among what a person supplies, and
  no longer hedges with "unless they name a network".
- The remaining deployment step is only reachable when a **named** deployment
  is one this build does not know. Its fix is `unset
  WATERX_PREDICT_ENVIRONMENT` — removing the wrong value, not choosing a
  network — because with nothing set this runtime is on mainnet.
- `WATERX_PREDICT_ENVIRONMENT=testnet` still works and is documented as a
  **development switch**, in `describe` and the READMEs, where a developer
  looks for it. It is not a setup step and no surface asks anybody to pick it.

**No network-choosing command is added.** The chooser pattern (ADR-0021) exists
for the decision that actually gates money; adding a second one for a setting
with a correct default would teach an operator that the default is provisional.

### 2. `meta` is serialized before `data`

Key order carries no meaning in JSON and decides everything about what survives
a cut. The small, fixed fields — `schemaVersion`, `ok`, `command`, `requestId`,
`meta` — go first; `data` and `error`, the parts that grow, go last. A
`head -20` now carries the envelope's own guarantees.

## Consequences

- **An operator is asked for two things: a wallet, and a policy.** Not three.
- **The real-funds statement stays on every answer.** What changed is that it
  stopped ending in an instruction nobody needs and a host cannot follow.
- **A truncated document is still useful**, which is the only way the pointer
  guarantee is worth anything to a host that pipes through `head`.
- **`data` moving last is visible in every recorded envelope.** Nothing parses
  by position, and the tests that compare envelopes compare parsed objects.
