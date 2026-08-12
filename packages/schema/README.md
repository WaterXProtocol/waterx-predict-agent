# @waterx/predict-agent-schema

The versioned command contract for the WaterX Predict agent runtime: what an
agent host may ask for, and the exact input each command accepts.

There are two contracts in this repository and they are not the same thing.

| | Source of truth | Lives in |
| --- | --- | --- |
| **Wire contract** | The backend | `packages/sdk/src/contract.ts`, vendored verbatim |
| **Command contract** | This package | `packages/schema/src`, emitted to `schemas/v1/` |

The wire contract says what an HTTP request looks like. The command contract
says what an *intent* looks like, and every surface — CLI, MCP, any other
function adapter — validates against it and then compiles to the same SDK call.
That is the property that stops two hosts from turning the same instruction into
two different orders.

## Why runtime validation

TypeScript types do not run. A CLI argument, a JSON file, an MCP tool call and a
model's function call all arrive as `unknown`, and by then the type system has
been erased. On a read path a bad input is a bad error message; on `order.execute`
it is a wrong trade. So the contract is enforced at runtime, by
`validateCommandInput`.

```ts
import { validateCommandInput } from '@waterx/predict-agent-schema';

const result = validateCommandInput('order.execute', input);
if (!result.ok) {
  // result.code is 'UNKNOWN_COMMAND' | 'INVALID_INPUT'
  // result.violations is machine-readable: { path, keyword, message }
  throw new Error(result.message);
}
```

Validation never coerces. `result.input` is the same object, not a copy with a
string parsed into a number or a default filled in — a surface that rewrote an
order size would be changing the intent it was asked to check.

## Why a hand-written validator

The contract has to be published as plain JSON Schema for adapters that are not
TypeScript, so JSON Schema is the source form either way. Deriving the validator
from that same object removes the second artifact that could drift from it, and
keeps the package dependency-free. See
[ADR-0006](../../docs/adr/0006-agent-command-schema-mechanism.md).

The subset is small and `assertSupportedSchema` throws on any keyword outside
it. That rule is the reason the approach is safe: a validator that quietly
skipped `multipleOf` or `not` would report a malformed order intent as valid.

## The published artifact

`schemas/v1/agent-commands.json` is generated from this package and committed, so
a change to a command input shows up as a reviewable diff. A test regenerates and
compares byte-for-byte, which is what makes the committed file evidence rather
than decoration.

```sh
pnpm --filter @waterx/predict-agent-schema run generate        # rewrite it
pnpm --filter @waterx/predict-agent-schema run generate:check  # fail if stale
```

## What the contract encodes

Rules mirror the backend's request validation (`agent-api/dto/`) rather than
inventing a second opinion. Where a definition is deliberately stricter than the
server it says so in place — for example a zero size is refused here, because an
ambiguous size must stop before a write rather than be rejected deeper in the
stack.

- **Money, prices and sizes are decimal strings.** A `number` is a type error, not
  a coercion. Six decimal places, matching `MONEY_DECIMALS`.
- **BUY states `buyAmount`; SELL states `sellShares`.** The units are not
  interchangeable and the mismatch is rejected by name, not guessed.
- **A SELL names the `positionId` it closes; a BUY must not name one.**
- **`maxSlippageBps` is mandatory** and `10000` is refused — it would remove all
  protection while still looking protected.
- **`enum` is closed and enforced; `x-waterx-open-set` is an annotation and is
  not.** A newer server may add a market category, and a client that rejected it
  would fail on data the server considers valid.

## Command set in v1

Only what the execution core can perform today. `describe`, `doctor`,
`order preview` and the `strategy` family are named in the plan but have no
implementation, and a schema entry is exactly what an adapter would advertise as
a callable tool. They are added when they exist; the document is versioned and
adding a command is not a breaking change.

| Command | CLI | SDK method | Class |
| --- | --- | --- | --- |
| `market.list` | `market list` | `getMarkets` | read |
| `market.get` | `market get` | `getMarket` | read |
| `market.quote` | `market quote` | `getQuote` | read (mints a quote) |
| `account.allowance` | `account allowance` | `getAllowance` | read |
| `account.positions` | `account positions` | `getPositions` | read |
| `account.executions` | `account executions` | `listExecutions` | read |
| `account.fills` | `account fills` | `getFills` | read |
| `order.get` | `order get` | `getExecution` | read |
| `order.execute` | `order execute` | `executeMarketOrder` | **write** |
| `order.execute-many` | `order execute-many` | `executeMany` | **write** |

## Development

```sh
pnpm --filter @waterx/predict-agent-schema run typecheck
pnpm --filter @waterx/predict-agent-schema run test
pnpm --filter @waterx/predict-agent-schema run build
```
