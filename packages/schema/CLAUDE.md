# packages/schema — `@waterx/predict-agent-schema`

The published command contract: the single source of truth for what an agent
may ask for (ADR-0001 §5, ADR-0006). Depends on nothing else in the workspace
and has no runtime dependencies; keep it that way (`tests/workspace.test.ts`
enforces both).

Two contracts exist and they are not the same thing: the **wire** contract
says what an HTTP request looks like and is owned by the backend (vendored in
`packages/sdk/src/contract.ts`); the **command** contract says what an intent
looks like and is owned here.

## Layout

- `src/json-schema.ts` — the enforceable JSON Schema subset and its validator.
- `src/defs.ts` — shared field rules, mirrored from the backend DTOs.
- `src/commands.ts` — the command registry: one entry per agent-issuable command.
  Each entry's description is what an adapter advertises to an LLM host, so it
  is prompt text: say when to use the command, when not to, and what `null`
  means in its result.
- `src/document.ts`, `src/generate.ts` — emit `schemas/v1/agent-commands.json`
  at the repo root and the copy in this package (`agent-commands.json`, the one
  `files` ships).
- `src/validate.ts` — `validateCommandInput`, the runtime gate every surface uses.

## Command-contract discipline

- Author command inputs as plain JSON Schema in `src/`, then regenerate with
  `pnpm schema:generate` from the workspace root. The committed artifact is
  compared byte-for-byte by a test, and CI diffs both copies.
- A keyword outside the validator's subset is a hard error. Widening the subset
  is a deliberate edit plus a test, never an accident in a schema definition.
- `enum` is closed and enforced; `x-waterx-open-set` is an annotation and must
  never be enforced.
- Validation never coerces. It returns the input unchanged or a list of
  violations.
- Do not add a command entry for a capability the execution core cannot perform.
  A schema entry is what an adapter turns into an advertised, callable tool.
