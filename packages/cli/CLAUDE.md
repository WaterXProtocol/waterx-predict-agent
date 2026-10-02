# packages/cli — `@waterx/predict-agent-cli`

The `waterx-predict` binary. Reads **and writes** behind an enforced execution
policy; `runtime.next` is the read-only loop an agent host obeys. `private`, so
it is never published to a registry; the operator bundle (ADR-0010, Accepted;
nothing released yet) is the only way it leaves the workspace. `next` probes
the keystore signer through `src/keystore-probe.ts` — PATH, the public address
in `keystore.json`, the socket's existence — and never imports or dials it.

The CLI connects to mainnet when no deployment is named (ADR-0011). A local run
against a real server must set `WATERX_PREDICT_ENVIRONMENT=testnet` explicitly;
tests stub the transport and must keep doing so.

## Layout

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
- `src/ledgers.ts` — the approval, spend and adoption ledgers (ADR-0014/0015):
  one `0600` file, every update under an exclusive lock. An approval is issued
  by a preview and spent before signing; a `delegated-auto` BUY reserves budget
  there. Never reset a ledger this build cannot read — refuse.
- `src/client.ts` — `TradingClient` is `PredictAgentClient | PredictDirectClient`
  by `mode` (default `direct`, ADR-0013). A command that needs the Agent API's
  account plane branches on `isDirectClient` and says what direct mode has
  instead; it never fakes an empty answer.
- `src/commands/` — one thin handler per command. Server responses pass through
  unchanged, with caveats attached alongside rather than merged in.
- `tests/harness.ts` — every test invokes the CLI end to end through it; none
  opens a socket, spawns a process or reads a real file.

Signers are reached as **processes** (`packages/signer-browser`,
`packages/signer-keystore`), never imported: both carry `@mysten/sui`, which is
the dependency this package's budget exists to keep out.
