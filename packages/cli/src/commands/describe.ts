/**
 * `describe` — the answer to "what am I holding, and what can it do".
 *
 * Runs with NO configuration and NO network. Discovery precedes setup: a host
 * that must configure a runtime before it can ask what the runtime needs is a
 * host that guesses. Every field below is either a local fact or a statement
 * about this build; nothing is fetched, and nothing about the server is claimed
 * that this build cannot substantiate.
 */
import {
  AGENT_COMMAND_SCHEMA_VERSION,
  AGENT_COMMANDS,
  COMMAND_DOCUMENT_ID,
} from '@waterx/predict-agent-schema';

import { CAPABILITIES } from '../capabilities.ts';
import type { ResolvedConfig } from '../config.ts';
import { ENVELOPE_SCHEMA_VERSION } from '../envelope.ts';
import { EXIT_CODE_TABLE } from '../exit-codes.ts';
import { describeSigner } from '../signer.ts';
import { API_VERSION, CLI_NAME, CLI_VERSION } from '../version.ts';

/**
 * The execution policy in force, described honestly.
 *
 * Including what an approval token is NOT. A host that believed the token
 * authenticated a human would build exactly the wrong thing on top of it, and a
 * policy believed to be stronger than it is, is worse than no policy at all.
 */
function describePolicy(config: ResolvedConfig): unknown {
  const { mode, source, scope } = config.policy;
  return {
    mode,
    source,
    enforced: true,
    writesAllowed: mode !== 'read-only',
    enforcement:
      'Enforced in the signer and a counted signing gate, not by convention. Under read-only `signTransaction` throws before a signer process is spawned; otherwise it must spend a permit that only an authorized write can have granted, so an unauthorized path runs out of permits rather than trading.',
    approval:
      mode === 'interactive'
        ? {
            required: true,
            how: 'Run `order preview`, then pass its `policy.approvalToken` back as `--approve <token> --approver <name>` on `order execute`. The name is recorded with the approval in the write audit log (ADR-0018).',
            binds:
              'One exact intent: account, market, outcome, side, size unit and amount, position, slippage, absolute bound, strategy and client order id.',
            lifetime:
              'Issued by the preview and recorded on this machine (ADR-0014). It expires after ten minutes and is spent by the one write it authorizes; a second order needs a second preview.',
            isNotAuthentication:
              'Anything that can run a preview can obtain one. It proves a caller carried a value from a preview into an execution — not that a person saw the order. A human-in-the-loop host puts the human at that seam.',
          }
        : { required: false },
    ...(scope !== undefined
      ? {
          scope,
          cumulativeBudget:
            'maxCumulativeBuyAmount counts every BUY this exact scope authorized, across invocations, until notAfter (ADR-0014). A reservation is returned only when nothing was signed. EDITING THE SCOPE STARTS THE COUNT AT ZERO — the total is kept against a digest of the scope, so changing an account, a market or the expiry begins a new budget rather than continuing this one. `order preview` reports what was authorized under a scope that is no longer configured.',
        }
      : {}),
    cannotWiden:
      config.mode === 'direct'
        ? 'Local policy only ever narrows. In direct mode (ADR-0013) there is no server-side risk profile: this policy is the only spending ceiling, and the owner’s on-chain delegation is the only authority. Every transaction the backend builds is decoded and checked against the intent before it is signed.'
        : 'Local policy only ever narrows. The owner’s risk profile is enforced server-side (ADR-0003) and this runtime cannot read or raise it; a delegated-auto BUY is additionally checked against the server’s own effectiveBuyCapacity.',
    narrowWith: '--policy read-only (the flag may narrow the configured policy, never widen it)',
  };
}

export function describeRuntime(config: ResolvedConfig, nodeVersion: string): unknown {
  const signer = describeSigner(config);
  return {
    runtime: {
      name: CLI_NAME,
      version: CLI_VERSION,
      envelopeSchemaVersion: ENVELOPE_SCHEMA_VERSION,
      node: nodeVersion,
      // Stated, not detected. The plan restricts beta support to macOS and
      // Linux and forbids claiming Windows before it is verified.
      supportedPlatforms: ['darwin', 'linux'],
    },
    commandContract: {
      schemaVersion: AGENT_COMMAND_SCHEMA_VERSION,
      id: COMMAND_DOCUMENT_ID,
      commandCount: AGENT_COMMANDS.length,
      read: `${CLI_NAME} command-schema`,
    },
    api: {
      version: API_VERSION,
      baseUrl: config.baseUrl ?? null,
      environment: config.environment ?? null,
      /** `DEFAULT`: nothing was named and this is production — mainnet (ADR-0011). */
      deploymentSource: config.deploymentSource,
      configured: config.baseUrl !== undefined,
      /**
       * `direct` (default): the public WaterX routes, as the owner's on-chain
       * delegate, with no agent API and no JWT (ADR-0013). `agent-api`: the
       * authenticated Predict Agent API.
       */
      mode: config.mode,
      network: config.network ?? null,
    },
    identity: {
      agentWallet: config.agentWallet ?? null,
      defaultAccountId: config.defaultAccountId ?? null,
      configFile: config.configPath,
    },
    signer,
    policy: describePolicy(config),
    capabilities: CAPABILITIES,
    conventions: {
      output:
        'Exactly one JSON document on stdout per invocation. Diagnostics go to stderr and are never part of the result.',
      input:
        'A whole input document via --input, --file or --stdin, and/or typed flags named after the command’s schema fields. A flag value that does not match its declared type is an error, never a coercion.',
      money:
        'Amounts, prices and sizes are decimal STRINGS. A JSON number cannot hold them exactly, so they are never parsed into one.',
      size: 'BUY commits a budget via `size.buyAmount`. SELL closes shares via `size.sellShares`. The two are never interchangeable and an ambiguous size is refused before anything is sent.',
      marketIdentity:
        'A marketId comes from `market list` or `market get`. This runtime never constructs or infers one.',
      pricing:
        'Catalog prices are indicative top-of-book and are not executable. `market quote` mints the only price an order may be built on, and it lives seconds.',
      errors:
        '`error.source` says which namespace `error.code` belongs to: CLI for this runtime’s refusals, SERVER for the exchange’s, TRANSPORT when no response was seen.',
      correlation:
        '`requestId` is generated locally and correlates stdout with stderr for one invocation. This API version returns no server-side trace identifier, so none is reported.',
    },
    exitCodes: EXIT_CODE_TABLE,
    serverCapabilities: {
      source: 'STATIC',
      note: 'This build’s own knowledge of the API, not something the server advertised: there is no capability document to query (backlog B7). Treat it as a claim about this version, and prefer the server’s own errors when they disagree.',
      marketTextSearch: true,
      marketHistory: false,
      cursorPagination: true,
      sizeAwareQuotes: false,
      agentReadableRiskLimits: config.mode !== 'direct',
      ...(config.mode === 'direct'
        ? {
            unavailableInDirectMode: [
              'account.allowance',
              'account.risk-limits',
              'account.executions',
              'account.fills',
              'account.performance',
            ],
            directModeNote:
              'No public route serves these. They answer CAPABILITY_UNAVAILABLE rather than an empty list. Read an order back with `order get`; positions come from the owner’s public feed and cover the main account only.',
          }
        : {}),
    },
    limitations: [
      'An order cannot be cancelled. These are market orders: once submitted, a keeper fills or rejects them, and the API exposes nothing that recalls one.',
      '`order execute-many` is client-side orchestration and is never atomic. Legs succeed, fail and skip independently.',
      'An approval token binds an intent; it is not authentication and does not prove a human saw the order.',
      'The market catalog pages by `limit` only — it has no cursor, because the page is projected in memory and ordered partly by round-clock facts. Account history (positions, executions, fills) does page by cursor.',
      'Quotes are size-blind: availableSize and expectedFillSize come back null and a large order can be correctly priced and still fail to fill (backlog B5).',
      'Listed positions, executions and fills cover API-attributed activity only. A direct-chain trade by the same delegated key is not included.',
      'The only signer provider is an external command. Keystore, keychain and KMS providers are not implemented (backlog 1.8).',
    ],
  };
}
