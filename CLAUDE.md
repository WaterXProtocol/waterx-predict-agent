# CLAUDE.md

Guidance for coding agents working in this repository (Claude Code reads this
file; `AGENTS.md` is a symlink to it for Codex). It applies to the whole
workspace; each package under `packages/` has its own `CLAUDE.md` — read it
before changing anything there.

## Mission and scope

This repository is the pnpm workspace for the WaterX Predict agent runtime. Its
centre is the Node.js TypeScript SDK for the Agent Trading API; alongside it sit
the versioned agent command contract, the `waterx-predict` CLI, the local
Runner and optional adapters (ADR-0001 §4). It does not own the REST service,
quote production, on-chain contracts, delegation, monitoring dashboards, or an
agent's trading strategy.

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
  unless a task explicitly changes this repository's scope. The adapters
  (`packages/adapters`, `packages/mcp`) are thin translations over the command
  contract — never a second command surface.

Nothing is on npm; the only artifacts are GitHub pre-release tarballs (sdk +
schema, `v0.1.0`). Prefer a coherent, clean public API over compatibility
scaffolding when a redesign is warranted. A breaking change is still an atomic
change: update the wire contract, client, exports, tests, and README together;
do not leave two competing semantics in the package.

## Scope, assessment, and lessons

The request sets the scope. When the user is describing a problem, asking a
question, or thinking out loud rather than asking for a change, the deliverable
is your assessment: report findings and stop. Keep changes to what the task
needs; cleanup, extra tests, or a fix for a bug you were only asked to assess go
in the summary as suggestions, not in the change. Do not implement adjacent
SPEC backlog by inference.

Before reporting progress, check each claim against a tool result from this
session: report only work you can point to evidence for, and say plainly what
is unverified or was skipped.

Lessons that are not already in this file, a package file, the ADRs, or the
backlog live in `docs/knowledge-hub/` (one file per lesson; the format is in
its README). Scan the titles there before starting work in an unfamiliar area,
and add a note at the end of a task when something cost real time that the next
session would otherwise rediscover. Update an existing note rather than
duplicating it; delete one that turns out to be wrong.

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

Sibling checkouts may be on other branches with uncommitted work: before
relying on one, inspect its branch, commit, and worktree, and preserve
unrelated changes. If the backend and SDK contracts differ unexpectedly, show
the semantic diff and determine which checkout the task targets. Never
overwrite one side blindly. Say up front whether a change is SDK-only or an
intentional backend-plus-SDK contract change — the two have different
verification (`packages/sdk/CLAUDE.md`, Wire-contract discipline).

## Repository map

The workspace is `packages/*`, declared in `pnpm-workspace.yaml`. Shared compiler
options live in `tsconfig.base.json`; the root `package.json` is private and only
orchestrates. Each package's `CLAUDE.md` holds its layout and its own rules.

| Package | Name | What it is |
| --- | --- | --- |
| `packages/sdk` | `@waterx/predict-agent-sdk` | Published execution core; owns the vendored wire contract and streaming |
| `packages/schema` | `@waterx/predict-agent-schema` | Published command contract and validator; generates `schemas/` |
| `packages/cli` | `@waterx/predict-agent-cli` | `waterx-predict`: reads and writes behind an enforced policy; `private`, ships only as the operator bundle |
| `packages/runner` | `@waterx/predict-agent-runner` | Durable job store, daemon, scheduler, reconciliation; `private`, Node 24 |
| `packages/signer-browser` | `@waterx/predict-agent-signer-browser` | Browser-wallet signer process for `interactive`; `private` |
| `packages/signer-keystore` | `@waterx/predict-agent-signer-keystore` | Unattended keystore signer process for `delegated-auto`; `private` |
| `packages/adapters` | `@waterx/predict-agent-adapters` | Host-neutral instructions, tool projection, subprocess dispatcher; generates `agent-instructions/`; `private` |
| `packages/mcp` | `@waterx/predict-agent-mcp` | MCP stdio transport over the adapters, nothing more; `private` |
| `packages/e2e` | `@waterx/predict-agent-e2e` | Subprocess harness; the only place that spawns processes; has not run; `private` |
| `packages/release` | `@waterx/predict-agent-release` | SBOM, preflight, consumer installs, the CLI bundle; `private` permanently |

Dependency direction is one-way and enforced by `tests/workspace.test.ts`: the
SDK depends on nothing else here, the schema depends on nothing else here, and
CLI/Runner/adapters depend on both. That is the whole point of the split —
daemon, storage, CLI-parsing and adapter dependencies must never reach the
published SDK library. The two signer packages are reached as processes, never
imported, because they carry `@mysten/sui`.

Generated, committed artifacts at the root — never hand-edit, regenerate, and
CI diffs each against its generator:

- `schemas/` — `pnpm schema:generate`.
- `agent-instructions/` — `pnpm instructions:generate`. What the MCP adapter
  returns at `initialize` and what a host that cannot run this toolchain reads.
- `sbom/` — `pnpm sbom:generate`.

`tests/` holds cross-package invariants only (boundaries, dependency direction,
published-package hygiene, command-to-SDK-method drift).

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

## Runtime and dependency policy

- Target Node.js 20+ and ESM (the Runner alone needs 24, ADR-0007). Browser,
  Deno, and Bun compatibility are not promised unless a task explicitly adds
  and verifies them.
- Prefer platform capabilities such as `fetch`, `AbortSignal`, Web Crypto, and
  `node:crypto` where they fit.
- Runtime dependencies are allowed when they make a core feature complete and
  reliable. For each addition, justify its purpose, maintenance/security posture,
  package cost, and Node.js compatibility, and edit the allowlist in
  `tests/workspace.test.ts` — which is where the argument gets written down.
  `@waterx/predict-agent-schema` has none and must keep it that way.

## Implementation workflow

- Keep changes focused on the requested behavior.
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
order endpoints during development or verification. The CLI connects to
mainnet when no deployment is named (ADR-0011), so a local run against a real
server must set `WATERX_PREDICT_ENVIRONMENT=testnet` explicitly; tests stub the
transport and must keep doing so. Unless the user explicitly authorizes a named
environment and action, use mocks, local services, or devnet/testnet. Never
print auth tokens, signatures, sponsored transaction bytes, or secret material
in logs, fixtures, errors, or documentation.

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

For every code change, run from the workspace root, in this order:

```bash
pnpm build
pnpm typecheck
pnpm test
```

Build first: the packages resolve each other through `node_modules` and their
`types` point into `dist/`, so on a clean checkout typecheck fails with "Cannot
find module @waterx/predict-agent-sdk" until `dist/` exists (a working tree
hides this). Each command fans out across the workspace: the root suite covers
cross-package invariants, then `pnpm -r` runs every package's own. Run a focused
suite during development with `pnpm --filter <package> run test`, then all three
root commands before handoff.

CI (`.github/workflows/verify.yml`) runs those three, then `pnpm install:check`,
and regenerates `schemas/`, `agent-instructions/` (plus the copies under
`packages/sdk`) and `sbom/` and fails on any diff; `pnpm release:preflight` is
report-only there and `--strict` in the release workflow. If the change touches a
dependency, a published manifest or a generated artifact, run `pnpm sbom:generate`
and `pnpm release:preflight` locally and leave the tree clean — a stale SBOM
tells a scanner the wrong version is installed. Documentation-only changes do not
require inventing code changes, but still inspect links, commands, paths, and
claims against the current repository. `scripts/agent-hooks/check-harness.sh`
(CI `.github/workflows/harness.yml`) keeps the agent files themselves in shape.

A task is complete only when:

- authoritative and vendored contracts agree for any touched wire surface;
- public API, exports, tests, and README describe one consistent behavior;
- relevant financial and failure-path invariants have regression coverage;
- required verification passes, or the exact environmental blocker is reported;
- current limitations are stated plainly rather than hidden behind an adapter or
  optimistic documentation.
