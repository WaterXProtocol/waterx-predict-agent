/**
 * What is actually provisioned on this machine, established by asking the CLI
 * rather than by reading the environment again.
 *
 * `describe` is the right question because it answers with no configuration and
 * no network, and because it applies the CLI's own precedence rules (flag, then
 * environment, then config file). Re-implementing that precedence here would
 * give two answers to "is a base URL configured", and the harness's answer would
 * be the wrong one.
 *
 * The two owner-authenticated gaps need a server, so they are settled by
 * `account risk-limits` — one read that carries both the mandate and the
 * delegation. Where that read cannot happen, or where the server itself reports
 * a chain read that failed, the gap is UNCHECKED. Reporting "no delegation"
 * because nobody could look is how a healthy setup gets torn down.
 *
 * The Runner is settled by `strategy list`, which needs no server and no
 * account: it dials a Unix socket on this machine. Two things have to be true
 * for it to count — a Runner answered, AND it says it is driving. A Runner that
 * answers but drives nothing accepts a strategy and writes a real job nothing
 * will advance, and calling that "provisioned" would be the expensive kind of
 * wrong.
 *
 * The two gaps nobody can probe — an owner address and a restart command — are
 * settled by having been GIVEN one. Neither is inferred: there is no reading of
 * this machine that produces the owner's address, and no safe way to guess how
 * an operator's daemon is restarted.
 */
import type { CliInvoker, CliRun } from './cli-process.ts';
import { GAP_IDS, getGap, type GapId, type GapState } from './gaps.ts';
import type { HarnessOptions } from './steps.ts';

export interface RuntimeFacts {
  readonly baseUrl: string | null;
  readonly environment: string | null;
  readonly agentWallet: string | null;
  readonly defaultAccountId: string | null;
  readonly signerConfigured: boolean;
  readonly configFile: string | null;
  readonly policyMode: string | null;
}

export interface Preflight {
  /** The `describe` run itself, reused as the first step's evidence. */
  readonly describe: CliRun;
  /** The `strategy list` probe, reused the same way by the step of that name. */
  readonly runnerProbe: CliRun;
  readonly facts: RuntimeFacts;
  readonly gaps: readonly GapState[];
}

const NO_FACTS: RuntimeFacts = {
  baseUrl: null,
  environment: null,
  agentWallet: null,
  defaultAccountId: null,
  signerConfigured: false,
  configFile: null,
  policyMode: null,
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function readRuntimeFacts(run: CliRun): RuntimeFacts {
  if (run.envelope?.ok !== true) return NO_FACTS;
  const data = asRecord(run.envelope.data);
  const api = asRecord(data.api);
  const identity = asRecord(data.identity);
  const signer = asRecord(data.signer);
  const policy = asRecord(data.policy);
  return {
    baseUrl: asString(api.baseUrl),
    environment: asString(api.environment),
    agentWallet: asString(identity.agentWallet),
    defaultAccountId: asString(identity.defaultAccountId),
    signerConfigured: signer.configured === true,
    configFile: asString(identity.configFile),
    policyMode: asString(policy.mode),
  };
}

/** The gaps `describe` alone settles, in the order they are declared. */
function localGapStates(facts: RuntimeFacts): GapState[] {
  const local: Array<[GapId, string | null, string]> = [
    ['baseUrl', facts.baseUrl, 'No API base URL is configured.'],
    ['environment', facts.environment, 'No environment label is configured.'],
    ['agentWallet', facts.agentWallet, 'No agent wallet address is configured.'],
    ['defaultAccount', facts.defaultAccountId, 'No default account id is configured.'],
  ];

  const states: GapState[] = local.map(([id, value, absent]) => ({
    id,
    status: value === null ? ('MISSING' as const) : ('SATISFIED' as const),
    observed: value === null ? absent : `describe reports ${value}.`,
  }));

  states.push({
    id: 'signerCommand',
    status: facts.signerConfigured ? 'SATISFIED' : 'MISSING',
    observed: facts.signerConfigured
      ? 'describe reports a configured external signer command.'
      : 'No external signer command is configured, so nothing can sign a challenge or a transaction.',
  });
  return states;
}

/**
 * Settle the two owner-authenticated gaps from one authenticated read.
 *
 * This READS a mandate. It never writes one, and there is no code path here that
 * could: the write is on an owner-authenticated controller the agent credential
 * cannot reach, and that is the control, not an inconvenience (ADR-0003 §1).
 */
function serverGapStates(run: CliRun): GapState[] {
  if (run.envelope?.ok !== true) {
    const code = run.envelope?.error?.code ?? 'NO_ENVELOPE';
    const detail = `The mandate read did not succeed (${code}), so neither the delegation nor the risk profile could be observed.`;
    return [
      { id: 'delegation', status: 'UNCHECKED', observed: detail },
      { id: 'ownerRiskProfile', status: 'UNCHECKED', observed: detail },
    ];
  }

  const data = asRecord(run.envelope.data);
  const limits = asRecord(data.limits);
  const delegation = asRecord(data.delegation);
  const mayPlaceOrder = delegation.mayPlaceOrder;

  return [
    {
      id: 'delegation',
      // `null` is the chain read having FAILED, which the contract is explicit
      // about. It is not a revocation and must never be reported as one.
      status:
        mayPlaceOrder === true ? 'SATISFIED' : mayPlaceOrder === false ? 'MISSING' : 'UNCHECKED',
      observed:
        mayPlaceOrder === true
          ? `The server reports the agent wallet may place orders (checked ${asString(delegation.checkedAt) ?? 'at an unstated time'}).`
          : mayPlaceOrder === false
            ? 'The server reports the agent wallet may NOT place orders. The owner has not granted, or has revoked, the delegation.'
            : 'The server could not read the delegation from chain, so its state is unknown — this is not a revocation.',
    },
    {
      id: 'ownerRiskProfile',
      status: limits.available === true ? 'SATISFIED' : 'MISSING',
      observed:
        limits.available === true
          ? 'The server reports an effective mandate for this agent wallet on this account.'
          : `The server reports no mandate (${asString(limits.reason) ?? 'NO_RISK_PROFILE'}). Absence is denial, not an unlimited default.`,
    },
  ];
}

/**
 * The Runner gap, from one `strategy list`.
 *
 * `RUNNER_UNREACHABLE` is the one error that means MISSING — the Runner is not
 * there. Any other refusal is UNCHECKED: something answered and said no for a
 * reason this harness has not established, and "no Runner" would be a stronger
 * claim than the evidence supports.
 */
function runnerGapState(run: CliRun): GapState {
  if (run.envelope?.ok !== true) {
    const code = run.envelope?.error?.code ?? 'NO_ENVELOPE';
    return code === 'RUNNER_UNREACHABLE'
      ? {
          id: 'runner',
          status: 'MISSING',
          observed: `No Runner answered: ${run.envelope?.error?.message ?? 'RUNNER_UNREACHABLE'}`,
        }
      : {
          id: 'runner',
          status: 'UNCHECKED',
          observed: `The Runner probe did not succeed (${code}), so whether one is running was not established.`,
        };
  }

  const runner = asRecord(asRecord(run.envelope.data).runner);
  const instanceId = asString(runner.instanceId);
  if (instanceId === null) {
    return {
      id: 'runner',
      status: 'UNCHECKED',
      observed: 'A reply arrived but named no Runner instance, so nothing can be told apart from anything else.',
    };
  }
  return runner.driving === true
    ? { id: 'runner', status: 'SATISFIED', observed: `Runner ${instanceId} answered and is driving jobs.` }
    : {
        id: 'runner',
        status: 'MISSING',
        // MISSING rather than SATISFIED-with-a-caveat: what is missing is a
        // Runner that can advance a job, and this one cannot.
        observed: `Runner ${instanceId} answered but is NOT driving jobs. A strategy armed on it would be armed and asleep.`,
      };
}

/** The two gaps that are settled by having been supplied, and by nothing else. */
function suppliedGapStates(options: HarnessOptions): GapState[] {
  return [
    {
      id: 'ownerAddress',
      status: options.ownerAddress === null ? 'MISSING' : 'SATISFIED',
      observed:
        options.ownerAddress === null
          ? 'No owner address was supplied. Nothing here infers one: an address attributes a trade to a person.'
          : // The address itself is configuration, not a secret, and it is
            // already visible in the argv this harness prints.
            `This harness was given ${options.ownerAddress}.`,
    },
    {
      id: 'runnerRestart',
      status: options.runnerRestart === null ? 'MISSING' : 'SATISFIED',
      observed:
        options.runnerRestart === null
          ? 'No restart command was supplied, and none is invented — this harness never constructs a way to stop a process it did not start.'
          : 'This harness was given a restart command by the operator.',
    },
  ];
}

export async function preflight(invoke: CliInvoker, options: HarnessOptions): Promise<Preflight> {
  const describe = await invoke(['describe']);
  const facts = readRuntimeFacts(describe);
  const states = new Map<GapId, GapState>(
    [...localGapStates(facts), ...suppliedGapStates(options)].map((state) => [state.id, state]),
  );

  // Local, cheap and unconditional: it needs no base URL, no account and no
  // signer, so there is no configuration under which asking is wasteful.
  const runnerProbe = await invoke(['strategy', 'list']);
  states.set('runner', runnerGapState(runnerProbe));

  const blocking = getGap('delegation').needs.filter(
    (need) => states.get(need)?.status !== 'SATISFIED',
  );

  if (blocking.length > 0) {
    const observed = `Not checked: ${blocking.join(', ')} ${blocking.length === 1 ? 'is' : 'are'} not provisioned, so no authenticated read could be made.`;
    states.set('delegation', { id: 'delegation', status: 'UNCHECKED', observed });
    states.set('ownerRiskProfile', { id: 'ownerRiskProfile', status: 'UNCHECKED', observed });
  } else {
    const mandate = await invoke([
      'account',
      'risk-limits',
      '--accountId',
      facts.defaultAccountId ?? '',
    ]);
    for (const state of serverGapStates(mandate)) states.set(state.id, state);
  }

  return {
    describe,
    runnerProbe,
    facts,
    // Declaration order, so the list a human reads is stable run to run.
    gaps: GAP_IDS.map((id) => {
      const state = states.get(id);
      if (state === undefined) {
        throw new Error(`Preflight produced no state for the gap \`${id}\`.`);
      }
      return state;
    }),
  };
}

export const unsatisfied = (gaps: readonly GapState[], required: readonly GapId[]): GapId[] =>
  required.filter((id) => gaps.find((gap) => gap.id === id)?.status !== 'SATISFIED');
