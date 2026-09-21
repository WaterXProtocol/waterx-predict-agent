/**
 * `waterx-predict configure` — the one command that writes this machine's
 * settings instead of reporting on them.
 *
 * It exists because of a gap two real agent hosts walked into. `next` answered
 * `export WATERX_PREDICT_AGENT_WALLET=…`, which is exactly right for a person at
 * a terminal and impossible for a tool host: every command it runs is its own
 * child process, so a variable it exports dies with the shell that exported it.
 * The host relayed the step to its user and stopped — correct behaviour against
 * advice it could not follow. The setting has to be able to land somewhere that
 * outlives one process, and that is the config file (ADR-0020).
 *
 * WHAT IT MAY WRITE is deliberately two settings: which wallet this runtime
 * claims to be, and which program signs for it. Both are statements about this
 * machine, and neither decides whether money moves.
 *
 * WHAT IT WILL NOT WRITE is the network, the policy and the account. Those three
 * decide whether an order spends real funds on mainnet, and an agent that could
 * set them for its operator would be granting itself the authority ADR-0003 says
 * it must be given (ADR-0017 keeps mainnet read-only until a person says
 * otherwise, and this command is not that person).
 *
 * It sends nothing, signs nothing, and reads no key: the address in a keystore
 * file is public — it is the value an owner grants to.
 */
import { CliError } from '../errors.ts';
import { KEYSTORE_LAYOUT } from '../keystore-probe.ts';
import type { CommandContext } from '../context.ts';

/** The settings this command is allowed to touch. Everything else is a person's. */
const WRITABLE = ['agentWallet', 'signerCommand'] as const;
type Writable = (typeof WRITABLE)[number];

interface Change {
  readonly setting: Writable;
  /** What the file now says. Public values only. */
  readonly value: string | readonly string[];
  readonly status: 'WRITTEN' | 'UNCHANGED' | 'KEPT';
  readonly why: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{64}$/u;

const same = (a: unknown, b: string | readonly string[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export async function runtimeConfigure(context: CommandContext): Promise<unknown> {
  const input = context.input as {
    fromKeystore?: boolean;
    agentWallet?: string;
    signerCommand?: readonly string[];
    replace?: boolean;
  };
  const file = context.configFile;
  if (file === undefined) {
    throw new CliError(
      'NOT_CONFIGURED',
      'This machine has nowhere to keep a config file — no home directory and no WATERX_PREDICT_CONFIG. Set WATERX_PREDICT_CONFIG to a path this user can write, or supply the settings in the environment.',
    );
  }

  const wanted = new Map<Writable, string | readonly string[]>();
  let protection: 'SCRYPT_AES_GCM' | 'NONE' | undefined;

  if (input.fromKeystore === true) {
    if (input.agentWallet !== undefined || input.signerCommand !== undefined) {
      throw new CliError(
        'INVALID_INPUT',
        '`fromKeystore` takes both settings from the keystore, so passing `agentWallet` or `signerCommand` alongside it would say two different things at once. Use one or the other.',
      );
    }
    const probe = context.probeKeystore();
    if (probe === undefined) {
      throw new CliError(
        'NOT_CONFIGURED',
        `A signer other than the keystore is configured, so there is no keystore to take these from. Pass \`agentWallet\` and \`signerCommand\` explicitly instead.`,
      );
    }
    if (probe.keystore.status !== 'PRESENT') {
      throw new CliError(
        'NOT_CONFIGURED',
        `No readable keystore at ${probe.dir}. Create one first: \`npx --no ${KEYSTORE_LAYOUT.command} init\` (or \`init --no-passphrase\` for a key this machine can use unattended).`,
        { dir: probe.dir, status: probe.keystore.status },
      );
    }
    // The address only. This command never opens the keystore, and the address
    // is the public half — it is what the owner's grant names.
    wanted.set('agentWallet', probe.keystore.address);
    wanted.set('signerCommand', [KEYSTORE_LAYOUT.command, 'sign']);
    protection = probe.keystore.protection;
  } else {
    if (input.agentWallet !== undefined) {
      if (!ADDRESS.test(input.agentWallet)) {
        throw new CliError(
          'INVALID_INPUT',
          `\`agentWallet\` must be a 0x-prefixed 32-byte Sui address; got ${input.agentWallet}.`,
        );
      }
      wanted.set('agentWallet', input.agentWallet);
    }
    if (input.signerCommand !== undefined) wanted.set('signerCommand', [...input.signerCommand]);
    if (wanted.size === 0) {
      throw new CliError(
        'INVALID_INPUT',
        `Nothing to write. Pass \`fromKeystore\` to take both settings from the keystore on this machine, or name \`agentWallet\` and \`signerCommand\` yourself. This command writes no other setting: the network, the policy and the account stay the operator's (ADR-0020).`,
      );
    }
  }

  // The file as it stands. Parsed rather than patched textually: a config file
  // is small, and rewriting it whole is how the result can be trusted to be
  // exactly what the next invocation will read.
  const raw = file.read();
  let existing: Record<string, unknown> = {};
  if (raw !== null && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CliError(
        'CONFIG_INVALID',
        `The config file at ${file.path} is not valid JSON, so it cannot be edited safely. Fix or move it aside first.`,
        { file: file.path },
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError('CONFIG_INVALID', `The config file at ${file.path} must be a JSON object.`, {
        file: file.path,
      });
    }
    existing = { ...(parsed as Record<string, unknown>) };
  }

  const changes: Change[] = [];
  const next = { ...existing };
  for (const setting of WRITABLE) {
    const value = wanted.get(setting);
    if (value === undefined) continue;
    const held = existing[setting];
    if (held !== undefined && same(held, value)) {
      changes.push({ setting, value, status: 'UNCHANGED', why: 'The file already said exactly this.' });
      continue;
    }
    if (held !== undefined && input.replace !== true) {
      // A second call must never repoint a working runtime at another wallet by
      // surprise: whoever set this may have meant it.
      changes.push({
        setting,
        value: held as string | readonly string[],
        status: 'KEPT',
        why: `Already set to something else, and \`replace\` was not given. Pass replace to overwrite it with ${JSON.stringify(value)}.`,
      });
      continue;
    }
    next[setting] = value;
    changes.push({ setting, value, status: 'WRITTEN', why: 'Written to the config file.' });
  }

  const written = changes.filter((change) => change.status === 'WRITTEN');
  if (written.length > 0) file.write(`${JSON.stringify(next, null, 2)}\n`);
  // `next` is what reads these back and says what is still missing.
  context.pointTo('waterx-predict next');

  /**
   * A value the environment supplies wins over the file (see `config.ts`), so a
   * write that will be shadowed has to say so — otherwise this answers "written"
   * about a setting the next invocation ignores.
   */
  const shadowed = WRITABLE.filter((setting) => {
    if (!wanted.has(setting)) return false;
    const resolved = setting === 'agentWallet' ? context.config.agentWallet : context.config.signerCommand;
    if (resolved === undefined) return false;
    return !same(existing[setting], resolved) && !same(resolved, wanted.get(setting) as string | readonly string[]);
  });

  return {
    configFile: file.path,
    changes,
    // What the file now holds for these two, whatever this call did.
    settings: {
      agentWallet: next['agentWallet'] ?? null,
      signerCommand: next['signerCommand'] ?? null,
    },
    ...(protection === undefined ? {} : { keystoreProtection: protection }),
    ...(shadowed.length > 0 ? { shadowedByEnvironment: shadowed } : {}),
    notWritten: {
      settings: ['environment', 'network', 'policy', 'defaultAccountId'],
      why: 'These decide whether an order spends real funds, and on which network. They stay the operator’s to set (ADR-0017, ADR-0020).',
    },
    ...(protection === 'NONE'
      ? {
          warning:
            'This keystore holds its key in plaintext, protected by the file mode alone. Keep it to a delegated agent wallet; the account owner’s key belongs somewhere this file cannot reach.',
        }
      : {}),
  };
}
