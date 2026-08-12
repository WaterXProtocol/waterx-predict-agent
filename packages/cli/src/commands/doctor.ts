/**
 * `doctor` — find out why nothing works, before trying to trade.
 *
 * Each check is a fact, reported as PASS, FAIL or SKIP. SKIP is load-bearing: a
 * check that could not run because a prerequisite failed is NOT a pass, and
 * reporting it as one is how an operator concludes a broken setup is healthy.
 *
 * The authentication check signs the login challenge as a PERSONAL MESSAGE. That
 * moves no funds, is not a transaction signature, and is the only signing this
 * command does. The write-plane check never signs a transaction: the only honest
 * proof that the write path works is a real order, and `doctor` will not place
 * one. It reports the policy in force and the one write-blocking fact it can
 * settle without trading — a delegation whose window has already closed.
 */
import { isPredictAgentApiError } from '@waterx/predict-agent-sdk';

import type { ResolvedConfig } from '../config.ts';
import type { CommandContext } from '../context.ts';
import type { EnvelopeError } from '../envelope.ts';
import { isCliError, isCliErrorCode } from '../errors.ts';
import { exitCodeForCliError, exitCodeForServerError, type ExitCode } from '../exit-codes.ts';
import { describeSigner } from '../signer.ts';

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly summary: string;
  /** Symbolic. Present on FAIL, and it is what the exit code is derived from. */
  readonly code?: string;
  readonly detail?: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly failed: number;
  readonly skipped: number;
  readonly checkedAt: string;
}

const failureCode = (error: unknown): string => {
  if (isCliError(error)) return error.code;
  if (isPredictAgentApiError(error)) return error.code;
  return 'TRANSPORT_FAILED';
};

const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'The check failed for an unrecognised reason.';

/**
 * Can this runtime write at all, and would the policy let it?
 *
 * Deliberately NOT a live test. Proving the write path end to end means placing
 * a real order, and a diagnostic command that trades is a diagnostic command
 * nobody can safely run. So this reports the policy as a fact and settles the
 * one write-blocker that is knowable without trading: a delegated-auto scope
 * whose `notAfter` has passed authorizes nothing, and finding that out here is
 * far better than finding it out from the first refused order.
 */
function writePlaneCheck(config: ResolvedConfig, now: Date): DoctorCheck {
  const { mode, scope } = config.policy;

  if (mode === 'read-only') {
    return {
      id: 'write-plane',
      status: 'SKIP',
      summary: 'Not applicable: the execution policy is read-only, so no transaction can be signed.',
      detail:
        '`signTransaction` throws before a signer process is spawned. Reads, `market quote` and `order preview` still work.',
    };
  }

  if (mode === 'delegated-auto') {
    const notAfter = scope === undefined ? Number.NaN : Date.parse(scope.notAfter);
    if (Number.isNaN(notAfter) || now.getTime() > notAfter) {
      return {
        id: 'write-plane',
        status: 'FAIL',
        code: 'POLICY_DENIED',
        summary: 'The delegated-auto window has closed, so this policy authorizes no order.',
        detail: `policy.scope.notAfter is ${scope?.notAfter ?? 'unset'} and it is now ${now.toISOString()}. Renew the delegation deliberately, or run under the interactive policy and approve each order.`,
      };
    }
    return {
      id: 'write-plane',
      status: 'SKIP',
      summary: `Not attempted: writes are pre-authorized within the delegated-auto scope until ${scope?.notAfter ?? ''}.`,
      detail:
        'The only proof that the write path works is a real order, and `doctor` will not place one. The scope is checked per order, and the server enforces the owner’s risk profile independently.',
    };
  }

  return {
    id: 'write-plane',
    status: 'SKIP',
    summary: 'Not attempted: the policy is interactive, so a write needs an explicit approval.',
    detail:
      'Run `order preview` and pass its `policy.approvalToken` back as `--approve <token>`. The only proof that the write path works is a real order, and `doctor` will not place one.',
  };
}

export async function runDoctor(context: CommandContext): Promise<DoctorReport> {
  const { config } = context;
  const checks: DoctorCheck[] = [];
  /** Flipped by any branch that has already accounted for the catalog check. */
  let catalogSettled = false;

  const configured = config.baseUrl !== undefined;
  checks.push(
    configured
      ? {
          id: 'config',
          status: 'PASS',
          summary: `API base URL configured${config.configPath === null ? ' from the environment' : ` from ${config.configPath}`}.`,
        }
      : {
          id: 'config',
          status: 'FAIL',
          code: 'NOT_CONFIGURED',
          summary: 'No API base URL is configured.',
          detail: 'Set WATERX_PREDICT_BASE_URL, or `baseUrl` in the config file.',
        },
  );

  const signer = describeSigner(config);
  const walletKnown = config.agentWallet !== undefined;
  const signerReady = signer.configured && walletKnown;
  checks.push(
    signerReady
      ? {
          id: 'signer',
          status: 'PASS',
          summary: `External signer command \`${signer.executable ?? ''}\` configured for wallet ${config.agentWallet ?? ''}.`,
          detail: signer.note,
        }
      : {
          id: 'signer',
          status: 'FAIL',
          code: signer.configured ? 'NOT_CONFIGURED' : 'SIGNER_UNAVAILABLE',
          summary: signer.configured
            ? 'A signer command is configured but no agent wallet is.'
            : 'No signer command is configured.',
          detail: signer.note,
        },
  );

  const canCallApi = configured && signerReady;

  if (!canCallApi) {
    // Everything below needs a client. Skipped, not failed: they were never run,
    // and marking them FAIL would invent evidence about a server nobody reached.
    for (const id of ['api-reachable', 'authentication', 'market-catalog']) {
      checks.push({
        id,
        status: 'SKIP',
        summary: 'Not attempted: configuration or signer is incomplete.',
      });
    }
    catalogSettled = true;
  } else {
    try {
      // Opening the client IS the handshake: a session comes back only if the
      // host was reachable AND the signature verified, so one call settles two
      // checks. With a supplied token nothing is sent, and both are reported as
      // not-attempted rather than as passing on no evidence — the catalog read
      // below is what actually exercises that token.
      await context.client();
      const probed = config.token === undefined;
      checks.push(
        probed
          ? { id: 'api-reachable', status: 'PASS', summary: `Reached ${config.baseUrl ?? ''}.` }
          : {
              id: 'api-reachable',
              status: 'SKIP',
              summary: 'Not attempted here: a token was supplied, so no handshake was sent.',
              detail: 'The catalog check below is the first request, and it proves reachability.',
            },
      );
      checks.push(
        probed
          ? {
              id: 'authentication',
              status: 'PASS',
              summary: 'Signed the login challenge as a personal message and received a session.',
              detail: 'The token is held in memory for this invocation only and is never printed.',
            }
          : {
              id: 'authentication',
              status: 'SKIP',
              summary: 'Not attempted: a token was supplied, so no challenge was signed.',
              detail:
                'Whether that token is still valid is decided by the catalog check below, not here.',
            },
      );
    } catch (error: unknown) {
      const code = failureCode(error);
      const reached = isPredictAgentApiError(error);
      checks.push(
        reached
          ? { id: 'api-reachable', status: 'PASS', summary: `Reached ${config.baseUrl ?? ''}.` }
          : {
              id: 'api-reachable',
              status: 'FAIL',
              code,
              summary: `Could not reach ${config.baseUrl ?? ''}.`,
              detail: failureMessage(error),
            },
      );
      checks.push({
        id: 'authentication',
        status: 'FAIL',
        code,
        summary: 'Could not open a session.',
        detail: failureMessage(error),
      });
      checks.push({
        id: 'market-catalog',
        status: 'SKIP',
        summary: 'Not attempted: authentication failed.',
      });
      catalogSettled = true;
    }
  }

  if (!catalogSettled) {
    try {
      const client = await context.client();
      const markets = await client.getMarkets({ limit: 1 }, context.signal());
      checks.push({
        id: 'market-catalog',
        status: 'PASS',
        summary: `Catalog readable (${String(markets.markets.length)} market returned for limit 1).`,
      });
    } catch (error: unknown) {
      checks.push({
        id: 'market-catalog',
        status: 'FAIL',
        code: failureCode(error),
        summary: 'Could not read the market catalog.',
        detail: failureMessage(error),
      });
    }
  }

  const accountId =
    typeof context.input.accountId === 'string' ? context.input.accountId : config.defaultAccountId;

  if (!canCallApi || accountId === undefined) {
    checks.push({
      id: 'account-allowance',
      status: 'SKIP',
      summary:
        accountId === undefined
          ? 'Not attempted: no account was given and none is configured. Pass --accountId, or set WATERX_PREDICT_ACCOUNT_ID.'
          : 'Not attempted: configuration or signer is incomplete.',
    });
  } else {
    try {
      const client = await context.client();
      const allowance = await client.getAllowance(accountId, context.signal());
      checks.push({
        id: 'account-allowance',
        status: 'PASS',
        summary: `Allowance readable. effectiveBuyCapacity ${allowance.effectiveBuyCapacity}.`,
        detail:
          'effectiveBuyCapacity is the smaller of the API allowance and the spendable balance. It is a WaterX policy figure, not an on-chain guarantee.',
      });
    } catch (error: unknown) {
      checks.push({
        id: 'account-allowance',
        status: 'FAIL',
        code: failureCode(error),
        summary: 'Could not read the account allowance.',
        detail: failureMessage(error),
      });
    }
  }

  checks.push(writePlaneCheck(config, context.now()));

  return {
    checks,
    failed: checks.filter((check) => check.status === 'FAIL').length,
    skipped: checks.filter((check) => check.status === 'SKIP').length,
    checkedAt: context.now().toISOString(),
  };
}

/**
 * A failing doctor is a failing command.
 *
 * Exiting 0 with the failures buried in a field would mean every caller has to
 * parse the report to notice its runtime is broken — and the ones that do not
 * parse it would carry on and trade against a misconfigured API.
 *
 * The reported code is the FIRST failing check's own code, not a wrapper code:
 * `doctor` failing because the token was rejected should exit 4 and say
 * UNAUTHENTICATED, exactly as the command that hit it would have. The full
 * report travels in `error.details` so nothing is lost either way.
 */
export function doctorFailure(report: DoctorReport): { error: EnvelopeError; exit: ExitCode } {
  const first = report.checks.find((check) => check.status === 'FAIL');
  const code = first?.code ?? 'INTERNAL';
  const local = isCliErrorCode(code);
  return {
    error: {
      code,
      message: `${String(report.failed)} check(s) failed, starting with \`${first?.id ?? 'unknown'}\`: ${first?.summary ?? ''}`,
      retryable: false,
      source: local ? 'CLI' : 'SERVER',
      details: { report },
    },
    exit: local ? exitCodeForCliError(code) : exitCodeForServerError(code),
  };
}
