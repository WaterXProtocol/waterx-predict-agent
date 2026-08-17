# Architecture Decision Records

An ADR here records a decision that constrains the WaterX Predict agent runtime
across repositories. Changing one of these is not a refactor: it needs a new ADR
that states the compatibility, security, and operational impact, and it must not
be done implicitly inside a feature or adapter implementation.

`docs/AGENT_INSTALLATION_AND_RUNTIME_PLAN.md` is the planning narrative. These
ADRs are the binding decisions extracted from it. When the two disagree, the ADR
wins and the plan should be corrected.

| ADR | Title | Status | Plan IDs |
| --- | --- | --- | --- |
| [0001](0001-agent-runtime-baseline.md) | Agent runtime architecture baseline | Accepted | D-01…D-04, D-06…D-12, D-14…D-17, D-19…D-21 |
| [0002](0002-supported-platforms.md) | Supported platforms and runtime | Accepted | D-05 |
| [0003](0003-risk-profile-ownership.md) | Risk-profile ownership and agent-readable limits | Accepted | D-13 |
| [0004](0004-market-lifecycle-and-job-pausing.md) | Market lifecycle effects on a durable job | Accepted | D-18 |
| [0005](0005-strategy-expiry.md) | Mandatory strategy expiry | Accepted | D-22 |
| [0006](0006-agent-command-schema-mechanism.md) | How the agent command schema is authored and enforced | Accepted | ADR-0001 §5 |
| [0007](0007-runner-job-store-engine.md) | The Runner's job store engine, and the Node floor it costs | Accepted | ADR-0001 §8, ADR-0002 |
| [0008](0008-runner-local-ipc.md) | How a local client authenticates to the Runner | Accepted | ADR-0001 §4, §6, ADR-0002 |

## Status vocabulary

- **Accepted** — binding on implementation now.
- **Superseded** — replaced by a later ADR, which must be named.
- **Deferred** — deliberately not decided; the ADR states what unblocks it.

Decisions D-23…D-30 in the plan remain deliberately undecided and are tracked in
`docs/IMPLEMENTATION_BACKLOG.md` rather than as ADRs, because none of them gates
Phase 0 or Phase 1 work.

## Writing an ADR here

Keep it short and decision-shaped: context, the decision, what it forbids, and
the consequences a future implementer will actually trip over. Do not restate the
plan. Do not describe a capability as existing — an ADR constrains what will be
built; `docs/IMPLEMENTATION_BACKLOG.md` is the only file that tracks what is
actually implemented.
