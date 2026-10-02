/**
 * Build identity, as constants rather than a `package.json` import.
 *
 * Importing the manifest would drag `resolveJsonModule` and a fragile relative
 * path through the emitted output; a test asserts these stay in step with the
 * manifest instead, which is the same guarantee with none of the coupling.
 */
export const CLI_NAME = 'waterx-predict';

export const CLI_VERSION = '0.1.0';

/**
 * The API version this build speaks. Not the CLI version and not the command
 * schema version — three separate things that move independently.
 */
export const API_VERSION = 'agent-api/v1';

import { sep } from 'node:path';

/**
 * How a caller would type this CLI themselves, from WHERE the binary is.
 *
 * The first version asked only whether the name was on PATH, and that answers the
 * wrong question. Inside `npx --no waterx-predict next`, npx has put
 * `node_modules/.bin` on PATH — so the lookup succeeds and the bare name was
 * printed, which is exactly the invocation that fails once that process exits.
 * The condition was true at the one moment it needed to be false.
 *
 * The path says it instead: a binary resolved inside a `node_modules/.bin` belongs
 * to a local install and the next command needs `npx --no`. One resolved outside
 * it is on PATH for real, so the bare name works. Unresolvable means not installed
 * under this name at all, and `npx --no` is the form that still works after
 * `npm install`.
 */
export const invocationOf = (resolved: string | null): string =>
  resolved !== null && !resolved.includes(`${sep}node_modules${sep}.bin${sep}`)
    ? CLI_NAME
    : `npx --no ${CLI_NAME}`;
