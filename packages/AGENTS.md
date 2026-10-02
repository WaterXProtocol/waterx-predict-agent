# packages/ — rules for every package's code

Every package in the workspace reads this file (Claude Code loads it when a file under `packages/`
is read; Codex concatenates it for any working directory under `packages/`). The root `AGENTS.md`
carries the scope, safety and verification policy; each package's own `AGENTS.md` carries its
layout. This file holds the two sets of rules that apply to the code of every package: the trading
invariants (the SDK implements them, and the CLI, Runner and adapters must not route around them)
and the runtime and dependency rules.

## Trading invariants

Mistakes here can place duplicate or mispriced orders. Preserve each with an explicit test.

- **Quotes.** Catalog bid/ask/probability fields are indicative; only a quote minted through the
  quote endpoint is executable. WaterX prices orders from its own quote pipeline: do not expose raw
  upstream orderbooks or derive a competing price in the SDK. A quote is short-lived — never cache
  it or extend its expiry. Top-of-book quotes are size-blind: never fabricate depth,
  `availableSize`, expected fill size, or fee facts the server cannot observe.
- **Price protection.** The backend re-quotes at execution time, so `maxSlippageBps` is mandatory
  on every order intent and a supplied `worstAcceptablePrice` is preserved. The on-chain
  `enforcedWorstPrice` may be stricter after safe granularity rounding, never looser than the
  caller's protection. Quote-to-fill deviation is a product-critical signal: keep the quote IDs,
  prices, timestamps and actual fill facts that measure it, unrounded and never replaced by
  indicative catalog data (the monitoring itself belongs to the backend/observability stack).
- **Execution lifecycle.** Create, sign and submit are distinct facts even when one SDK method
  orchestrates them. `SUBMITTED` and `PENDING_FILL` are not fills; only a terminal read may report
  authoritative fill and remaining-allowance facts. Keep the agent's submission transaction distinct
  from the keeper's fill transaction. A terminal-wait timeout means the SDK stopped waiting, not
  that the order failed or was cancelled — callers must be able to reconcile by execution ID. A
  SELL names the position it closes and must not silently sell more shares than requested or held.
- **Idempotency and retry.** One idempotency key per logical order intent, reused for every retry
  of it; a caller-supplied key survives the whole flow and never leaks into the JSON body when the
  wire contract wants it as a header. Retry only when replaying the exact bytes is safe: a create
  under its stable key, a submit because the server defines repeated submission as idempotent. Use
  the server's `retryable` field rather than a client-side table, and never turn proxy HTML, a
  malformed body or an unknown failure into a fabricated symbolic API error. Retries and long waits
  are bounded, abortable and backoff-aware; `RATE_LIMITED` never hides in an unbounded loop.
- **Synthetic limits and multiple orders.** A BUY target is a ceiling, a SELL target a floor. A
  watched price is only a trigger: after it fires, fetch a fresh executable quote and re-check the
  target before submitting. Mint the idempotency key before the wait loop and submit at most one
  logical execution; expiry before submission places nothing. `executeMany` is client-side
  orchestration, not a batch or atomic order — each leg has its own quote, execution, key and
  result, and partial success is expected. A STOP policy may keep unstarted legs from launching but
  cannot cancel or roll back submitted or filled work; report failed, successful and skipped legs
  distinctly.
- **Authentication, delegation, allowance.** Auth challenges use Sui personal-message signing and
  sponsored bytes use transaction signing; they are not interchangeable. The authenticated agent
  wallet must sign the sponsored bytes — WaterX may sponsor gas but never signs for the agent. Never
  cache a local claim that delegation is valid: the backend/on-chain checks are authoritative and
  revocation must be able to reject the next write. API allowance is a WaterX policy, not an
  on-chain security boundary; keep it distinct from spendable balance and protocol delegation.

## Runtime, dependencies, and working rules

- Target Node.js 20+ and ESM (the Runner alone needs 24, ADR-0007). Browser, Deno, and Bun
  compatibility are not promised unless a task explicitly adds and verifies them. Prefer platform
  capabilities (`fetch`, `AbortSignal`, Web Crypto, `node:crypto`) where they fit.
- A runtime dependency is allowed when it makes a core feature complete and reliable. Justify its
  purpose, maintenance/security posture, package cost, and Node.js compatibility, and edit the
  allowlist in `tests/workspace.test.ts`, which is where that argument gets written down.
- Add or update tests with the behavior they cover; test observable guarantees, not private
  implementation trivia. Keep comments for non-obvious financial, retry, signing, stream, and
  lifecycle reasoning.
- Keep `README.md` truthful: a developer following its quickstart should see the real API, required
  safeguards, and current limitations.
- Export every intended public value through the owning package's `src/index.ts` and check it is in
  the built `dist`.
- When a change alters what an agent may ask for, update `packages/schema` and regenerate `schemas/`
  in the same change.
