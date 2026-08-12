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
