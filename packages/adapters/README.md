# `@waterx/predict-agent-adapters`

Host-neutral agent instructions, and the thin adapter core that every host
adapter is built from.

This package holds **no** pricing, retry, signing, policy or job state, and has
no way to acquire any: it imports the command schema and the Node standard
library, and reaches the command core only by running the installed
`waterx-predict` binary in a child process. That is plan §6.7's constraint made
structural rather than documentary — there is no symbol here with which an
adapter could reimplement an order. `tests/workspace.test.ts` fails if that
changes.

`private: true` — real code with real tests, and not published. Release is
backlog item 3.6.

| Piece | What it is |
| --- | --- |
| `agent-instructions/AGENT_INSTRUCTIONS.md` | The host-neutral instructions, generated from `src/instructions.ts` and committed at the repository root. |
| `src/tools.ts` | The command contract projected into tool definitions, plus the OpenAI, Anthropic and MCP shapes. |
| `src/dispatch.ts` | Tool call → validate against the contract → hand to the core → relay the envelope verbatim. |
| `src/core.ts` | The `CoreInvoker` seam, and the subprocess implementation of it. |
| `waterx-predict-tools` | The generic function-calling adapter binary. |

`@waterx/predict-agent-mcp` is the same core behind an MCP stdio transport. Both
adapters advertise the same tools, with the same input schemas, and produce the
same argv for the same intent — asserted by a workspace test rather than
promised here.

## The generic function-calling adapter

```
waterx-predict-tools instructions [--format markdown|json]
waterx-predict-tools tools [--format openai|anthropic|mcp|neutral]
waterx-predict-tools call <tool> --input '<json>'
```

`tools` gives a host the definitions to hand its model. `call` runs one of them
and writes a single JSON document describing what the core answered, exiting
with the core's own exit code.

Operator flags — `--config`, `--policy`, `--timeout-ms`, `--runner-dir` — are
passed to the core unchanged.

## Tool names

`order.execute` is not a legal tool name for most hosts, so every command is
prefixed and mangled: `waterx_predict_order_execute`. The reverse map is built
from the registry, and a collision throws at module load rather than routing one
command's input into another's handler.

Each tool's `inputSchema` carries the transitive closure of the `$defs` its
`$ref`s reach, and nothing else, so it is self-contained for a host that never
received the whole command document.

## What an adapter cannot do: approve a write

The default execution policy is `interactive`. A write — `order.execute`,
`order.execute-many`, `strategy.create` — requires an approval token that
digests that one exact normalized intent. The token is a global flag on the
command core, supplied by an operator, per order. It is **not** a credential and
it does not authorise the next order.

This adapter has no flag to supply one, deliberately: a pinned approval would
either be useless or would pre-authorise an order the model had not written yet.
So through any adapter, under the default policy, a write is refused with
`POLICY_DENIED`, and the refusal names the approval it expected.

That is the intended behaviour. The working shape is: the model previews the
order, shows the user exactly what it would do, and hands over the refusal so a
person runs the approved command themselves. Unattended writes need
`delegated-auto`, which is local operator configuration bounded by the account
owner's risk profile — see the instructions document.

## Not included: an OpenAPI document, or a Skill

This repository exposes no HTTP surface. Emitting an OpenAPI document would
describe a server that does not exist, so none is generated. The generic
function-calling half of plan §6.7 is the `tools`/`call` pair above, over the
same registry — an adapter that later needs OpenAPI builds it from
`AGENT_TOOLS` rather than from a second description of the commands.

The Skill/plugin adapter §6.7 also lists is **not built**. Its content would be
the instructions document plus the examples that already ship with the CLI and
the E2E harness, and nothing here packages them for a specific host.

## Regenerating the instructions

```
pnpm instructions:generate
```

A test re-renders and compares byte-for-byte, which is what makes the committed
Markdown evidence rather than a copy someone remembered to update.
