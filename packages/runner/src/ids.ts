/**
 * Identifier minting.
 *
 * The idempotency key is the one that matters. It is minted once per logical
 * order intent, written to the store before any request that uses it, and reused
 * verbatim for every replay of that intent — including a replay by a different
 * Runner process after a crash. That is why it is a value the store holds rather
 * than something a request builder generates on the way out.
 */
import { createHash, randomUUID } from 'node:crypto';

export const newJobId = (): string => `job_${randomUUID()}`;
export const newAttemptId = (): string => `att_${randomUUID()}`;
export const newInstanceId = (): string => `run_${randomUUID()}`;

/** One key per logical order intent, never per attempt. */
export const newIdempotencyKey = (): string => randomUUID();

/**
 * A digest standing in for the exact request bytes.
 *
 * The store must be able to prove a replay is byte-identical without holding
 * sponsored transaction bytes or a signature, so it holds this instead. SHA-256
 * over the serialized body; two different bodies cannot present the same digest,
 * and the digest reveals nothing about the body.
 */
export const fingerprintRequest = (body: unknown): string =>
  createHash('sha256')
    .update(typeof body === 'string' ? body : JSON.stringify(body ?? null))
    .digest('hex');
