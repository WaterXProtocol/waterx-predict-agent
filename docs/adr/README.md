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
| [0009](0009-release-and-update-policy.md) | What is published, how it is updated, and what it reports home | Accepted | D-26…D-30 |
| [0010](0010-operator-cli-bundle.md) | The CLI ships as one self-contained release tarball | Accepted | amends D-28 |
| [0011](0011-cli-defaults-to-mainnet.md) | The CLI uses mainnet when no deployment is named | Accepted | — |
| [0012](0012-operator-keystore-signer.md) | The keystore signer ships beside the CLI | Accepted | amends D-28, ADR-0010 |
| [0013](0013-direct-mode.md) | Direct mode: the CLI trades the way the perp agent does | Accepted | amends ADR-0001 §1–4 for the CLI |
| [0014](0014-durable-write-controls.md) | Write controls that outlive one invocation, and settlement from the chain | Accepted | amends ADR-0001 §6.6, ADR-0013 |
| [0015](0015-direct-mode-verification-and-discovery.md) | Direct mode: pinned contract shapes, chain-side discovery, adoption, write probe | Accepted | amends ADR-0013 |
| [0016](0016-runner-direct-mode.md) | The Runner trades in direct mode too | Accepted | amends ADR-0013, ADR-0001 §8 |
| [0017](0017-mainnet-writes-are-opt-in.md) | On mainnet, placing orders is something the operator turns on | Accepted | amends ADR-0011 |
| [0018](0018-approval-audit.md) | An approval names who gave it, and every write decision is kept | Accepted | amends ADR-0014, ADR-0015 |
| [0019](0019-git-install.md) | The repository installs with npm, as one sentence | Accepted | amends ADR-0010, ADR-0012 |
| [0020](0020-unattended-setup.md) | What an agent host may set up for itself | Accepted | amends ADR-0012, ADR-0019 |
| [0021](0021-a-path-that-ends-somewhere.md) | An install that can fail legibly, and a policy somebody can choose | Accepted | amends ADR-0017, ADR-0019, ADR-0020 |
| [0022](0022-every-answer-points-somewhere.md) | Every answer points somewhere, and says whose step it is | Accepted | amends ADR-0020 |
| [0023](0023-say-what-the-account-is-carrying.md) | Say what the account is carrying | Accepted | amends ADR-0022 |
| [0024](0024-handing-the-link-over.md) | Handing the link over | Accepted | amends ADR-0022 |
| [0025](0025-the-choice-after-the-signature.md) | The operator's choice comes right after the owner's signature | Accepted | amends ADR-0021, ADR-0022 |
| [0026](0026-the-chooser-is-a-screen.md) | The chooser is a screen, not only a document | Accepted | amends ADR-0021, ADR-0025 |
| [0027](0027-the-choice-shows-itself.md) | The choice shows itself, and is never answered for anybody | Accepted | amends ADR-0025, ADR-0026 |
| [0028](0028-mainnet-is-not-a-question.md) | Mainnet is not a question, and the pointer survives the cut | Accepted | amends ADR-0011, ADR-0022 |

## Status vocabulary

- **Proposed** — written and reviewable, not yet binding. What it would
  authorize stays forbidden until it is Accepted; where a check reads the
  status (ADR-0010 does), the check refuses.
- **Accepted** — binding on implementation now.
- **Superseded** — replaced by a later ADR, which must be named.
- **Deferred** — deliberately not decided; the ADR states what unblocks it.

Decisions D-23 and D-25 in the plan remain deliberately undecided and are tracked
in `docs/IMPLEMENTATION_BACKLOG.md` rather than as ADRs, because neither gates
Phase 0 or Phase 1 work. D-24 was answered structurally by the backend
performance read (backlog B8). D-26…D-30 became unavoidable at the first publish
and are decided in ADR-0009.

## Writing an ADR here

Keep it short and decision-shaped: context, the decision, what it forbids, and
the consequences a future implementer will actually trip over. Do not restate the
plan. Do not describe a capability as existing — an ADR constrains what will be
built; `docs/IMPLEMENTATION_BACKLOG.md` is the only file that tracks what is
actually implemented.
