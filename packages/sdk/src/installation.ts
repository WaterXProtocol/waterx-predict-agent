/**
 * What this installation is, and what it still needs — locally, offline, and
 * before anything has been configured.
 *
 * The first question a caller has after `npm install` is the one no surface
 * could answer for them: what now? The CLI answers it with `describe` and
 * `doctor`, and the CLI is not published. So the answer has to come from the
 * package that actually installs, and it has to work with nothing set up at
 * all — which means no network, no session, no signer and no configuration
 * file. Everything here reads the environment and the filesystem beside this
 * module, and issues no request.
 *
 * That constraint is also the safety property. This module cannot trade: it
 * constructs no client, imports none of the transport, and has nothing to
 * authenticate with. A discovery entry point that could place an order would be
 * a second trading surface, which is exactly what `NO_SECOND_SURFACE` forbids —
 * so `tests/workspace.test.ts` fails if this file or the binary over it ever
 * reaches for one.
 *
 * What it deliberately does NOT do is guess. Three requirements are knowable
 * from the environment; three are behind an authenticated read and are reported
 * `UNCHECKED` rather than assumed either way.
 *
 * Two things a user might expect to be asked for are absent by design: the API
 * hostname, which the SDK ships, and the account id, which the server answers
 * for. Either one appearing here as a thing to supply would be the friction the
 * onboarding work exists to have removed.
 */
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OnboardingActor } from './onboarding.ts';
import {
  AGENT_REQUIREMENTS,
  nextStepFor,
  type RequirementId,
  type ResolvedRequirement,
} from './provisioning.ts';

/** The package this module was loaded from, when it can be established. */
export interface InstallationPackage {
  readonly name: string;
  readonly version: string;
  /** Absolute path to the package root — where the shipped documents live. */
  readonly root: string;
}

/**
 * A surface, and whether this machine has it.
 *
 * `IDENTIFY_YOUR_SURFACE_BEFORE_THE_FIRST_COMMAND` asks a reader to establish
 * which surface they hold rather than assume it. This answers that question
 * instead of restating it, because an agent asked to check its own PATH will
 * either guess or shell out, and one of those is worse than the other.
 */
export interface SurfaceAvailability {
  readonly id: 'sdk' | 'cli' | 'runner';
  readonly package: string;
  readonly provides: string;
  readonly present: boolean | undefined;
  readonly detail: string;
}

export interface InstallationReport {
  /** Undefined when this module was bundled and no manifest sits above it. */
  readonly package: InstallationPackage | undefined;
  /** The shipped rules, if they are on disk. Read them before the first order. */
  readonly instructionsPath: string | undefined;
  readonly surfaces: readonly SurfaceAvailability[];
  readonly requirements: readonly ResolvedRequirement[];
  /** Nothing supplies these, and nothing will until someone does. */
  readonly missing: readonly ResolvedRequirement[];
  /** Not evaluated here, and not to be reported as missing. */
  readonly unchecked: readonly ResolvedRequirement[];
  readonly nextStep: { actor: OnboardingActor; action: string };
}

export interface DescribeInstallationOptions {
  /** Defaults to `process.env`. Passing one makes the report testable. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Requirements this caller supplies in code rather than through the
   * environment — a `baseUrl` and a `signer` handed to the constructor, say.
   *
   * Without it a library caller who configured everything correctly reads
   * `MISSING` for all of it, concludes the report is broken, and stops reading
   * the part that was right.
   */
  readonly supplied?: Partial<Record<RequirementId, boolean>>;
}

/**
 * This package's own name, which `locatePackage` requires a manifest to claim.
 *
 * Without it, a build that inlined this module into an application would find
 * that application's manifest one directory up and report its name, its version
 * and an `AGENT_INSTRUCTIONS.md` belonging to somebody else. `undefined` is the
 * honest answer there, and the test pins this string to the manifest so a
 * rename fails rather than silently reporting nothing.
 */
const PACKAGE_NAME = '@waterx/predict-agent-sdk';

/**
 * Environment variables that settle a requirement, matching the CLI's names.
 *
 * A list per requirement, because `deployment` has two spellings and they are
 * the same fact: naming the network is the normal one, and a URL is what a
 * private deployment has instead of a name. Either settles it.
 */
const ENV_KEYS: Partial<Record<RequirementId, readonly string[]>> = {
  deployment: ['WATERX_PREDICT_ENVIRONMENT', 'WATERX_PREDICT_BASE_URL'],
  agentWallet: ['WATERX_PREDICT_AGENT_WALLET'],
  signer: ['WATERX_PREDICT_SIGNER_COMMAND'],
};

/**
 * The package root: walk up from this module until a manifest claims THIS name.
 *
 * From `dist/src/` and from `src/` alike, which is the point — a path built by
 * counting directories works in a build and not in a test, or the reverse, and
 * whichever one it fails in is the one nobody runs before shipping.
 *
 * The name check is what makes the walk safe to run anywhere: the first manifest
 * above this module is not necessarily this package's.
 */
function locatePackage(fromUrl: string): InstallationPackage | undefined {
  let directory = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };
        if (manifest.name === PACKAGE_NAME && typeof manifest.version === 'string') {
          return { name: manifest.name, version: manifest.version, root: directory };
        }
      } catch {
        // An unreadable or malformed manifest is not this module's problem to
        // report. Keep walking; the answer is `undefined` if none is found.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/** Is an executable reachable on PATH? `undefined` when there is no PATH to read. */
function onPath(executable: string, env: Readonly<Record<string, string | undefined>>): boolean | undefined {
  const raw = env.PATH ?? env.Path;
  if (raw === undefined) return undefined;
  for (const directory of raw.split(delimiter)) {
    if (directory === '') continue;
    try {
      accessSync(join(directory, executable), constants.X_OK);
      return true;
    } catch {
      // Not here. The next entry, or `false` once the list runs out.
    }
  }
  return false;
}

const surfaceDetail = (present: boolean | undefined, absent: string, found: string): string => {
  if (present === undefined) return 'No PATH is set, so this could not be established.';
  return present ? found : absent;
};

/**
 * Everything this installation can say about itself without asking anyone.
 *
 * Safe to call before configuration, before authentication and inside a
 * sandbox: it opens no socket and spawns no process.
 */
export function describeInstallation(
  options: DescribeInstallationOptions = {},
): InstallationReport {
  const env = options.env ?? process.env;
  const supplied = options.supplied ?? {};
  const located = locatePackage(import.meta.url);

  const instructions =
    located === undefined ? undefined : join(located.root, 'AGENT_INSTRUCTIONS.md');
  const instructionsPath =
    instructions !== undefined && existsSync(instructions) ? instructions : undefined;

  const requirements: ResolvedRequirement[] = AGENT_REQUIREMENTS.map((requirement) => {
    if (requirement.ownerAuthenticated) {
      return {
        ...requirement,
        state: 'UNCHECKED',
        evidence: 'Not evaluated: settling it needs an authenticated read, and this report issues none.',
        unresolved:
          'Run `waterx-predict onboard`, or call listAuthorizedAccounts() on a client that has authenticated.',
      };
    }
    if (supplied[requirement.id] === true) {
      return {
        ...requirement,
        state: 'SATISFIED',
        evidence: 'Declared by the caller as supplied in code.',
      };
    }
    const keys = ENV_KEYS[requirement.id] ?? [];
    const set = keys.find((key) => {
      const value = env[key];
      return typeof value === 'string' && value.length > 0;
    });
    if (set !== undefined) {
      // The value itself is never echoed. None of these is a secret today, and a
      // report that prints configuration by habit is one signer path away from
      // printing something that is (`NEVER_ECHO_A_SECRET`).
      return { ...requirement, state: 'SATISFIED', evidence: `${set} is set.` };
    }
    return {
      ...requirement,
      state: 'MISSING',
      evidence:
        keys.length === 0
          ? 'It is not set, and the caller declared nothing.'
          : `Neither ${keys.join(' nor ')} is set, and the caller declared nothing.`,
    };
  });

  const cli = onPath('waterx-predict', env);
  const surfaces: readonly SurfaceAvailability[] = [
    {
      id: 'sdk',
      package: '@waterx/predict-agent-sdk',
      provides: 'Reads, quotes, protected market orders and the onboarding poll, as method calls.',
      present: true,
      detail: 'You are running it.',
    },
    {
      id: 'cli',
      package: '@waterx/predict-agent-cli',
      provides:
        'The command surface: discovery, `doctor`, `onboard`, `order preview`, and the approval a write needs under the default policy.',
      present: cli,
      detail: surfaceDetail(
        cli,
        '`waterx-predict` is not on PATH. Composed commands and the approval flow are out of reach from here; report that rather than assembling an order yourself.',
        '`waterx-predict` is on PATH.',
      ),
    },
    {
      id: 'runner',
      package: '@waterx/predict-agent-runner',
      provides: 'The durable `strategy.*` jobs — a local process that watches a price and acts.',
      // Never `false`. A Runner is a running process behind a local socket,
      // not a binary on PATH, and this report has no way to ask it. Saying
      // absent because nothing was found is how a live strategy gets reported
      // as unwatched — the opposite mistake to the one `driving: false` exists
      // to prevent, and just as expensive.
      present: undefined,
      detail:
        'Not established here: a Runner is a process behind a local socket, and nothing in this report asks it. Nothing here starts or supervises one either, and a strategy only progresses while one is running on this device.',
    },
  ];

  const missing = requirements.filter((requirement) => requirement.state === 'MISSING');
  const unchecked = requirements.filter((requirement) => requirement.state === 'UNCHECKED');

  return {
    package: located,
    instructionsPath,
    surfaces,
    requirements,
    missing,
    unchecked,
    nextStep: nextStepFor(requirements),
  };
}
