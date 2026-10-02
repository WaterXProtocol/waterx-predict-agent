# packages/mcp — `@waterx/predict-agent-mcp`

Optional MCP stdio adapter: newline-delimited JSON-RPC 2.0 over `initialize` /
`ping` / `tools/list` / `tools/call`, tools capability only. A transport and
nothing more — the tools, the validation, the instructions and the delegation
all come from `packages/adapters`. Zero runtime dependencies beyond it.
`private`.

- `src/protocol.ts` — the slice of MCP spoken, hand-rolled so nothing new runs
  next to a signer.
- `src/server.ts` — the five methods.
- `src/stdio.ts` — newline framing, one request at a time.

Do not add a tool, a validation rule or an instruction here; that belongs in
`packages/adapters` (and the command itself in `packages/schema`).
