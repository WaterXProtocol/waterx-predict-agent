/**
 * The signer wire contract, as this provider implements it.
 *
 * A third copy of `SIGNER_PROTOCOL`, held equal to the CLI's and the Runner's by
 * `tests/workspace.test.ts` — the same arrangement, for the same reason: three
 * implementations that agree by comment rather than by test are three
 * implementations waiting to disagree about what a key holder was asked to sign.
 */
export const SIGNER_PROTOCOL = {
  version: 1,
  requests: [
    {
      type: 'PERSONAL_MESSAGE',
      fields: ['version', 'type', 'agentWallet', 'messageBase64'],
    },
    {
      type: 'TRANSACTION',
      fields: ['version', 'type', 'agentWallet', 'transactionBytesBase64'],
    },
  ],
  response: { fields: ['signature'] },
} as const;

export type SignerRequest =
  | {
      readonly version: 1;
      readonly type: 'PERSONAL_MESSAGE';
      readonly agentWallet: string;
      readonly messageBase64: string;
    }
  | {
      readonly version: 1;
      readonly type: 'TRANSACTION';
      readonly agentWallet: string;
      /** Sponsored transaction bytes, base64. Never logged and never echoed. */
      readonly transactionBytesBase64: string;
    };

export class SignerRefusal extends Error {
  override readonly name = 'SignerRefusal';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Parses one request, or refuses by name.
 *
 * Refuses an unknown `version` rather than assuming the shape it happens to
 * recognize: the whole point of the field is that a key holder can tell when it
 * is being asked something it was not built to understand.
 */
export const parseRequest = (raw: string): SignerRequest => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SignerRefusal('the request on stdin was not JSON');
  }
  if (!isRecord(value)) throw new SignerRefusal('the request was not an object');
  if (value['version'] !== SIGNER_PROTOCOL.version) {
    throw new SignerRefusal(
      `unsupported request version ${String(value['version'])}; this signer speaks ${String(SIGNER_PROTOCOL.version)}`,
    );
  }
  const wallet = value['agentWallet'];
  if (typeof wallet !== 'string' || wallet === '') {
    throw new SignerRefusal('the request named no agentWallet');
  }
  if (value['type'] === 'PERSONAL_MESSAGE') {
    const message = value['messageBase64'];
    if (typeof message !== 'string' || message === '') {
      throw new SignerRefusal('PERSONAL_MESSAGE carried no messageBase64');
    }
    return { version: 1, type: 'PERSONAL_MESSAGE', agentWallet: wallet, messageBase64: message };
  }
  if (value['type'] === 'TRANSACTION') {
    const bytes = value['transactionBytesBase64'];
    if (typeof bytes !== 'string' || bytes === '') {
      throw new SignerRefusal('TRANSACTION carried no transactionBytesBase64');
    }
    return {
      version: 1,
      type: 'TRANSACTION',
      agentWallet: wallet,
      transactionBytesBase64: bytes,
    };
  }
  throw new SignerRefusal(`unknown request type ${String(value['type'])}`);
};

/** Two addresses are the same account when they differ only by leading-zero padding. */
export const sameAddress = (a: string, b: string): boolean =>
  a.replace(/^0x0*/u, '').toLowerCase() === b.replace(/^0x0*/u, '').toLowerCase();
