# AGENTS.md

Guidance for coding agents in this repository. Both Claude Code (v2.1.281+) and Codex read this file. Do not add a CLAUDE.md anywhere in the repo: Claude Code ignores every AGENTS.md at or below a directory that has one.

It applies to the whole workspace. Before changing code in any
package, read `packages/AGENTS.md` (the trading invariants every order path must keep, and the
runtime and dependency rules); each package under `packages/` also has its own `AGENTS.md` with
that package's layout and rules — read it before changing anything there.

## Mission and scope

This is the pnpm workspace for the WaterX Predict agent runtime. Its centre is the Node.js
TypeScript SDK for the Agent Trading API; alongside it sit the versioned agent command contract,
the `waterx-predict` CLI, the local Runner and optional adapters (ADR-0001 §4). It does not own the
REST service, quote production, on-chain contracts, delegation, monitoring dashboards, or an
agent's trading strategy.

The SDK is the execution core. Every other surface validates against the command contract and
compiles down to the same SDK call; none of them implements its own quoting, retry, signing, policy
or job state. Keep the product boundary clear:

- Reads should be rich enough for an agent to make its own decision.
- The only server-side trading primitive is a price-protected market order.
- Conditional orders remain client-side. `waitForPriceAndExecute` observes a target and submits
  one protected market order; it must not create hidden server-side conditional-order state.
- Multi-action workflows are allowed. The SDK may orchestrate several orders, but every order
  remains independent and may succeed or fail on its own.
- Delegation is an external authorization boundary. The SDK authenticates the agent wallet and
  reports server decisions; it does not implement, emulate, or weaken delegation.
- Do not add Python, backend condition storage, dashboards, or server code here unless a task
  explicitly changes this repository's scope. The adapters (`packages/adapters`, `packages/mcp`)
  are thin translations over the command contract — never a second command surface.

Nothing is on npm; the only artifacts are GitHub pre-release tarballs (sdk + schema, `v0.1.0`).
Prefer a coherent, clean public API over compatibility scaffolding when a redesign is warranted, and
remove obsolete API shapes rather than keeping confusing aliases. A breaking change is still an
atomic change: update the wire contract, client, exports, tests, and README together; do not leave
two competing semantics in the package.

## Scope, evidence, and lessons

The request sets the scope. When the user is describing a problem, asking a question, or thinking
out loud rather than asking for a change, the deliverable is your assessment: report findings and
stop. Keep changes to what the task needs; cleanup, extra tests, a fix for a bug you were only asked
to assess, or adjacent SPEC backlog go in the summary as suggestions, not in the change.

Before reporting progress, check each claim against a tool result from this session: report only
work you can point to evidence for, and say plainly what is unverified or was skipped.

Lessons not already in this file, a package file, the ADRs, or the backlog live in
`docs/knowledge-hub/` (one file per lesson; the format is in its README). Scan the titles there
before starting work in an unfamiliar area, and add a note when something cost real time that the
next session would otherwise rediscover.

Shared skills: `.claude/settings.json` enables the waterx-commons plugins waterx-harness
(`/waterx-harness:adopt-harness-standard`, `/waterx-harness:harness-transform`,
`/waterx-harness:knowledge-hub-lesson`) and waterx-review (`/waterx-review:waterx-code-review`).
Claude Code loads them after you accept the workspace-trust prompt, with your own GitHub access to
the private Bucket-Protocol/waterx-commons (a different organization from this repository, so you
need read access there as well), and not in cloud sessions; Codex users link them into
`~/.agents/skills` ([waterx-commons plugins,
"Codex"](https://github.com/Bucket-Protocol/waterx-commons/tree/main/plugins)). This file and the
package `AGENTS.md` files win over a plugin skill.

## Safety and test policy

Never use real private keys, production tokens, mainnet funds, or production order endpoints during
development or verification. The CLI connects to mainnet when no deployment is named (ADR-0011), so
a local run against a real server must set `WATERX_PREDICT_ENVIRONMENT=testnet` explicitly; tests
stub the transport and must keep doing so. Unless the user explicitly authorizes a named environment
and action, use mocks, local services, or devnet/testnet. Never print auth tokens, signatures,
sponsored transaction bytes, or secret material in logs, fixtures, errors, or documentation.

Money-sensitive behavior requires focused tests. At minimum, cover the affected cases among:
stable idempotency across retries and process-resumable caller keys; permanent versus retryable
server failures; BUY/SELL target direction and exact decimal comparisons; fresh-quote
re-verification and exactly-one submission; timeout ambiguity, aborts, reconnects, gaps, and
resource cleanup; terminal REST confirmation after stream notifications; independent multi-order
results and partial failure; personal-message auth signing versus transaction signing; route and
wire-contract drift.

Mocks can prove orchestration but not cryptographic or cross-service compatibility. When a task
changes signing, serialization, or a cross-repo contract, run the available non-production
integration test if the environment is explicitly provided; otherwise report that verification gap
rather than substituting confidence for evidence.

## Required verification

For every code change, run from the workspace root, in this order:

```bash
pnpm build
pnpm typecheck
pnpm test
```

Build first: the packages resolve each other through `node_modules` and their `types` point into
`dist/`, so on a clean checkout typecheck fails with "Cannot find module @waterx/predict-agent-sdk"
until `dist/` exists (a working tree hides this). Each command fans out across the workspace: the
root suite covers cross-package invariants, then `pnpm -r` runs every package's own. During
development a focused `pnpm --filter <package> run test` is enough; run all three before handoff.

CI (`.github/workflows/verify.yml`) runs those three, then `pnpm install:check`, regenerates
`schemas/`, `agent-instructions/` (plus the copies under `packages/sdk`) and `sbom/`, and fails on
any diff; `pnpm release:preflight` is report-only there and `--strict` in the release workflow. If
the change touches a dependency, a published manifest or a generated artifact, run
`pnpm sbom:generate` and `pnpm release:preflight` locally and leave the tree clean — a stale SBOM
tells a scanner the wrong version is installed. A documentation-only change needs no code change,
but still check its links, commands, paths, and claims against the repository;
`scripts/agent-hooks/check-harness.sh` (CI `.github/workflows/harness.yml`) checks the agent files.

A task is complete only when:

- authoritative and vendored contracts agree for any touched wire surface;
- public API, exports, tests, and README describe one consistent behavior;
- relevant financial and failure-path invariants have regression coverage;
- required verification passes, or the exact environmental blocker is reported;
- current limitations are stated plainly rather than hidden behind an adapter or optimistic docs.

## System boundaries and sources of truth

This SDK is one part of a multi-repository system. Resolve sibling paths from the common parent
directory of the checkouts rather than hard-coding a developer's home path.

| Concern | Source of truth | This repository's role |
| --- | --- | --- |
| Agent REST/WS routes and wire shapes | `../bucket-backend-mono/apps/waterx/src/predict/agent-api/agent-api.contract.ts` | Vendor and consume the contract |
| REST behavior, re-quote, risk, auth, reconciliation, execution stream | `../bucket-backend-mono/apps/waterx/src/predict/agent-api/` | Expose a faithful SDK interface |
| Delegation, protocol permissions, price guards, on-chain lifecycle | `../waterx-contract` | Read-only reference; never reproduce protocol logic locally |
| Production live-odds publication and upstream liquidity facts | `../bucket-quant` | Read-only reference; consume only through the WaterX backend API |

Normal work changes this SDK and, when the task includes the API side, `bucket-backend-mono`. Treat
`waterx-contract` and `bucket-quant` as read-only unless the user explicitly expands the task; a
Story that mentions delegation or quote quality is not permission to edit their owners. Sibling
checkouts may be on other branches with uncommitted work: inspect a checkout's branch, commit and
worktree before relying on it, and preserve unrelated changes. If the backend and SDK contracts
differ unexpectedly, show the semantic diff and determine which checkout the task targets; never
overwrite one side blindly. Say up front whether a change is SDK-only or an intentional
backend-plus-SDK contract change — the two verify differently (`packages/sdk/AGENTS.md`).

When sources disagree, the precedence is: (1) the authoritative backend wire contract; (2) verified
behavior in tests and the implementation they exercise; (3) the current README; (4) `docs/adr/`;
(5) `docs/IMPLEMENTATION_BACKLOG.md`; (6) planning documents and Story/SPEC text. Items 1–3 are
evidence of how the code behaves today, so they win when describing current behavior. `docs/adr/`
binds what you may build next — a recorded decision is not reopened inside a feature branch or an
adapter; changing one needs a new ADR stating the compatibility, security, and operational impact.
The SPEC is product context, not a checklist: do not implement an item merely because an older plan
mentions it, and do not preserve an implementation that contradicts the current contract.

## Decision and status records

`docs/adr/` holds the binding decisions (indexed in `docs/adr/README.md`).
`docs/IMPLEMENTATION_BACKLOG.md` is the only file tracking implementation status, with a file/test
reference for anything marked done. `docs/AGENT_INSTALLATION_AND_RUNTIME_PLAN.md` is planning
narrative, never evidence that a capability exists. So a capability may be reported as available —
by `describe`, the README, or a commit message — only when the backlog marks it done, meaning its
public path and its failure/recovery behavior work and are tested. An interface with no
implementation behind it is a seam, not support: do not describe the execution-stream or
price-watcher seams as streaming support.

## Repository map

The workspace is `packages/*` (`pnpm-workspace.yaml`); shared compiler options are in
`tsconfig.base.json`; the root `package.json` is private and orchestrates.

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

Dependency direction is one-way and enforced by `tests/workspace.test.ts`: the SDK and the schema
depend on nothing else here, the CLI and Runner depend on both, and adapters depend on the CLI and
the schema, never the SDK. That is the point of the split — daemon, storage, CLI-parsing and adapter
dependencies must never reach the published SDK. The two signer packages carry `@mysten/sui`, so
they are reached as processes and never imported (the test lists them under `PROVIDERS`).

At the root:

- `schemas/`, `agent-instructions/`, `sbom/` — generated, committed artifacts. Never hand-edit;
  regenerate with `pnpm schema:generate`, `pnpm instructions:generate`, `pnpm sbom:generate`. CI
  diffs each against its generator. `agent-instructions/` is what the MCP adapter returns at
  `initialize` and what a host that cannot run this toolchain reads.
- `tests/` — cross-package invariants only (boundaries, dependency direction, published-package
  hygiene, command-to-SDK-method drift).
- `bin/`, `scripts/prepare-git-install.mjs` — the git-install shape (ADR-0019): `npm install
  github:…` runs the root `prepare`, which builds and assembles the tree the two `bin/` entries
  point at. It is a no-op for a developer; `pnpm build` is still the build here.
