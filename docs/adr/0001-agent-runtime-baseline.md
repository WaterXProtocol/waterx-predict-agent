# ADR-0001 — Agent runtime architecture baseline

- Status: Accepted
- Date: 2026-08-12
- Plan IDs: D-01, D-02, D-03, D-04, D-06, D-07, D-08, D-09, D-10, D-11, D-12,
  D-14, D-15, D-16, D-17, D-19, D-20, D-21
- Affects: `waterx-predict-agent-sdk`, `bucket-backend-mono`

## Context

The Predict agent API already supports a price-protected market order end to end,
but the only supported way to use it is to embed the TypeScript SDK in a Node.js
process the developer writes. The goal is for an arbitrary agent host to install
the runtime and operate it safely. `docs/AGENT_INSTALLATION_AND_RUNTIME_PLAN.md`
settled the architecture; this ADR makes those settlements binding so they are
not reopened inside a feature branch or an adapter.

## Decision

### Surface and topology

1. REST/WS plus the TypeScript SDK are the execution core. Every other surface
   compiles down to the same SDK calls.
2. The CLI plus a versioned runtime JSON Schema are the canonical universal-agent
   interface. MCP and other function-calling integrations are thin adapters that
   perform schema mapping only.
3. An adapter must not implement its own quoting, retry, signing, policy, or job
   state. Two hosts issuing the same intent must produce the same normalized
   request and the same safety semantics.
4. The repository moves to multiple packages so daemon, storage, CLI parsing, and
   adapter dependencies never enter the published SDK library.
5. One runtime command schema is the source of truth for CLI validation, JSON
   Schema emission, and every adapter. TypeScript compile-time types are not
   runtime validation.

### Runner and custody

6. The first Runner is self-hosted and local. There is no managed-runner promise.
   The agent device and the Runner must stay awake, online, and running; while
   they are not, no client-side strategy is monitored, and the product surface
   must say so rather than implying continuous coverage.
7. The signer lives inside the Runner trust boundary behind a provider interface.
   Models and ordinary agent subprocesses never receive a raw private key, and no
   raw key appears in model context, CLI arguments, stdout, logs, or the job store.
8. Durable local jobs use SQLite/WAL behind a store interface. Overwriting a JSON
   file is not sufficient for funds-moving state.
9. Approval defaults to `interactive`. `delegated-auto` requires both an explicit
   scoped local policy and a backend owner risk profile. `read-only` must be
   enforceable and must block all signing and writes. Local policy may only ever
   be stricter than backend effective limits, never more permissive.

### Trading semantics

10. Market identity is resolved by the server. An agent never fabricates a market
    ID, and an ambiguous market, outcome, account, or size unit stops before any
    write.
11. BUY accepts `buyAmount`; SELL accepts `sellShares`. The two are not
    interchangeable and ambiguity is not resolved by guessing.
12. A BUY target price is an executable ask ceiling. A SELL target price is an
    executable bid floor.
13. A percentage SELL freezes the share count when the job is created. A dynamic
    fraction evaluated at trigger time is a distinct, explicitly selected schema
    mode, never the default.
14. A watched price is only a trigger. After it is observed, the Runner fetches a
    fresh executable quote, re-verifies the target against it, and re-reads
    delegation, risk, and position state. Authorization cached at job creation is
    never reused for the write decision.
15. Actions may be chained and multiple orders may be placed, but every order is
    independent. There is no atomic batch and no rollback. A STOP policy prevents
    unstarted legs from launching; it cannot cancel or reverse a leg already
    created, submitted, or filled. Results report succeeded, failed, and skipped
    distinctly.
16. `SUBMITTED` and `PENDING_FILL` are not fills. Only a terminal read reports
    authoritative fill facts, and partial fill or keeper cancellation is reported
    from backend terminal facts.
17. Terminal SDK and CLI results expose the authoritative fill, whether fee facts
    are available, and the remaining allowance. A non-terminal timeout preserves
    the execution ID for reconciliation and is never reported as a failure.

### Streams, auth, and idempotency

18. The quote stream contract is snapshot plus monotonic sequence plus explicit
    gap signalling, with REST/snapshot recovery. A latency SLO is defined before
    anything is described as real-time, and polling is never labelled as
    WebSocket support.
19. Token expiry may trigger automatic re-authentication when a signer is
    available, but a logical write retains its idempotency key and replays the
    exact same bytes.

## Consequences

- A "just add MCP" shortcut is out of scope: MCP cannot be the only entry point,
  and it cannot carry trading semantics of its own.
- Because the Runner is local and self-hosted, runner health and last heartbeat
  are product-visible state, not diagnostics. A user must be able to tell that a
  strategy is unmonitored.
- Reopening the managed-runner question (D-03) requires a new ADR and a separate
  project: it introduces server-side strategy state, custody and signing,
  availability, notification, and compliance obligations.
- Freezing shares at job creation means a position that grows after creation is
  not swept by an existing "sell half" job. This is intentional and must be
  visible in `preview`.

## Not implied by this ADR

None of the above is a claim that the capability exists. As of this ADR the CLI,
the Runner, the durable job store, the runtime command schema, the native quote
stream, and every adapter are unimplemented. `docs/IMPLEMENTATION_BACKLOG.md`
tracks actual state with evidence.
