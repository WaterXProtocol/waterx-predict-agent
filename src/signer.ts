/**
 * What this SDK needs from an agent's key, and nothing more.
 *
 * Declared STRUCTURALLY rather than importing `@mysten/sui`: a Sui `Keypair`
 * already satisfies both methods, so passing one just works, while a customer
 * holding their key in a KMS or HSM can implement the interface without this
 * package ever loading a crypto library. That is also why this package has no
 * runtime dependencies — nothing here touches the chain.
 *
 * The agent signs every transaction. WaterX sponsors the gas; it does not and
 * cannot sign on the agent's behalf.
 */

/** The shape `@mysten/sui`'s `signTransaction` returns. */
export interface SignatureWithBytes {
  signature: string;
  bytes: string;
}

export interface AgentSigner {
  /**
   * Sign the sponsored transaction bytes the API returned.
   *
   * Takes raw bytes rather than base64 so a `Keypair` matches without an adapter;
   * the client decodes the base64 for you.
   */
  signTransaction(bytes: Uint8Array): Promise<SignatureWithBytes>;
  /**
   * Sign the login challenge as a PERSONAL MESSAGE.
   *
   * Deliberately separate from `signTransaction`, and not interchangeable with
   * it: Sui prefixes the signed bytes with an intent, and a personal message
   * (scope 3) and a transaction (scope 0) hash differently. The server verifies
   * the challenge with `verifyPersonalMessageSignature`, so signing it as a
   * transaction produces a valid signature over the wrong bytes and every login
   * is rejected. A `Keypair` implements both, so this costs an implementer
   * nothing; a KMS-backed signer must route it to its personal-message path.
   */
  signPersonalMessage(bytes: Uint8Array): Promise<SignatureWithBytes>;
  /** The address the signature must resolve to — the API checks it server-side. */
  toSuiAddress(): string;
}

/**
 * The message an agent signs to open a session. The format is fixed server-side
 * and the wallet and timestamp inside it are re-derived and compared, so a
 * captured signature cannot be replayed against another wallet.
 *
 * The wording says "Bucket Agent" because the challenge is issued by the shared
 * agent-auth service, not by Predict. Do not "correct" it — the server matches
 * this exact string.
 */
export function buildAuthMessage(walletAddress: string, timestamp: number): string {
  return `Sign in to Bucket Agent\nWallet: ${walletAddress}\nTimestamp: ${String(timestamp)}`;
}

/** Signs bytes given as base64, which is how the API hands them over. */
export async function signBase64(signer: AgentSigner, base64: string): Promise<string> {
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  const { signature } = await signer.signTransaction(bytes);
  return signature;
}
