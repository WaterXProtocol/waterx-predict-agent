/**
 * The local installation report.
 *
 * What is asserted here is mostly what the report must NOT say. It runs before
 * anything is configured, which is exactly the moment a wrong answer is most
 * expensive: an owner asked to re-sign a grant they already made, a Runner
 * reported absent while it is driving a job, a caller who configured everything
 * in code told that none of it is there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describeInstallation } from '../src/installation.ts';
import { AGENT_REQUIREMENTS, nextStepFor, REQUIREMENT_IDS } from '../src/provisioning.ts';

/** A PATH with nothing on it, so `waterx-predict` is genuinely absent. */
const EMPTY_PATH = { PATH: '/nonexistent-directory-for-this-test' } as const;

const CONFIGURED = {
  ...EMPTY_PATH,
  WATERX_PREDICT_ENVIRONMENT: 'testnet',
  WATERX_PREDICT_AGENT_WALLET: `0x${'55'.repeat(32)}`,
  // Deliberately unlike the example in `supplyWith`: a fixture that collides
  // with the documentation would pass the no-echo assertion below on the
  // strength of static prose rather than on the report withholding it.
  WATERX_PREDICT_SIGNER_COMMAND: '/opt/agent/keystore-signer-fixture',
} as const;

describe('the requirement list', () => {
  it('declares every id exactly once', () => {
    const ids = AGENT_REQUIREMENTS.map((requirement) => requirement.id);
    expect(ids).toEqual([...REQUIREMENT_IDS]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every requirement a supplier, a reason and a way to supply it', () => {
    for (const requirement of AGENT_REQUIREMENTS) {
      expect(requirement.supplyWith.length, requirement.id).toBeGreaterThan(0);
      expect(requirement.why.length, requirement.id).toBeGreaterThan(0);
      expect(requirement.settledBy.length, requirement.id).toBeGreaterThan(0);
    }
  });

  it('never marks an operator-supplied requirement owner-authenticated', () => {
    // The distinction is the whole of ADR-0003's two-actor onboarding. An
    // owner-authenticated fact the operator is told to supply is an invitation
    // to widen a mandate from the side that is bound by it.
    for (const requirement of AGENT_REQUIREMENTS) {
      if (requirement.ownerAuthenticated) {
        expect(requirement.suppliedBy, requirement.id).toBe('ACCOUNT_OWNER');
      }
    }
  });
});

describe('describeInstallation', () => {
  it('reports the three local requirements as missing when nothing is set', () => {
    const report = describeInstallation({ env: EMPTY_PATH });
    expect(report.missing.map((requirement) => requirement.id)).toEqual([
      'deployment',
      'agentWallet',
      'signer',
    ]);
    expect(report.nextStep.actor).toBe('AGENT_OPERATOR');
  });

  it('never asks anyone for a hostname or an account id', () => {
    // Both were the friction the onboarding work removed. The SDK ships every
    // host it talks to, and the server answers for the account — a report that
    // listed either as a thing to supply would be telling a person to go and
    // copy something out of a browser again.
    const report = describeInstallation({ env: EMPTY_PATH });
    expect(report.requirements.map((requirement) => requirement.id)).not.toContain('baseUrl');
    expect(report.requirements.map((requirement) => requirement.id)).not.toContain('accountId');
    const deployment = report.requirements.find((entry) => entry.id === 'deployment');
    // It names the network, and the hostname is the fallback for a deployment
    // that has no name.
    expect(deployment?.supplyWith[0]).toContain("deployment: 'testnet'");
  });

  it('takes either spelling of the deployment', () => {
    // Naming the network is the normal case; a private host is what a
    // deployment without a name has instead. They settle the same requirement.
    for (const env of [
      { ...EMPTY_PATH, WATERX_PREDICT_ENVIRONMENT: 'testnet' },
      { ...EMPTY_PATH, WATERX_PREDICT_BASE_URL: 'https://api.private.invalid' },
    ]) {
      const report = describeInstallation({ env });
      expect(report.missing.map((requirement) => requirement.id)).not.toContain('deployment');
    }
  });

  it('never reports an owner-authenticated requirement as missing', () => {
    // It could only be MISSING on evidence this command does not have. Reported
    // that way, the first thing a caller does is send an owner to re-sign a
    // delegation that may already exist — after which they conclude the product
    // is broken, which is the failure `DELEGATION_UNKNOWN` exists to prevent.
    for (const env of [EMPTY_PATH, CONFIGURED]) {
      const report = describeInstallation({ env });
      for (const requirement of report.requirements) {
        if (requirement.ownerAuthenticated) expect(requirement.state).toBe('UNCHECKED');
      }
      expect(report.unchecked.map((requirement) => requirement.id)).toEqual([
        'authorizedAccount',
        'delegation',
        'riskProfile',
      ]);
    }
  });

  it('does not call a locally complete install ready', () => {
    // Everything knowable is supplied and nothing has been granted yet. Saying
    // ready here is how an agent gets reported as onboarded before an owner has
    // authorized it at all.
    const report = describeInstallation({ env: CONFIGURED });
    expect(report.missing).toEqual([]);
    expect(report.nextStep.actor).toBe('AGENT_OPERATOR');
    expect(report.nextStep.action).toContain('authenticated read');
    expect(report.nextStep.action).not.toContain('ready');
  });

  it('believes a caller who configured the client in code', () => {
    // A library caller passes a baseUrl and a signer to the constructor and
    // sets no environment variable at all. Reporting that as missing teaches
    // them the report is wrong, and they stop reading the part that was right.
    const report = describeInstallation({
      env: EMPTY_PATH,
      supplied: { deployment: true, agentWallet: true, signer: true },
    });
    expect(report.missing).toEqual([]);
    for (const id of ['deployment', 'agentWallet', 'signer'] as const) {
      const requirement = report.requirements.find((entry) => entry.id === id);
      expect(requirement?.state, id).toBe('SATISFIED');
      expect(requirement?.evidence, id).toContain('caller');
    }
  });

  it('echoes no configured value, only the name of what supplied it', () => {
    // None of these four is a secret today. A report that prints configuration
    // by habit is one signer path — or one supplied token — away from printing
    // something that is (`NEVER_ECHO_A_SECRET`).
    const serialized = JSON.stringify(describeInstallation({ env: CONFIGURED }));
    for (const value of [
      CONFIGURED.WATERX_PREDICT_AGENT_WALLET,
      CONFIGURED.WATERX_PREDICT_SIGNER_COMMAND,
    ]) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).toContain('WATERX_PREDICT_ENVIRONMENT is set.');
  });

  it('says the CLI is absent when it is, and unknown when there is no PATH', () => {
    const withPath = describeInstallation({ env: EMPTY_PATH });
    expect(withPath.surfaces.find((surface) => surface.id === 'cli')?.present).toBe(false);

    // No PATH is not the same as an empty one. `false` here would be a claim
    // about a filesystem nobody looked at.
    const withoutPath = describeInstallation({ env: {} });
    expect(withoutPath.surfaces.find((surface) => surface.id === 'cli')?.present).toBeUndefined();
  });

  it('never reports the Runner as absent', () => {
    // A Runner is a process behind a local socket, not a binary on PATH. Saying
    // absent because nothing was found is how a live strategy gets reported as
    // unwatched — the mirror image of the mistake `driving: false` prevents.
    for (const env of [EMPTY_PATH, CONFIGURED, {}]) {
      const runner = describeInstallation({ env }).surfaces.find(
        (surface) => surface.id === 'runner',
      );
      expect(runner?.present).toBeUndefined();
    }
  });

  it('points at the instructions this package actually ships', () => {
    // The path has to resolve from `src/` under a test and from `dist/src/`
    // under a build. One that works in only one of those fails in whichever the
    // author did not run.
    const report = describeInstallation({ env: EMPTY_PATH });
    // Not "some manifest above this module": an application that inlined this
    // file would have one too, and reporting its name, its version and its
    // stray `AGENT_INSTRUCTIONS.md` would be worse than reporting nothing.
    expect(report.package?.name).toBe('@waterx/predict-agent-sdk');
    expect(report.package?.version).toBe(
      (JSON.parse(
        readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
      ) as { version: string }).version,
    );
    expect(report.instructionsPath).toBeTypeOf('string');
    expect(existsSync(report.instructionsPath ?? '')).toBe(true);
    expect(readFileSync(report.instructionsPath ?? '', 'utf8')).toBe(
      readFileSync(fileURLToPath(new URL('../AGENT_INSTRUCTIONS.md', import.meta.url)), 'utf8'),
    );
  });
});

describe('nextStepFor', () => {
  it('sends the operator first, whatever the list order says', () => {
    // An operator cannot fix an owner's step by trying harder, and an install
    // with no base URL cannot even ask the server what an owner has granted. So
    // an operator gap outranks an owner gap that comes earlier in the sequence.
    const owner = AGENT_REQUIREMENTS.find((requirement) => requirement.ownerAuthenticated);
    const operator = AGENT_REQUIREMENTS.find((requirement) => !requirement.ownerAuthenticated);
    const step = nextStepFor([
      { ...owner!, state: 'MISSING', evidence: 'test' },
      { ...operator!, state: 'MISSING', evidence: 'test' },
    ]);
    expect(step.actor).toBe('AGENT_OPERATOR');
    expect(step.action).toContain(operator?.title ?? '');
  });

  it('has nothing to say when nothing is outstanding', () => {
    const step = nextStepFor(
      AGENT_REQUIREMENTS.map((requirement) => ({
        ...requirement,
        state: 'SATISFIED' as const,
        evidence: 'test',
      })),
    );
    expect(step).toEqual({ actor: 'NOBODY', action: '' });
  });
});
