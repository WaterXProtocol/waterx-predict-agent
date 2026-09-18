# ADR-0017 — On mainnet, placing orders is something the operator turns on

- Status: Accepted
- Date: 2026-09-17 (the owner asked for the gaps against the perp agent to be closed, in order)
- Decides: the execution policy a CLI has when nobody configured one
- Amends: ADR-0011 (mainnet by default), `DEFAULT_POLICY` in `packages/cli/src/policy.ts`
- Affects: `packages/cli` (`config`, `policy`, `next`)

## Context

ADR-0011 made mainnet the default deployment, and the default policy was
`interactive`. Under the Agent API, an interactive write on mainnet was still
bounded by the owner's server-side mandate. Under direct mode (ADR-0013) it is
not, so an unconfigured runtime was one approval away from spending real
funds, with nothing but that approval in between.

The perp agent defaults to `read-only` on mainnet and to `interactive` on
testnet.

## Decision

- **No policy configured, on mainnet:** `read-only`. That covers the
  `--policy` flag, `WATERX_PREDICT_POLICY` and the config file, whether
  mainnet was named or used by default. The CLI reads, previews, quotes and
  diagnoses, and places nothing.
- **Testnet, or a host whose network nobody named:** the default stays
  `interactive`.
- **Stated where it matters.** The default carries `source: DEFAULT`, and every
  answer warns that mainnet writes are off and how to enable them
  (`WATERX_PREDICT_POLICY=interactive`, or `policy.mode` in the config file).
- **`next`.** It answers READY with that sentence and suggests no order
  preview, so an agent host asks the operator instead of the user.
- **Only the unconfigured case changes.** An operator who configured
  `interactive` or `delegated-auto` keeps it.

## Consequences

- **One more setup step.** The one-sentence setup needs one more operator step
  before a mainnet order: setting the policy. That is a person deciding that
  this machine may spend real funds, which is the point.
- **`doctor`'s `write-plane` check reports the refusal** as it does for any
  read-only policy.
- **Tests that exercise mainnet writes set the policy explicitly,** as an
  operator would.
