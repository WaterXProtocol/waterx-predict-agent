# WaterX Predict agent runtime

A pnpm workspace for operating the WaterX Predict Agent Trading API from an
autonomous agent: quotes, price-protected market orders, positions and allowance.

**Today, the usable surfaces are the SDK and the CLI, which now trades.**
Everything else here is either the contract those surfaces are described by, or a
reserved boundary with no implementation behind it.
`docs/IMPLEMENTATION_BACKLOG.md` is the only file that tracks what actually works.

Because the CLI writes, what it may sign is decided by an enforced execution
policy rather than by convention: `interactive` (the default) needs one explicit
approval naming the exact order, `read-only` refuses `signTransaction` before a
signer process is started, and `delegated-auto` writes unattended only inside a
scope an operator wrote down. See
[Execution policy](packages/cli/README.md#execution-policy).

## Packages

| Package | What it is | State |
| --- | --- | --- |
| [`packages/sdk`](packages/sdk) | `@waterx/predict-agent-sdk` — the execution core. Authentication, quotes, protected market orders, reads. | Implemented |
| [`packages/schema`](packages/schema) | `@waterx/predict-agent-schema` — the versioned, runtime-validated command contract. | Implemented |
| [`packages/cli`](packages/cli) | The `waterx-predict` CLI: the universal agent surface. Discovery, doctor, market and account reads, and the market-order write plane, in one JSON envelope with stable exit codes. | Implemented and unpublished |
| [`packages/runner`](packages/runner) | The self-hosted local Runner. Today: the durable job store, the state machine, lease fencing, crash recovery, `UNKNOWN_PENDING` reconciliation against REST, `driveJob`, the scheduler that calls it on a tick, a `PriceObserver` over the SDK's indicative quote stream, a signer inside the trust boundary that will only sign for a `delegated-auto` job, and a daemon that recovers, supervises leases and answers an authenticated local socket. | The loop, its price source and the signer all exist; **there is no configuration surface to build a driver from**, so the shipped `runnerd` starts no scheduler and says so as `driving: false` |
| [`packages/mcp`](packages/mcp) | Optional MCP adapter. | Reserved, **not implemented** |
| [`packages/e2e`](packages/e2e) | Test harness. Drives the installed CLI end to end against a real non-production server, and reports what could not run. Never shipped. | Implemented; **the end-to-end itself has not run** — no environment is provisioned |

`schemas/v1/agent-commands.json` is generated from `packages/schema` and
committed, so a surface that cannot import a Node module reads the same contract.

## Why the split

The SDK is the execution core; every other surface compiles down to the same SDK
call (ADR-0001 §1–4). Keeping the CLI, the Runner and adapters in their own
packages means their dependencies — argument parsing, a SQLite job store, a
protocol client — never reach the published library. Dependency direction runs
one way, and `tests/workspace.test.ts` fails if it stops doing so.

The command contract exists for a narrower reason: TypeScript types do not run.
A CLI argument, a `--file` payload and a model's function call all arrive as
`unknown`, and on `order.execute` a missed check is a wrong trade rather than a
confusing error. So the contract is enforced at runtime, by one validator, for
every surface.

## Getting started

For using the client, see [`packages/sdk/README.md`](packages/sdk/README.md).
For driving it from a shell or a model host, see
[`packages/cli/README.md`](packages/cli/README.md).

```sh
pnpm install
pnpm typecheck   # root cross-package suite, then every package
pnpm test
pnpm build
pnpm schema:generate   # rewrite schemas/v1/agent-commands.json from source

# What the CLI is, with no configuration and no network.
node packages/cli/dist/src/main.js describe

# What is still missing before an end-to-end can run, and who supplies each.
# Reads only; exits non-zero until every step has actually run.
node packages/e2e/dist/src/main.js
```

Node.js 20+ and ESM. macOS and Linux; Windows is not verified (ADR-0002).

## Documentation

- [`packages/sdk/README.md`](packages/sdk/README.md) — quickstart, the things
  that will bite you, current limitations.
- [`packages/cli/README.md`](packages/cli/README.md) — the envelope, the exit
  codes, the execution policy, the write plane, the signer protocol, and what
  the CLI refuses to do.
- [`packages/e2e/README.md`](packages/e2e/README.md) — what a real end-to-end run
  would prove, and the named list of what an operator and an account owner must
  each supply before one can happen.
- [`docs/IMPLEMENTATION_BACKLOG.md`](docs/IMPLEMENTATION_BACKLOG.md) — the only
  implementation-status tracker.
- [`docs/adr/`](docs/adr) — binding architecture decisions.
- [`docs/AGENT_INSTALLATION_AND_RUNTIME_PLAN.md`](docs/AGENT_INSTALLATION_AND_RUNTIME_PLAN.md)
  — the planning narrative. Never evidence that something exists.
- [`AGENTS.md`](AGENTS.md) — working rules for coding agents in this repository.

## Safety

Never point this at mainnet funds, production tokens or production order
endpoints during development. The API allowance is a WaterX policy, not an
on-chain security boundary, and delegation is authorized outside this repository.
