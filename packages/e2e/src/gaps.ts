/**
 * The seven things that must exist before a real end-to-end run is possible,
 * each with a named supplier.
 *
 * This list is the deliverable when the E2E cannot run, and it is not prose: a
 * gap has a machine-checkable settlement (the command and field that decide it)
 * and a `suppliedBy` that says who has to act. Two of them are
 * OWNER-AUTHENTICATED — a delegation and a risk profile are created through an
 * owner session (ADR-0003), and no agent runtime, and no automation acting as
 * the agent, can provision them. Listing them as "missing config" would invite
 * exactly the self-widening the ADR exists to prevent, so they carry
 * `ownerAuthenticated: true` and the harness never attempts them.
 *
 * A gap this harness could not evaluate is UNCHECKED, never MISSING. Saying a
 * delegation is missing when no base URL was configured is a claim about a
 * server nobody talked to.
 */

export const GAP_IDS = [
  'baseUrl',
  'environment',
  'agentWallet',
  'signerCommand',
  'defaultAccount',
  'delegation',
  'ownerRiskProfile',
] as const;

export type GapId = (typeof GAP_IDS)[number];

/**
 * Who supplies the value.
 *
 * `OPERATOR` is whoever installs and runs this runtime. `ACCOUNT_OWNER` is the
 * holder of the WaterX account session; the distinction is the whole of
 * ADR-0003's two-actor onboarding, and collapsing it is how an agent ends up
 * able to raise the limits that bind it.
 */
export type Supplier = 'OPERATOR' | 'ACCOUNT_OWNER';

export interface ProvisioningGap {
  readonly id: GapId;
  readonly title: string;
  readonly suppliedBy: Supplier;
  /**
   * True when supplying it requires an owner-authenticated session. This
   * pipeline must not attempt one, and an automated onboarding that did would be
   * defeating the control rather than implementing it.
   */
  readonly ownerAuthenticated: boolean;
  /** Why the E2E cannot proceed without it. */
  readonly why: string;
  /** The concrete ways to supply it, most specific first. */
  readonly supplyWith: readonly string[];
  /** The command whose output settles this gap, and the field that does it. */
  readonly settledBy: string;
  /** Gaps that must be satisfied before this one can even be evaluated. */
  readonly needs: readonly GapId[];
}

export const PROVISIONING_GAPS: readonly ProvisioningGap[] = [
  {
    id: 'baseUrl',
    title: 'Agent API base URL',
    suppliedBy: 'OPERATOR',
    ownerAuthenticated: false,
    why: 'Every command past `describe` is a request. With no base URL there is no server, and nothing after discovery can run.',
    supplyWith: [
      'WATERX_PREDICT_BASE_URL=<https://…> (environment)',
      '"baseUrl" in ~/.config/waterx-predict/config.json',
    ],
    settledBy: 'describe → api.configured / api.baseUrl',
    needs: [],
  },
  {
    id: 'environment',
    title: 'Environment label',
    suppliedBy: 'OPERATOR',
    ownerAuthenticated: false,
    why: 'The label is not decoration here: this harness refuses to place an order unless it reads a known non-production one. An unlabelled deployment is treated as production and is never written to.',
    supplyWith: [
      'WATERX_PREDICT_ENVIRONMENT=testnet (environment)',
      '"environment" in ~/.config/waterx-predict/config.json',
    ],
    settledBy: 'describe → api.environment',
    needs: [],
  },
  {
    id: 'agentWallet',
    title: 'Agent wallet address',
    suppliedBy: 'OPERATOR',
    ownerAuthenticated: false,
    why: 'The address the agent authenticates as and the delegation is granted to. The private key behind it never appears here — only the address.',
    supplyWith: [
      'WATERX_PREDICT_AGENT_WALLET=0x… (environment)',
      '"agentWallet" in ~/.config/waterx-predict/config.json',
    ],
    settledBy: 'describe → identity.agentWallet',
    needs: [],
  },
  {
    id: 'signerCommand',
    title: 'External signer command',
    suppliedBy: 'OPERATOR',
    ownerAuthenticated: false,
    why: 'Authentication signs a challenge and a write signs sponsored bytes. Both happen in a separate process that holds the key; this runtime never receives one.',
    supplyWith: [
      'WATERX_PREDICT_SIGNER_COMMAND=<argv> (environment)',
      '"signerCommand" in ~/.config/waterx-predict/config.json',
      'The command must read a signing request on stdin and answer with `{"signature": "…"}` on stdout. It is the only component that touches a key.',
    ],
    settledBy: 'describe → signer.configured',
    needs: [],
  },
  {
    id: 'defaultAccount',
    title: 'Predict account id',
    suppliedBy: 'ACCOUNT_OWNER',
    ownerAuthenticated: false,
    why: 'Positions, fills, previews and orders are all account-scoped. The id belongs to the owner and is handed to the operator; the agent cannot discover it.',
    supplyWith: [
      'WATERX_PREDICT_ACCOUNT_ID=0x… (environment)',
      '"defaultAccountId" in ~/.config/waterx-predict/config.json',
      'The owner reads it from the WaterX account UI and gives it to the operator.',
    ],
    settledBy: 'describe → identity.defaultAccountId',
    needs: [],
  },
  {
    id: 'delegation',
    title: 'Delegation from the owner to the agent wallet',
    suppliedBy: 'ACCOUNT_OWNER',
    ownerAuthenticated: true,
    why: 'Without it the agent authenticates and then has every write refused. It is granted in an owner session and cannot be granted by the agent.',
    supplyWith: [
      'OWNER ACTION, owner-authenticated: grant the agent wallet a delegation on the account, with an allowance and a validity window.',
      'This harness must not attempt it. An agent runtime that could grant its own delegation would make the delegation meaningless (ADR-0003 §1).',
    ],
    settledBy:
      'account risk-limits --accountId <id> → delegation.mayPlaceOrder (null means the chain read failed, NOT that it was revoked)',
    needs: ['baseUrl', 'agentWallet', 'signerCommand', 'defaultAccount'],
  },
  {
    id: 'ownerRiskProfile',
    title: 'Agent risk profile on the account',
    suppliedBy: 'ACCOUNT_OWNER',
    ownerAuthenticated: true,
    why: 'The mandate that bounds the agent: order size, slippage, orders and notional per hour, in-flight executions. Absent, `account risk-limits` reports NO_RISK_PROFILE and the agent is not onboarded — which is a distinct state from unlimited (ADR-0003 §5).',
    supplyWith: [
      'OWNER ACTION, owner-authenticated: PUT accounts/:accountId/agents/:agentWallet/risk-profile through the owner UI or API.',
      'This harness must not attempt it. Widening a limit is an owner operation and stays one (ADR-0003 §1, §6).',
    ],
    settledBy: 'account risk-limits --accountId <id> → a mandate rather than NO_RISK_PROFILE',
    needs: ['baseUrl', 'agentWallet', 'signerCommand', 'defaultAccount'],
  },
];

const BY_ID = new Map(PROVISIONING_GAPS.map((gap) => [gap.id, gap]));

export const getGap = (id: GapId): ProvisioningGap => {
  const gap = BY_ID.get(id);
  // Unreachable while GapId and PROVISIONING_GAPS agree, which a test asserts.
  if (gap === undefined) throw new Error(`No provisioning gap is named ${id}.`);
  return gap;
};

/**
 * `SATISFIED` — observed present. `MISSING` — observed absent. `UNCHECKED` — the
 * check could not run, so nothing is claimed either way.
 */
export type GapStatus = 'SATISFIED' | 'MISSING' | 'UNCHECKED';

export interface GapState {
  readonly id: GapId;
  readonly status: GapStatus;
  /** What was actually observed, or why nothing could be. Never a guess. */
  readonly observed: string;
}
