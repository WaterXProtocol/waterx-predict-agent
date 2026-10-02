# packages/sdk — `@waterx/predict-agent-sdk`

The published execution core; every other surface in the workspace compiles
down to a call into it. Depends on nothing else in the workspace (enforced by
`tests/workspace.test.ts`). `packages/AGENTS.md` carries the trading
invariants and the root `AGENTS.md` the safety policy; this file is what is
specific to this package.

`src/direct/` is direct mode (ADR-0013): `PredictDirectClient` over the public
WaterX routes, and a verifier over the dependency-free decoder in
`src/sui-tx.ts` that must pass before any sponsored byte is signed. Loosening a
verifier rule is a security change, not a fix.

## Layout

- `src/contract.ts` — vendored, import-free public wire contract (see below).
- `src/client.ts` — agent-facing client and orchestration helpers.
- `src/transport.ts` — URL construction, auth headers, error decoding, and safe
  retries.
- `src/execution-stream.ts` — the `ExecutionStream` seam and the shipped
  Socket.IO client behind it: cursor, gap and reconnect reconciliation, a bounded
  handshake-failure budget, and the lazy import of the one runtime dependency.
- `src/signer.ts` — structural Sui signer boundary and auth-message signing.
- `src/decimal.ts` — exact fixed-scale comparisons for prices and sizes.
- `src/errors.ts` — stable API and transport error surfaces.
- `src/index.ts` — package public exports.
- `tests/` — executable guarantees, especially money-sensitive behavior.
- `README.md` — developer-facing quickstart, limitations, and operational
  semantics.
- `examples/watch-quotes.mjs` — the stream example. It lives here, not in
  `packages/e2e`, because a subscription is not a command shape and e2e may
  depend only on the CLI and the schema; the e2e suite still executes and lints
  it.
- `SKILL.md`, `AGENT_INSTRUCTIONS.md` — **generated** copies of the product's
  prompt surface, shipped through this package's `files`. Never hand-edit; run
  `pnpm instructions:generate` (source: `packages/adapters/src/`). CI diffs
  them against the generator.
- `recipes/` — hand-written, shipped example scripts (`files` includes them);
  they are prompt-adjacent copy an agent host may run, so keep them in step
  with the real API.

Route construction and retry policy do not belong in individual helpers, wire
types do not import client code, and protocol transaction construction does
not belong in this SDK.

## Wire-contract discipline

`src/contract.ts` is a vendored copy of the backend contract
(`../bucket-backend-mono/apps/waterx/src/predict/agent-api/agent-api.contract.ts`)
with an SDK-specific header. Its contract body must match the authoritative
backend file. The file must remain self-contained and have zero imports so it
can be published without pulling in NestJS, the Sui SDK, or backend domain code.

When changing the contract:

1. Establish the intended API behavior in the authoritative backend contract.
2. Update backend DTOs/controllers/services and their contract/route tests.
3. Sync the complete contract body into `src/contract.ts`, retaining only the
   SDK-specific vendoring header difference.
4. Update client methods, package exports, tests, and README in the same change.
5. Inspect a full diff between the two contract files. The local route-map test
   is useful but does not prove that every type is synchronized.

Do not invent a speculative wire field in the SDK. Do not silently rename,
remove, or reinterpret fields on only one side.

Wire-format rules are invariants:

- Money, prices, and sizes are decimal strings, never JavaScript `number`s.
- Preserve the current precision rules and compare decimals exactly.
- `null` means known absence; an omitted optional property means not applicable.
  Do not collapse the two.
- Treat documented open sets such as quote quality flags as open sets; an SDK
  must tolerate a value introduced by a newer server.
- Build all endpoint paths from `PREDICT_AGENT_API_ROUTES`.

## Streaming

The SDK provides native quote and execution streaming while retaining
injectable seams for tests and specialized callers. A well-maintained official
Socket.IO client is acceptable when the backend protocol requires it; do not
preserve zero runtime dependencies as a goal at the cost of shipping an
unusable core feature.

Streaming correctness is more important than merely opening a socket:

- Streams are accelerators, not the final authority. Confirm terminal execution
  state through REST.
- Preserve cursors/sequences across reconnects, detect gaps, and reconcile after
  a gap rather than assuming no frames were missed.
- Clean up listeners, timers, and sockets on completion, abort, timeout, and
  connection failure.
- A dead execution stream must degrade to bounded REST polling rather than hang.
- Quote-stream triggers still require a fresh executable quote and target
  re-verification before an order.
- Do not label polling as WebSocket support. If the backend cannot yet supply a
  reliable quote stream, keep the limitation explicit in code and README.

## Dependencies

The SDK has exactly one runtime dependency: `socket.io-client`, for the
execution stream. The argument is at the top of `src/execution-stream.ts`, the
allowlist is enforced by `tests/workspace.test.ts`, and it is loaded with
`await import` so a caller that never streams never loads it. Adding a second
one means editing that test, which means writing the argument down. Do not add
the full Sui SDK or Move bindings merely to satisfy types; keep the structural
signer interface unless transaction ownership genuinely moves into this
package. Preserve the injectable transport/stream seams so unit tests remain
deterministic.
