# Published schemas

Generated artifacts. **Do not hand-edit anything in this directory** — a test
regenerates and compares byte-for-byte, so a manual change fails the suite.

| File | Source | Regenerate with |
| --- | --- | --- |
| `v1/agent-commands.json` | `packages/schema/src` | `pnpm schema:generate` |

These files exist so a surface that cannot import a Node module — a Python
adapter, a model host ingesting tool definitions — reads the same contract the
CLI validates against. See
[ADR-0006](../docs/adr/0006-agent-command-schema-mechanism.md).

## Reading `agent-commands.json`

`$defs` holds the shared field rules; every command input `$ref`s into it, so a
rule is stated once and cannot disagree between commands. `commands` is an
ordered list, each entry carrying:

- `input` — a JSON Schema (draft 2020-12) for the command's arguments.
- `sdkMethod` — the `PredictAgentClient` method the command compiles to. Every
  surface issuing the same command must make this same call.
- `classification`, `sideEffects`, `confirmation`, `idempotency` — what an
  approval layer needs before running it. `classification: "write"` means the
  command can move funds.

Two things to know before generating code from it:

- **`enum` is closed and enforced. `x-waterx-open-set` is an annotation and must
  not be enforced.** A newer server may add a market category; rejecting an
  unlisted one would fail on data the server considers valid.
- **Money, prices and sizes are decimal strings**, with a `pattern`, not numbers.
  Parsing one into a float loses the guarantee that the size stated is the size
  that trades.

## Versioning

`v1` is a directory, not a filename suffix: a breaking change to an existing
command input creates `v2/` alongside it rather than editing `v1/`. Adding a new
command is not a breaking change and lands in `v1/`.
