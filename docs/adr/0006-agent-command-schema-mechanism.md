# ADR-0006 — How the agent command schema is authored and enforced

- Status: Accepted
- Date: 2026-08-12
- Plan IDs: implements ADR-0001 §5; plan §8
- Affects: `waterx-predict-agent-sdk`

## Context

ADR-0001 §5 settles *that* one runtime command schema is the source of truth for
CLI validation, JSON Schema emission and every adapter. It does not settle *how*,
and the obvious implementations quietly produce two sources of truth.

Three facts constrain the choice:

1. The contract must be published as plain JSON Schema. An adapter written in
   Python, or a model host that ingests tool definitions as JSON, cannot import a
   TypeScript module. So a JSON artifact exists no matter what.
2. Validation must happen at runtime. A CLI argument, a `--file` payload, an MCP
   tool call and a model's function call all arrive as `unknown`; TypeScript has
   been erased by then. On `order.execute` the cost of a missed check is a wrong
   trade, not a confusing error.
3. The SDK ships with zero runtime dependencies, and the plan's dependency policy
   treats a new one as a decision rather than a convenience. *(The SDK has since
   taken exactly one, `socket.io-client`, argued for in `execution-stream.ts`;
   `@waterx/predict-agent-schema` still has none, which is what this decision is
   about.)*

The default answer — define schemas in a validation library such as zod, then
generate JSON Schema from them — satisfies (2) and (3) badly and (1) partially:
the emitted JSON is a lossy projection of the library's model, so the artifact an
adapter reads and the validator the CLI runs are two different things that agree
only as long as the generator does.

## Decision

1. **JSON Schema is the source form.** Command inputs are authored as plain JSON
   Schema (draft 2020-12) objects in `packages/schema/src`. The published
   `schemas/v1/agent-commands.json` is a serialization of those same objects, not
   a translation of them.
2. **The validator is hand-written against a deliberately small subset**
   (`json-schema.ts`), so the artifact and the enforcement cannot drift: they are
   the same object. This keeps `@waterx/predict-agent-schema` dependency-free.
3. **An unsupported keyword is a hard error, never a skipped one.**
   `assertSupportedSchema` throws on any keyword outside the subset, and runs at
   document build time as well as in tests. This rule is what makes the small
   subset safe rather than merely small — a validator that silently ignored
   `multipleOf` or `not` would report a malformed order intent as valid.
4. **Growing the subset is a deliberate edit** to the keyword list plus a test.
   It cannot happen by accident in a schema definition.
5. **The generated artifact is committed** and a test regenerates and compares it
   byte-for-byte. A command-input change is therefore reviewable as a diff, and a
   stale artifact fails the suite rather than shipping.
6. **`enum` is closed and enforced; `x-waterx-open-set` is an annotation and is
   never enforced.** Plan §8 requires the distinction to be explicit. A client
   that rejected an unlisted market category would fail on data the server
   considers valid; a client that accepted an unlisted `side` would send a request
   the server rejects — and the two failure modes must not be expressed the same
   way.
7. **Validation never coerces.** It returns the same value or a list of
   violations. It does not parse a string into a number, fill a default, or
   normalize a size. A surface that rewrote an order size would be changing the
   intent it was asked to check.
8. **The package depends on nothing else in the workspace.** Not the SDK: the
   contract must be readable by a surface that cannot import a Node client.

## What this forbids

- Adding a schema library to `@waterx/predict-agent-schema` or generating the JSON
  artifact from a second model of the same data.
- Using a JSON Schema keyword the validator does not implement, on the assumption
  that "the published schema documents it even if we do not check it". The
  published schema is a contract, and an unenforced clause in it is a lie an
  adapter will act on.
- Hand-editing `schemas/v1/agent-commands.json`.
- Adding a command entry for a capability the execution core cannot perform. A
  schema entry is precisely what an adapter turns into an advertised, callable
  tool, so listing `doctor` or `order preview` before they exist would present
  planned capability as implemented.

## Consequences

- The subset is small on purpose and will need to grow: `not`, `multipleOf`,
  `dependentRequired`, `patternProperties` and tuple `items` are all absent.
  Growth is cheap (a keyword, a branch, a test); the alternative — a permissive
  validator — is not.
- Cross-field rules (BUY⇒`buyAmount`, SELL⇒`sellShares`, SELL⇒`positionId`) are
  expressed as `oneOf` over titled variants, applied with `allOf`. This is more
  verbose than a library's `.refine()`, and it buys an error message that names
  the variant that failed — which is what an agent needs to correct an intent
  rather than retry it blindly.
- "Must be absent" is expressed as `type: 'null'` in the variant that forbids the
  field, because an absent property is not validated. The field's own definition
  then rejects an explicitly-sent `null`. Both halves are required; either alone
  lets a BUY carry a `positionId`.
- Because the published document is versioned, adding a command is not a breaking
  change and does not need this ADR revisited. Changing an existing command's
  input does.
- Rules mirror the backend's request validation (`agent-api/dto/`) rather than
  inventing a second opinion. Where the schema is deliberately stricter than the
  server — a zero size is refused here — it says so in place. A local surface may
  refuse an intent the server would accept; it must never accept one the server
  would reject, and must never imply a permission the server does not grant.
