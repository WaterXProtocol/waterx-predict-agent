# `@waterx/predict-agent-mcp`

The optional MCP adapter: a stdio JSON-RPC transport over the WaterX Predict
command contract.

It is a transport and nothing more. The tool definitions, the input validation,
the host-neutral instructions and the delegation to the command core all come
from `@waterx/predict-agent-adapters`, which is this package's only dependency.
No pricing, retry, signing, policy or job state is implemented here, and a
workspace test holds that boundary: nothing under `src/` may import the schema,
the SDK, the CLI or the Runner directly.

`private: true` — this is real code with real tests, and it is not published.
Release is backlog item 3.6, and whether MCP ships in the first wave is still
open (D-28).

## Running it

```
waterx-predict-mcp [--config <path>] [--policy <mode>] [--runner-dir <path>] [--timeout-ms <n>]
```

The process speaks newline-delimited JSON-RPC 2.0 on stdin and stdout, one
request at a time, and exits when its client closes stdin. It starts no daemon
and holds no key. If a strategy needs a local Runner, the operator starts one
separately — see `@waterx/predict-agent-runner`.

The flags are the operator's, pinned for the whole session, and passed to the
command core unchanged.

## What it serves

`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.

Capabilities advertise `tools` only. There are **no resources, no prompts, no
sampling, no completions and no subscriptions** — a client discovers their
absence at `initialize` rather than meeting it as a failure mid-session. Any
other method is answered with `-32601` and a message saying so.

`initialize` returns the host-neutral agent instructions in
`InitializeResult.instructions`. That is the same document
`agent-instructions/AGENT_INSTRUCTIONS.md` holds and the same one the generic
function-calling adapter prints, which is the point of it existing.

Every tool is one command from `schemas/v1/agent-commands.json`, with the
contract's own input schema. Names are prefixed and mangled to a host-legal
form: `order.execute` → `waterx_predict_order_execute`.

## `isError` is stricter than the envelope

A `tools/call` result carries the command core's envelope verbatim, in the text
content, together with the exit code and the argv the core was run with.

`isError` is true unless the *whole* intent settled successfully. That is
deliberately stricter than the envelope's own `ok`: `order.execute-many` is
never atomic, and a call where one leg failed and another was skipped still
answers `ok: true` with a non-zero exit code. Reported to a model as a plain
success, that reads as "everything traded". So the result says error, and the
per-leg detail is in the content either way.

## A write will be refused

Under the default `interactive` policy, `order.execute`, `order.execute-many`
and `strategy.create` require an approval token that digests one exact
normalized intent. The token is supplied at the command core by an operator, per
order, and this adapter has no way to send one — deliberately.

So a write through MCP is refused with `POLICY_DENIED`, and the refusal names
the approval it expected. Preview the order, show the user what it would do, and
let a person run the approved command. Unattended writes require
`delegated-auto`, which is local operator configuration bounded by the account
owner's risk profile.

## No SDK dependency, on purpose

The MCP subset here is five methods over newline-delimited JSON-RPC. A protocol
SDK would be larger than the code it replaced, and this package sits one hop
from a process that signs transactions — every runtime dependency here is a
decision about what runs next to that. `protocol.ts` writes out the slice that
is spoken.
