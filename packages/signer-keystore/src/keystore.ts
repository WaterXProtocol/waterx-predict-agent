/**
 * The file a key sleeps in.
 *
 * scrypt to turn a passphrase into a key, AES-256-GCM to hold the secret under
 * it. The parameters are stored in the file rather than compiled in, so a
 * keystore written today still opens after they are raised — and raising them is
 * expected, which is why `version` is a number and not a comment.
 *
 * A keystore may also hold the key with NO passphrase (`protection: 'NONE'`),
 * which is what the perp agent does with `SUI_PRIVATE_KEY` in a `.env`: the key
 * is at rest in plaintext, and the only thing between it and another program is
 * the file's `0600` mode. It exists because the sealed form needs a person to
 * type a passphrase and a resident `agent` to hold the key, and an unattended
 * host cannot do either (ADR-0020). A plaintext key is NOT the safe default and
 * never becomes one silently: it is written only when asked for by name, it
 * says so in the file, and every surface that reports it says so too.
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

export interface SealedKeystoreFile {
  readonly version: number;
  readonly address: string;
  /** Absent in files written before plaintext existed; they are all sealed. */
  readonly protection?: 'SCRYPT_AES_GCM';
  readonly kdf: { readonly name: 'scrypt'; readonly N: number; readonly r: number; readonly p: number };
  readonly saltBase64: string;
  readonly ivBase64: string;
  readonly tagBase64: string;
  readonly cipherBase64: string;
}

/** A key at rest in plaintext, protected by the file mode alone. */
export interface PlainKeystoreFile {
  readonly version: number;
  readonly address: string;
  readonly protection: 'NONE';
  readonly secretBase64: string;
  /** Written into the file so nobody has to infer it from a missing field. */
  readonly warning: string;
}

export type KeystoreFile = SealedKeystoreFile | PlainKeystoreFile;

export const PLAINTEXT_WARNING =
  'This key is stored in plaintext. Anything running as this user can read it. It was written by `init --no-passphrase`.';

/** True when the file holds its key in plaintext. */
export const isPlainKeystore = (file: unknown): file is PlainKeystoreFile =>
  (file as Partial<PlainKeystoreFile> | null)?.protection === 'NONE';

export class KeystoreError extends Error {
  override readonly name = 'KeystoreError';
}

const derive = (passphrase: string, salt: Buffer, kdf: SealedKeystoreFile['kdf']): Buffer =>
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
  readonly kdf?: SealedKeystoreFile['kdf'];
}): SealedKeystoreFile => {
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
    // Stated, so telling the two apart never depends on a missing field.
    protection: 'SCRYPT_AES_GCM',
    kdf,
    saltBase64: salt.toString('base64'),
    ivBase64: iv.toString('base64'),
    tagBase64: cipher.getAuthTag().toString('base64'),
    cipherBase64: cipherText.toString('base64'),
  };
};

/** Writes a key with no passphrase — the perp agent's posture, stated (ADR-0020). */
export const plainKeystore = (input: { readonly secretKey: Uint8Array; readonly address: string }): PlainKeystoreFile => ({
  version: KEYSTORE_VERSION,
  address: input.address,
  protection: 'NONE',
  secretBase64: Buffer.from(input.secretKey).toString('base64'),
  warning: PLAINTEXT_WARNING,
});

/**
 * Opens one, or refuses.
 *
 * A wrong passphrase and a tampered file produce the same refusal on purpose;
 * see the header.
 */
export const openKeystore = (file: unknown, passphrase: string): Uint8Array => {
  // One loose shape for both variants: the fields are checked below, and an
  // intersection of the two would collapse `protection` to `never`.
  const store = file as Partial<Omit<SealedKeystoreFile, 'protection'> & Omit<PlainKeystoreFile, 'protection'>>;
  if (store.version !== KEYSTORE_VERSION) {
    throw new KeystoreError(
      `keystore version ${String(store.version)} is not supported by this build (expected ${String(KEYSTORE_VERSION)})`,
    );
  }
  if (isPlainKeystore(file)) {
    // No passphrase to check: the file mode is the whole protection.
    if (typeof store.secretBase64 !== 'string' || store.secretBase64 === '') {
      throw new KeystoreError('the keystore is missing secretBase64');
    }
    return Uint8Array.from(Buffer.from(store.secretBase64, 'base64'));
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
