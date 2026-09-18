# ADR-0011 — The CLI uses mainnet when no deployment is named

- Status: Accepted
- Amended by: [ADR-0017](0017-mainnet-writes-are-opt-in.md) — with no policy configured, mainnet is read-only
- Date: 2026-09-16
- Decides: what `waterx-predict` connects to when neither
  `WATERX_PREDICT_ENVIRONMENT` nor `WATERX_PREDICT_BASE_URL` (nor their config
  file keys) is set
- Reverses: the CLI half of "there is no default deployment" in
  `packages/sdk/src/provisioning.ts`. The library half is unchanged.
- Affects: `packages/cli`, `packages/e2e`, the operator bundle (ADR-0010)

## Context

The one-sentence setup (ADR-0010) is meant to take an agent from install to its
first real step with as few questions as possible. Until now the first question
`runtime.next` put to the operator was *which network*, and the answer the
product is actually used with is mainnet. Asking it every time bought a pause
before real money, at the price of a question whose answer was always the same.

## Decision

1. **Nothing named → `production`**, the SDK's name for mainnet
   (`https://api.waterx.app`). `loadConfig` (`packages/cli/src/config.ts`) records this as
   `deploymentSource: 'DEFAULT'`.
2. **`mainnet` is accepted as a name for `production`.**
3. **A name this build does not know is not defaulted.** `staging` is somebody
   naming a network that is not production; it stays unconfigured
   (`deploymentSource: 'NONE'`) rather than being sent to mainnet.
4. **The default is never silent.** Every envelope carries a
   `meta.warnings` entry saying no deployment was named and orders spend real
   funds; `describe` reports `api.deploymentSource`; `doctor`'s `config` check
   and the `deployment` requirement say it; `next` reports
   `facts.deployment` with `source` and `realFunds`, and its operator hand-over
   says it.
5. **The library does not change.** `new PredictAgentClient()` still requires a
   `deployment` or a `baseUrl`. A program choosing a network in code chooses it
   explicitly.
6. **The E2E harness does not treat the default as provisioned.** It is
   non-production only; a base URL nobody supplied is still a missing one there,
   so its read steps never reach mainnet by omission. Its write gate is
   unchanged: an unlabelled deployment is production and is never traded on.

## What still stands between an unconfigured install and a trade

The default removes a question, not a control. An order still needs an agent
wallet and a signer (the operator's), a listed account, an on-chain delegation
and a risk profile (the owner's, ADR-0003), and — under the default
`interactive` policy — a person approving that exact previewed intent. `next`
still suggests only reads.

## What this forbids

- Defaulting an unknown deployment name to production.
- Removing or muting the default warning from any envelope.
- Defaulting the SDK client's deployment.
- Any development or verification step that relies on the default to reach a
  server. Tests stub the transport; the bundle check runs with no signer, so
  nothing is sent. `AGENTS.md`'s rule against production endpoints in
  development is unchanged — use `WATERX_PREDICT_ENVIRONMENT=testnet`.

## Consequences

- **An operator who forgets the setting trades on mainnet.** That is the cost
  accepted here, bounded by the controls above and made visible on every
  answer.
- **Practising needs one setting:** `WATERX_PREDICT_ENVIRONMENT=testnet`.
- **`onboard` works with nothing set.** Production has a paired console
  (`https://waterx.app`), so the owner's authorization link is available
  without `WATERX_PREDICT_CONSOLE_URL`.
- **A host must relay the warning.** `NEXT_IS_A_ROUTE_NOT_A_MANDATE` tells it to
  say so before the first preview when `facts.deployment.source` is `DEFAULT`.
