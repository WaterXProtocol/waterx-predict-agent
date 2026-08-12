# ADR-0003 — Risk-profile ownership and agent-readable limits

- Status: Accepted
- Date: 2026-08-12
- Plan ID: D-13
- Affects: `bucket-backend-mono`, `waterx-predict-agent-sdk`

## Context

Onboarding needs an owner for the agent risk profile. If the agent runtime could
create or raise its own limits, the risk profile would stop being a control: a
compromised agent credential would simply widen its own bounds. If instead the
agent cannot read the limits that bind it, every `preview` is a guess and a user
hits opaque rejections after installing successfully.

Verified backend state at the time of this ADR:

- `PUT agent-api/v1/predict/accounts/:accountId/agents/:agentWallet/risk-profile`
  and `GET agent-api/v1/predict/accounts/agents/risk-profiles` live on
  `PredictAgentOwnerController`, behind `WaterXAuthGuard` — owner-authenticated,
  not agent-authenticated.
- The agent-authenticated controller exposes no risk-profile read. An agent can
  read `allowance`, but not `maxOrderAmount`, `maxSlippageBps`, `maxOrdersPerHour`,
  `maxNotionalPerHour`, `maxInFlightExecutions`, `isSuspended`, or `policyVersion`.

## Decision

1. **Writes stay with the owner.** Creating or modifying a risk profile is an
   owner-authenticated UI/API operation. The agent runtime never writes one, and
   an agent credential can never raise a limit that binds it. Existing behavior
   already satisfies this and must not regress.
2. **The agent gets a read.** The backend will add an agent-authenticated,
   read-only *effective limits* endpoint scoped to the calling agent wallet and
   the requested account. It returns the same effective values the enforcement
   path uses, plus `policyVersion` and `isSuspended`.
3. **Scope.** The read returns only the profile binding the authenticated agent
   wallet. It is not a listing endpoint and must not expose other agents' profiles
   or owner-level configuration.
4. **The read is advisory, not authoritative.** It exists so `preview` and
   `describe` can be honest. Enforcement stays server-side on every write, and a
   client must never treat a cached read as permission. `policyVersion` lets a
   result be traced to the policy in force.
5. **Absence is a first-class state.** When no profile exists, the runtime reports
   a distinct, actionable "not onboarded" condition naming the owner action
   required. It must not be rendered as unlimited, as zero, or as a generic
   authorization error.
6. **Until that endpoint exists**, `describe` and `preview` report effective
   limits as unavailable. Neither may infer limits from `allowance` alone or from
   the outcome of previous rejections.

## Consequences

- Onboarding is explicitly a two-actor flow: the owner provisions delegation and
  the risk profile; the agent installs and operates within it. Documentation
  presents it that way rather than as a single install step.
- This is a backend change with a wire-contract change, so it follows the
  contract discipline: backend behavior and tests first, then vendor the complete
  contract body into the SDK and review the full semantic diff.
- Reporting "not onboarded" distinctly is what prevents the most likely bad
  first-run experience — an agent that installs cleanly and then has every order
  rejected for reasons it cannot see.
- The read must not become a write path later by adding parameters. Widening a
  limit stays an owner operation.
