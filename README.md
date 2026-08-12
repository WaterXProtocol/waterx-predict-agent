# WaterX Predict agent runtime

A pnpm workspace for operating the WaterX Predict Agent Trading API from an
autonomous agent: quotes, price-protected market orders, positions and allowance.

**Today, the usable surfaces are the SDK and a read-only CLI.** Everything else
here is either the contract those surfaces are described by, or a reserved
boundary with no implementation behind it. `docs/IMPLEMENTATION_BACKLOG.md` is
the only file that tracks what actually works.

## Packages

| Package | What it is | State |
| --- | --- | --- |
| [`packages/sdk`](packages/sdk) | `@waterx/predict-agent-sdk` — the execution core. Authentication, quotes, protected market orders, reads. | Implemented |
| [`packages/schema`](packages/schema) | `@waterx/predict-agent-schema` — the versioned, runtime-validated command contract. | Implemented |
| [`packages/cli`](packages/cli) | The `waterx-predict` CLI: the universal agent surface. Discovery, doctor, market and account reads, in one JSON envelope with stable exit codes. | Implemented, **read-only** and unpublished |
| [`packages/runner`](packages/runner) | The self-hosted local Runner: durable jobs, approval policy, signer boundary. | Reserved, **not implemented** |
| [`packages/mcp`](packages/mcp) | Optional MCP adapter. | Reserved, **not implemented** |

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
```

Node.js 20+ and ESM. macOS and Linux; Windows is not verified (ADR-0002).

## Documentation

- [`packages/sdk/README.md`](packages/sdk/README.md) — quickstart, the things
  that will bite you, current limitations.
- [`packages/cli/README.md`](packages/cli/README.md) — the envelope, the exit
  codes, the signer protocol, and what the CLI refuses to do.
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
