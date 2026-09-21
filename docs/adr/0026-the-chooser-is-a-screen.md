# ADR-0026 — The chooser is a screen, not only a document

- Status: Accepted
- Date: 2026-09-21
- Decides: that `policy` renders the three modes for a person, and what a
  relaying agent is told to do with them
- Amends: ADR-0021 (the chooser gained a rendering), ADR-0025 (which decided
  when it is shown)
- Affects: `packages/cli` (`policy`), `packages/adapters` (SKILL)

## Context

ADR-0021 made `policy` a chooser and ADR-0025 put it in front of the operator
the moment the owner's grant lands. A real install session then walked the whole
chain on mainnet — install, `configure --fromKeystore`, `onboard --wait`, the
page opening itself, the signature, `next` — and arrived exactly where it should:

```
then: waterx-predict policy
```

It ran `waterx-predict policy --json | head -80`, read the JSON, and **built its
own table** of the three modes for its user. It did that well, and it explicitly
refused to recommend one. But the thing it relayed was a paraphrase: three
descriptions of what may be signed against real money, rewritten by a model,
from a document that was cut off mid-way by `head`.

The chooser existed only as data. Everything a person needs to read was there,
and nothing printed it.

## Decision

`policy` prints the screen, and keeps the document.

```
  policy     read-only — on mainnet, where an order spends real funds
  chosen by  nobody: this is the default
  file       /Users/…/.config/waterx-predict/config.json

  Pick one. This is a person's decision, not the agent's:

  → read-only      Reads and previews. No order is placed, and nothing is ever
                   signed.
                   costs: This runtime cannot trade at all. Everything else
                   still works: search, quotes, previews, positions.
                   waterx-predict policy set --mode read-only

    interactive    One previewed order per approval. …
                   costs: …
                   waterx-predict policy set --mode interactive --yes

    delegated-auto This runtime signs without asking, inside a scope written
                   down beforehand: …
                   costs: It signs against real money with nobody watching. …
                   needs a `policy.scope` in the config file first: …
                   waterx-predict policy set --mode delegated-auto --yes
```

- **On stderr**, because stdout is one JSON document and always will be. The
  screen therefore also survives the pipe a host reaches for (`| head -40`):
  stderr comes first, so the three options and their commands are inside it
  even when the JSON below is cut off.
- **Prose wraps; commands never do.** The wrap width is derived from the mode
  column (`80 − indent`), so the whole screen fits an 80-column terminal by
  construction rather than by a number somebody tuned. A command split across
  a wrap is one nobody can copy — the rule the authorization link is already
  under (ADR-0024).
- **Every option carries what it costs**, and the one that cannot be taken yet
  carries what it needs first, on its own line, with its own command.
- **The current mode is marked** (`→`), and where it came from is stated:
  "nobody: this is the default" is a different fact from "the config file".
- **`renderChooser` is a pure function**, so what the screen says is a tested
  claim rather than a string typed into a diagnostic.

The SKILL now tells a relaying agent to **pass the screen on as printed**, not
to summarise it into one recommendation, and never to run `policy set` itself —
widening needs `--yes`, which is a person saying so.

## Consequences

- **An agent no longer has to paraphrase a money decision.** It relays what was
  printed; the words the operator reads are the words this repository wrote and
  tests.
- **Two renderings of the same data exist** — the screen and `data.choices` —
  and they cannot drift, because the screen is built from the choices.
- **This does not make the choice for anybody.** It decides how the three are
  presented; ADR-0021 decided that all three are presented, and ADR-0025
  decided when.
