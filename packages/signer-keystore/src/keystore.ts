/**
 * The file a key sleeps in.
 *
 * scrypt to turn a passphrase into a key, AES-256-GCM to hold the secret under
 * it. The parameters are stored in the file rather than compiled in, so a
 * keystore written today still opens after they are raised — and raising them is
 * expected, which is why `version` is a number and not a comment.
 *
 * What this format deliberately does NOT do is authenticate the passphrase
 * separately. GCM's tag is the check: a wrong passphrase derives a wrong key and
 * the tag fails, which is indistinguishable from a corrupted file — and that is
 * correct, because a format that could tell them apart would tell an attacker
 * when they had guessed right about everything except the passphrase.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const KEYSTORE_VERSION = 1;

/**
 * Deliberately expensive. scrypt's cost is the only thing standing between a
 * stolen file and the key inside it, so this is sized to hurt a GPU rather than
 * to keep `agent` start-up snappy — it runs once per unlock.
 */
export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1, keyLength: 32 } as const;

export interface KeystoreFile {
  readonly version: number;
  readonly address: string;
  readonly kdf: { readonly name: 'scrypt'; readonly N: number; readonly r: number; readonly p: number };
  readonly saltBase64: string;
  readonly ivBase64: string;
  readonly tagBase64: string;
  readonly cipherBase64: string;
}

export class KeystoreError extends Error {
  override readonly name = 'KeystoreError';
}

const derive = (passphrase: string, salt: Buffer, kdf: KeystoreFile['kdf']): Buffer =>
  scryptSync(passphrase, salt, DEFAULT_KDF.keyLength, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    // scrypt needs headroom proportional to N·r; the default cap refuses N=2^17.
    maxmem: 512 * 1024 * 1024,
  });

/** Wraps a secret key for storage. The plaintext never leaves this call. */
export const sealKeystore = (input: {
  readonly secretKey: Uint8Array;
  readonly address: string;
  readonly passphrase: string;
  readonly kdf?: KeystoreFile['kdf'];
}): KeystoreFile => {
  if (input.passphrase.length < 8) {
    throw new KeystoreError('the passphrase must be at least 8 characters');
  }
  const kdf = input.kdf ?? { name: 'scrypt', N: DEFAULT_KDF.N, r: DEFAULT_KDF.r, p: DEFAULT_KDF.p };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(input.passphrase, salt, kdf), iv);
  const cipherText = Buffer.concat([cipher.update(Buffer.from(input.secretKey)), cipher.final()]);
  return {
    version: KEYSTORE_VERSION,
    address: input.address,
    kdf,
    saltBase64: salt.toString('base64'),
    ivBase64: iv.toString('base64'),
    tagBase64: cipher.getAuthTag().toString('base64'),
    cipherBase64: cipherText.toString('base64'),
  };
};

/**
 * Opens one, or refuses.
 *
 * A wrong passphrase and a tampered file produce the same refusal on purpose;
 * see the header.
 */
export const openKeystore = (file: unknown, passphrase: string): Uint8Array => {
  const store = file as Partial<KeystoreFile>;
  if (store.version !== KEYSTORE_VERSION) {
    throw new KeystoreError(
      `keystore version ${String(store.version)} is not supported by this build (expected ${String(KEYSTORE_VERSION)})`,
    );
  }
  if (store.kdf?.name !== 'scrypt') throw new KeystoreError('unsupported key derivation');
  for (const field of ['saltBase64', 'ivBase64', 'tagBase64', 'cipherBase64'] as const) {
    if (typeof store[field] !== 'string' || store[field] === '') {
      throw new KeystoreError(`the keystore is missing ${field}`);
    }
  }
  const key = derive(passphrase, Buffer.from(store.saltBase64 as string, 'base64'), store.kdf);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(store.ivBase64 as string, 'base64'));
  decipher.setAuthTag(Buffer.from(store.tagBase64 as string, 'base64'));
  try {
    return Uint8Array.from(
      Buffer.concat([decipher.update(Buffer.from(store.cipherBase64 as string, 'base64')), decipher.final()]),
    );
  } catch {
    throw new KeystoreError('the keystore did not open: wrong passphrase, or the file has been altered');
  }
};

/** Constant-time, because this compares a bearer token on every request. */
export const tokensMatch = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};
