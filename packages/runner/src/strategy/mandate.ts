/**
 * The identity of a mandate, for the cumulative budget committed against it.
 *
 * A digest of the authority rather than a name, for the reason the CLI digests
 * its scope (`packages/cli/src/policy.ts`): the total belongs to the exact
 * authority that was in force, so a mandate an operator has since rewritten —
 * a different ceiling, a later expiry, another source — starts its own budget
 * rather than inheriting a total it was never measured against.
 *
 * The fields are listed rather than handed to `JSON.stringify` whole, so the
 * digest is a function of the mandate and not of the order its keys happened to
 * be written in.
 */
import { createHash } from 'node:crypto';

import type { JobPolicySnapshot } from '../job.ts';

export const mandateDigest = (policy: JobPolicySnapshot): string => {
  const identity = JSON.stringify([
    policy.mode,
    policy.source,
    policy.maxOrderNotional ?? null,
    policy.maxRunNotional ?? null,
    policy.notAfter ?? null,
  ]);
  return `mandate1_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
};
