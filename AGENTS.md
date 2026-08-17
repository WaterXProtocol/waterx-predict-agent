# AGENTS.md

This file is for coding agents working in this repository. It applies to the
entire repository.

## Mission and scope

This repository is the pnpm workspace for the WaterX Predict agent runtime. Its
centre is the Node.js TypeScript SDK for the Agent Trading API; alongside it sit
the versioned agent command contract, the `waterx-predict` CLI, and
reserved boundaries for the local Runner and optional adapters (ADR-0001 §4). It does not own the REST
service, quote production, on-chain contracts, delegation, monitoring dashboards,
or an agent's trading strategy.

The SDK is the execution core. Every other surface in this workspace validates
against the command contract and compiles down to the same SDK call; none of them
implements its own quoting, retry, signing, policy or job state.

Keep the product boundary clear:

- Reads should be rich enough for an agent to make its own decision.
- The only server-side trading primitive is a price-protected market order.
- Conditional orders remain client-side. `waitForPriceAndExecute` observes a
  target and submits one protected market order; it must not create hidden
  server-side conditional-order state.
- Multi-action workflows are allowed. Multiple orders may also be orchestrated
  by the SDK, but every order remains independent and may succeed or fail on its
  own.
- Delegation is an external authorization boundary. The SDK authenticates the
  agent wallet and reports server decisions; it does not implement, emulate, or
  weaken delegation.
- Do not add Python, backend condition storage, dashboards, or server code here
  unless a task explicitly changes this repository's scope. An MCP adapter has a
  reserved package boundary (`packages/mcp`) and is a thin translation over the
  command contract when it is built — never a second command surface.

No package here has been published yet. Prefer a coherent, clean public API over
compatibility scaffolding when a redesign is warranted. A breaking change is
still an atomic change: update the wire contract, client, exports, tests, and
README together; do not leave two competing semantics in the package.

## System boundaries and sources of truth

This SDK is one part of a multi-repository system. Resolve sibling paths from
the common `bucket/` parent rather than hard-coding a developer's home path.

| Concern | Source of truth | This repository's role |
| --- | --- | --- |
| Agent REST/WS routes and wire shapes | `../bucket-backend-mono/apps/waterx/src/predict/agent-api/agent-api.contract.ts` | Vendor and consume the contract |
| REST behavior, re-quote, risk, auth, reconciliation, and execution stream | `../bucket-backend-mono/apps/waterx/src/predict/agent-api/` | Expose a faithful SDK interface |
| Delegation, protocol permissions, price guards, and on-chain lifecycle | `../waterx-contract` | Read-only reference; never reproduce protocol logic locally |
| Production live-odds publication and upstream liquidity facts | `../bucket-quant` | Read-only reference; consume only through the WaterX backend API |

Normal implementation work changes this SDK and, when the task includes the API
side, `bucket-backend-mono`. Treat `waterx-contract` and `bucket-quant` as
read-only unless the user explicitly expands the task to those repositories. A
Story that mentions delegation or quote quality is not permission to edit their
owners.

Within the SDK's scope, use this precedence when sources disagree:

1. The authoritative backend wire contract.
2. Verified behavior in tests and the implementation they exercise.
3. The current README.
4. `docs/adr/` — accepted architecture decisions.
5. `docs/IMPLEMENTATION_BACKLOG.md` — what is actually implemented.
6. planning documents and Story/SPEC text.

Note the split: items 1–3 are evidence of how the code behaves **today**, so they
win when describing current behavior. `docs/adr/` binds what you may build
**next** — a decision recorded there is not reopened inside a feature branch or
an adapter; changing one needs a new ADR stating the compatibility, security, and
operational impact.

The SPEC is product context, not a checklist. Do not implement an item merely
because an older plan mentions it. Conversely, do not preserve an implementation
that contradicts the current authoritative contract.

## Decision and status records

- `docs/AGENT_INSTALLATION_AND_RUNTIME_PLAN.md` — the runtime plan. Planning
  narrative only; it is never evidence that a capability exists.
- `docs/adr/` — binding decisions, indexed in `docs/adr/README.md`.
- `docs/IMPLEMENTATION_BACKLOG.md` — the **only** file tracking implementation
  status, with a file/test reference for anything marked done.

Two rules follow from that split, and both matter more than they look:

- A capability may be reported as available — by `describe`, the README, or a
  commit message — only when the backlog marks it done, meaning its public path
  *and* its failure/recovery behavior work and are tested.
- An interface with no implementation behind it is a seam, not support. Do not
  describe the execution-stream or price-watcher seams as streaming support.

Before relying on a sibling checkout, inspect its branch, commit, and worktree.
If the backend and SDK contracts differ unexpectedly, show the semantic diff and
determine which checkout the task targets. Never overwrite one side blindly.

## Repository map

The workspace is `packages/*`, declared in `pnpm-workspace.yaml`. Shared compiler
options live in `tsconfig.base.json`; the root `package.json` is private and only
orchestrates.

| Package | Name | State |
| --- | --- | --- |
| `packages/sdk` | `@waterx/predict-agent-sdk` | Published surface, implemented |
| `packages/schema` | `@waterx/predict-agent-schema` | Published surface, implemented |
| `packages/cli` | `@waterx/predict-agent-cli` | Implemented, reads **and writes** behind an enforced execution policy; `private`, so nothing is published |
| `packages/runner` | `@waterx/predict-agent-runner` | Reserved boundary, **not implemented** |
| `packages/mcp` | `@waterx/predict-agent-mcp` | Reserved boundary, **not implemented** |
| `packages/e2e` | `@waterx/predict-agent-e2e` | Harness that drives the installed CLI as a subprocess; `private`, never shipped. The end-to-end has **not run** — nothing here is evidence that it passes |

Dependency direction is one-way and enforced by `tests/workspace.test.ts`: the
SDK depends on nothing else here, the schema depends on nothing else here, and
CLI/Runner/adapters depend on both. That is the whole point of the split — daemon,
storage, CLI-parsing and adapter dependencies must never reach the published SDK
library.

Inside `packages/sdk`:

- `src/contract.ts` — vendored, import-free public wire contract.
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

Inside `packages/schema`:

- `src/json-schema.ts` — the enforceable JSON Schema subset and its validator.
- `src/defs.ts` — shared field rules, mirrored from the backend DTOs.
- `src/commands.ts` — the command registry: one entry per agent-issuable command.
- `src/document.ts`, `src/generate.ts` — emit `schemas/v1/agent-commands.json`.
- `src/validate.ts` — `validateCommandInput`, the runtime gate every surface uses.

Inside `packages/cli`:

- `src/run.ts` — the dispatcher. It writes stdout **exactly once, and always**:
  any failure still produces a parseable envelope, and only `ok`, `error` and the
  exit code change. `src/main.ts` is the bin entry and sets `process.exitCode`
  rather than calling `process.exit()`, which can truncate an unflushed write.
- `src/envelope.ts`, `src/exit-codes.ts` — the one output shape and the stable
  code table. An existing exit code never changes meaning.
- `src/capabilities.ts` — the inventory of what this build can and cannot do.
  A refusal is looked up here, so it cannot drift from what `describe` published.
  This module imports nothing, so the workspace suite can read it without
  dragging the CLI in.
- `src/config.ts`, `src/redact.ts`, `src/signer.ts` — configuration precedence
  and the secret rules: a credential-shaped config key is refused, a registered
  secret is replaced with `[redacted]` on both streams, and under `read-only`
  `signTransaction` throws before a signer process is started.
- `src/policy.ts` — the execution policy and the signing gate. `--policy` may
  only narrow. A write is authorized locally *before* any network read, so an
  out-of-scope order costs nothing; the authorization grants a counted permit,
  and the permit is spent before the signer child runs. An approval token binds
  one exact intent and is **not** authentication.
- `src/input.ts`, `src/parse.ts` — argv to a validated command input. Nothing is
  coerced: a flag value that does not match its declared type is an error.
- `src/commands/` — one thin handler per command. Server responses pass through
  unchanged, with caveats attached alongside rather than merged in.
- `tests/harness.ts` — every test invokes the CLI end to end through it; none
  opens a socket, spawns a process or reads a real file.

Inside `packages/e2e` — the only place in this repository that spawns processes
and opens sockets, and the only place allowed to:

- `src/steps.ts` — the plan, declared: what each step would PROVE, which
  provisioning gaps it needs, which steps it reads from, whether it writes.
- `src/gaps.ts` — the seven provisioning gaps and who supplies each. Two are
  owner-authenticated (`delegation`, `ownerRiskProfile`) and this repository
  **must not attempt** them: an agent runtime that could grant its own mandate
  would make the mandate meaningless (ADR-0003 §1).
- `src/report.ts` — the honesty rules, as types. A `NOT_RUN` step carries no
  evidence field, so "passed without running" cannot be written down; any step
  whose evidence came from a `STUB` makes the whole report `INVALID`.
- `src/run.ts` — the gates. A write needs an explicit `--allow-write` **and** an
  environment label on the non-production allowlist. Unlabelled counts as
  production and is never traded on.
- `src/lint.ts` — every published invocation, including the examples and the
  READMEs, checked against the command contract without running it. This exists
  because a printed recovery instruction once used a flag spelling that exits
  `USAGE`.
- `examples/` — executable, and executed by the suite with nothing provisioned to
  prove they refuse with a named supplier rather than a stack trace.

Elsewhere:

- `schemas/` — **generated**, committed artifacts. Never hand-edit; run
  `pnpm schema:generate`.
- `tests/` — cross-package invariants only (boundaries, dependency direction,
  published-package hygiene, command-to-SDK-method drift).

Keep those responsibilities separated. Route construction and retry policy do
not belong in individual helpers, wire types do not import client code, and
protocol transaction construction does not belong in this SDK.

## Command-contract discipline

`packages/schema` is the single source of truth for what an agent may ask for
(ADR-0001 §5, ADR-0006). Two contracts exist and they are not the same thing: the
**wire** contract says what an HTTP request looks like and is owned by the
backend; the **command** contract says what an intent looks like and is owned
here.

- Author command inputs as plain JSON Schema in `packages/schema/src`, then
  regenerate. The committed artifact is compared byte-for-byte by a test.
- A keyword outside the validator's subset is a hard error. Widening the subset
  is a deliberate edit plus a test, never an accident in a schema definition.
- `enum` is closed and enforced; `x-waterx-open-set` is an annotation and must
  never be enforced.
- Validation never coerces. It returns the input unchanged or a list of
  violations.
- Do not add a command entry for a capability the execution core cannot perform.
  A schema entry is what an adapter turns into an advertised, callable tool.

## Wire-contract discipline

`packages/sdk/src/contract.ts` is a vendored copy of the backend contract with an
SDK-specific header. Its contract body must match the authoritative backend file. The file
must remain self-contained and have zero imports so it can be published without
pulling in NestJS, the Sui SDK, or backend domain code.

When changing the contract:

1. Establish the intended API behavior in the authoritative backend contract.
2. Update backend DTOs/controllers/services and their contract/route tests.
3. Sync the complete contract body into `packages/sdk/src/contract.ts`, retaining
   only the SDK-specific vendoring header difference.
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

## Trading invariants

Mistakes in this section can place duplicate or mispriced orders. Preserve them
with explicit tests.

### Quotes and price protection

- Market-catalog bid/ask/probability fields are indicative. Only a quote minted
  through the quote endpoint is executable.
- WaterX prices orders from its own quote pipeline. Do not expose raw upstream
  orderbooks or derive a competing price inside the SDK.
- The backend re-quotes at execution time. Keep `maxSlippageBps` mandatory for
  every order intent and preserve `worstAcceptablePrice` when supplied.
- The on-chain `enforcedWorstPrice` may be stricter after safe granularity
  rounding, but it must never be looser than the caller's protection.
- A quote is short-lived and must not be cached or have its expiry extended.
- Current top-of-book quotes are size-blind. Never fabricate depth,
  `availableSize`, expected fill size, or fee facts that the server cannot
  observe.
- Quote-to-fill deviation is a product-critical signal. Preserve the quote IDs,
  prices, timestamps, and actual fill facts needed to measure it; do not round,
  smooth, or substitute indicative catalog data. Monitoring itself belongs to
  the backend/observability stack.

### Execution lifecycle

- Create, sign, and submit are distinct facts even when one SDK method
  orchestrates them.
- `SUBMITTED` and `PENDING_FILL` are not fills. Only a terminal read may report
  authoritative fill and remaining-allowance facts.
- Preserve the distinction between the agent's submission transaction and the
  keeper's fill transaction.
- A terminal-wait timeout means the SDK stopped waiting. It does not mean the
  order failed or was cancelled; callers must be able to reconcile by execution
  ID.
- A SELL identifies the position being closed and must not silently sell more
  shares than requested or held.

### Idempotency and retry

- Generate one idempotency key per logical order intent and reuse it for every
  retry of that intent.
- A caller-supplied key must survive the complete flow and must never leak into
  the JSON body when the wire contract requires it as a header.
- Only retry a request when replaying the exact bytes is safe. A create is safe
  only under its stable idempotency key; submit is safe only because the server
  defines repeated submission as idempotent.
- Use the server's `retryable` field for API errors. Do not maintain a competing
  client-side judgment table.
- Do not turn proxy HTML, malformed bodies, or unknown failures into a fabricated
  symbolic API error.
- Keep automatic retries and long-running waits bounded, abortable, and
  backoff-aware. Do not hide `RATE_LIMITED` in an unbounded retry loop.

### Synthetic limits and multiple orders

- For a BUY, a target price is a ceiling. For a SELL, it is a floor.
- A watched price is only a trigger. After the target is observed, fetch a fresh
  executable quote and re-check the target before submitting.
- Mint the idempotency key before the wait loop and submit at most one logical
  execution. Waiting expiry before submission must place nothing.
- `executeMany` is client-side orchestration, not a batch or atomic backend
  order. Each leg has its own quote, execution, idempotency key, and result.
- Partial success is expected. A STOP policy may prevent unstarted legs from
  launching, but it cannot cancel or roll back work already submitted or filled.
  Report failed, successful, and skipped legs distinctly.

### Authentication, delegation, and allowance

- Authentication challenges use Sui personal-message signing. Sponsored
  transaction bytes use transaction signing. These primitives are not
  interchangeable.
- The authenticated agent wallet must be the signer of the sponsored bytes;
  WaterX may sponsor gas but does not sign for the agent.
- Do not cache a local claim that delegation is valid. The backend/on-chain
  checks are authoritative, and revocation must be able to reject the next write
  immediately.
- API allowance is a WaterX policy, not an on-chain security boundary. Keep it
  distinct from the account's spendable balance and from protocol delegation.

## Streaming requirements

The intended SDK should provide native quote and execution streaming while
retaining injectable seams for tests and specialized callers. It is acceptable
to add a well-maintained official Socket.IO client when the backend protocol
requires it; do not preserve zero runtime dependencies as a goal at the cost of
shipping an unusable core feature.

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

## Runtime and dependency policy

- Target Node.js 20+ and ESM. Browser, Deno, and Bun compatibility are not
  promised unless a task explicitly adds and verifies them.
- Prefer platform capabilities such as `fetch`, `AbortSignal`, Web Crypto, and
  `node:crypto` where they fit.
- Runtime dependencies are allowed when they make a core feature complete and
  reliable. For each addition, justify its purpose, maintenance/security posture,
  package cost, and Node.js compatibility.
- The SDK currently has exactly one: `socket.io-client`, for the execution
  stream. The argument is at the top of `src/execution-stream.ts`, the allowlist
  is enforced by `tests/workspace.test.ts`, and it is loaded with `await import`
  so a caller that never streams never loads it. `@waterx/predict-agent-schema`
  has none and must keep it that way. Adding a second one means editing that test,
  which means writing the argument down.
- Do not add the full Sui SDK or Move bindings merely to satisfy types. Keep the
  structural signer interface unless transaction ownership genuinely moves into
  this package.
- Preserve injectable transport/stream seams so unit tests remain deterministic.

## Implementation workflow

Before editing:

1. Read the relevant source, tests, README section, and authoritative backend
   contract or implementation.
2. Check all involved worktrees and preserve unrelated user changes.
3. State whether the change is SDK-only or an intentional backend-plus-SDK
   contract change.

While editing:

- Keep changes focused on the requested behavior; do not implement adjacent SPEC
  backlog by inference.
- Add or update tests at the same time as behavior. Test observable guarantees,
  not private implementation trivia.
- Keep comments for non-obvious financial, retry, signing, stream, and lifecycle
  reasoning. Do not narrate obvious syntax.
- Keep `README.md` truthful. A developer following its quickstart should see the
  real API, required safeguards, and current limitations.
- Ensure every intended public value is exported through the owning package's
  `src/index.ts` and is present in its built `dist`.
- When a change alters what an agent may ask for, update `packages/schema` and
  regenerate `schemas/` in the same change.

Because the package is pre-release, remove obsolete API shapes rather than
keeping confusing aliases by default. Do not claim a capability is implemented
until both the public path and its failure/recovery behavior work.

## Safety and test policy

Never use real private keys, production tokens, mainnet funds, or production
order endpoints during development or verification. Unless the user explicitly
authorizes a named environment and action, use mocks, local services, or
devnet/testnet. Never print auth tokens, signatures, sponsored transaction bytes,
or secret material in logs, fixtures, errors, or documentation.

Money-sensitive behavior requires focused tests. At minimum, cover affected
cases among:

- stable idempotency across retries and process-resumable caller keys;
- permanent versus retryable server failures;
- BUY/SELL target direction and exact decimal comparisons;
- fresh-quote re-verification and exactly-one submission;
- timeout ambiguity, aborts, reconnects, gaps, and resource cleanup;
- terminal REST confirmation after stream notifications;
- independent multi-order results and partial failure;
- personal-message auth signing versus transaction signing;
- route and wire-contract drift.

Mocks can prove orchestration but not cryptographic or cross-service
compatibility. When a task changes signing, serialization, or a cross-repo
contract, run the available non-production integration test if the environment
is explicitly provided. Otherwise report that remaining verification gap; do not
substitute confidence for evidence.

## Required verification

For every code change, run from the workspace root:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Each fans out across the workspace: the root suite covers cross-package
invariants, then `pnpm -r` runs every package's own. Run a focused suite during
development with `pnpm --filter <package> run test`, then all three root commands
before handoff.
Documentation-only changes do not require inventing code changes, but still
inspect links, commands, paths, and claims against the current repository.

A task is complete only when:

- authoritative and vendored contracts agree for any touched wire surface;
- public API, exports, tests, and README describe one consistent behavior;
- relevant financial and failure-path invariants have regression coverage;
- required verification passes, or the exact environmental blocker is reported;
- current limitations are stated plainly rather than hidden behind an adapter or
  optimistic documentation.
