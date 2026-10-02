# packages/adapters — `@waterx/predict-agent-adapters`

The host-neutral instructions, the tool projection of the command contract
(OpenAI / Anthropic / MCP shapes from one registry) and the dispatcher that
validates and delegates. Delegation is a **subprocess** against the installed
`waterx-predict` binary, never a library call. No OpenAPI document is emitted —
this repository serves no HTTP surface. `private`. Its own `tsconfig.json`
deliberately resolves the schema and **not** the CLI, so there is no symbol in
scope to reimplement the core with.

Adapters are thin translations over the command contract — never a second
command surface. They must not reimplement pricing, retry, signing, policy or
job state.

## Layout

- `src/instructions.ts` — the host-neutral rules, as data. Each is a symbolic id
  (`SIZE_AMBIGUITY_STOPS_BEFORE_A_WRITE`) so a review or a refusal can cite one
  and a deleted rule fails a test rather than shortening a document.
- `src/skill.ts` — the skill-shaped rendering of the same rules.
- `src/tools.ts` — the projection. One registry, renamed per host; each tool
  carries the transitive `$defs` closure it reaches and no more.
- `src/core.ts` — the subprocess seam and the operator-flag allowlist.
  `--approve` is refused: the token digests one exact intent, so a pinned one is
  either useless or a pre-authorised order.
- `src/dispatch.ts` — validate, delegate, relay. It never retries, never
  coerces, and `isFullySettled` is false for a partially filled batch.

## Generated prompt surface

`pnpm instructions:generate` (workspace root) renders `src/instructions.ts` and
`src/skill.ts` into `agent-instructions/` at the repo root and into
`packages/sdk/SKILL.md` and `packages/sdk/AGENT_INSTRUCTIONS.md`. Those are what the MCP adapter returns at `initialize`,
what a host that cannot run this toolchain reads instead, and what a skill host
loads. Never hand-edit a generated copy; CI diffs every copy against the
generator, so a hand edit would give two hosts different rules. The text is
prompt copy read by an LLM operating a real account: each rule carries its
reason, and the step sequence in the skill is a money path where each step
exists because the next is unsafe without it — keep that shape.
