/**
 * `command-schema` — the machine-readable half of discovery.
 *
 * Emits the same versioned document an MCP adapter would turn into tool
 * definitions, so a host does not have to reimplement validation to know what a
 * command accepts.
 *
 * An unknown command name is an ERROR, not an empty result. Returning nothing
 * would let a caller conclude the command exists and takes no input, and then
 * advertise a tool that cannot be called.
 */
import { buildCommandDocument } from '@waterx/predict-agent-schema';

import { CliError } from '../errors.ts';

export function commandSchema(input: Readonly<Record<string, unknown>>): unknown {
  const document = buildCommandDocument();
  const requested = input.command;
  if (requested === undefined) return document;

  const name = String(requested);
  const command = document.commands.find((entry) => entry.name === name);
  if (command === undefined) {
    throw new CliError(
      'UNKNOWN_COMMAND',
      `\`${name}\` is not a command in schema version ${document.schemaVersion}. Known commands: ${document.commands.map((entry) => entry.name).join(', ')}.`,
      { requested: name, schemaVersion: document.schemaVersion },
    );
  }
  // The $defs travel with the command: a caller validating one command's input
  // needs the definitions its `$ref`s point at, and a fragment that references
  // definitions it did not receive is not usable.
  return {
    $schema: document.$schema,
    $id: document.$id,
    schemaVersion: document.schemaVersion,
    $defs: document.$defs,
    commands: [command],
  };
}
