/**
 * The job store is one of the four places ADR-0001 §7 names as forbidden to
 * secrets — alongside model context, CLI arguments and logs. The other three are
 * enforced by the CLI's redactor; this is the one for the database.
 *
 * Redaction is the wrong tool here. A redactor needs to know the exact secret
 * to replace it, and the store is handed structured job detail assembled by
 * whatever code path is recovering — the risk is a field nobody thought about,
 * not a token someone registered. So this refuses the write instead: a name that
 * carries key material is rejected, loudly, before it reaches disk.
 */
import { JobStoreError } from './errors.ts';

/**
 * Property names that carry raw secret material. Matched case-insensitively
 * against the normalized (non-alphanumeric-stripped) name, so `private_key`,
 * `privateKey` and `PRIVATE-KEY` are one entry.
 *
 * `signature` and `sponsoredTransactionBytes` are here even though neither is a
 * key: a stored signature over sponsored bytes is a reusable authorization, and
 * a store holding one lets anything that can read the file submit the order.
 */
const FORBIDDEN_KEYS: readonly string[] = [
  'privatekey',
  'secretkey',
  'seedphrase',
  'mnemonic',
  'keypair',
  'signature',
  'signedbytes',
  'sponsoredtransactionbytes',
  'transactionbytes',
  'accesstoken',
  'authtoken',
  'bearertoken',
  'sessiontoken',
  'refreshtoken',
  'authorization',
  'password',
];

const normalize = (key: string): string => key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');

/**
 * Walks a value about to be persisted and throws on a secret-shaped property
 * name. Cycles are tolerated — `JSON.stringify` would throw on one anyway, and
 * this must be the error the caller sees.
 */
export const assertNoSecrets = (value: unknown, path = '$'): void => {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNoSecrets(entry, `${path}[${String(index)}]`);
    });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(normalize(key))) {
      // The message names the path and never the value: an error that quoted the
      // secret to explain why it was refused would have leaked it into the log
      // the refusal exists to keep clean.
      throw new JobStoreError(
        'SECRET_REJECTED',
        `refusing to persist secret-shaped property ${path}.${key} in the job store`,
        { path: `${path}.${key}` },
      );
    }
    assertNoSecrets(entry, `${path}.${key}`);
  }
};

/** Exposed for the test that asserts the list has not silently shrunk. */
export const FORBIDDEN_STORE_KEYS: readonly string[] = FORBIDDEN_KEYS;
