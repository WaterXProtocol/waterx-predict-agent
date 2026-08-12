/**
 * The published form of the command contract.
 *
 * `schemas/v1/agent-commands.json` is generated from this and committed, so a
 * non-TypeScript adapter can read the contract without running the toolchain,
 * and so a change to a command input shows up as a reviewable diff in the same
 * commit as the code change. A test re-generates and compares, which is what
 * makes the committed file evidence rather than decoration.
 */
import {
  AGENT_COMMANDS,
  AGENT_COMMAND_SCHEMA_VERSION,
  COMMAND_SCHEMA_DEFS,
  type AgentCommandSpec,
} from './commands.ts';
import { assertSupportedSchema, type JsonSchema } from './json-schema.ts';

/**
 * A URN, not an https URL: nothing is hosted at a URL today, and a `$id` that
 * 404s invites a tool to try to fetch it.
 */
export const COMMAND_DOCUMENT_ID = `urn:waterx:predict:agent-commands:v${AGENT_COMMAND_SCHEMA_VERSION}`;

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

export interface CommandDocumentEntry {
  readonly name: string;
  readonly cli: string;
  readonly summary: string;
  readonly description: string;
  readonly classification: AgentCommandSpec['classification'];
  readonly sideEffects: AgentCommandSpec['sideEffects'];
  readonly longRunning: boolean;
  readonly idempotency: AgentCommandSpec['idempotency'];
  readonly confirmation: AgentCommandSpec['confirmation'];
  readonly implementation: AgentCommandSpec['implementation'];
  readonly input: JsonSchema;
  readonly examples: readonly AgentCommandExampleEntry[];
}

export interface AgentCommandExampleEntry {
  readonly title: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface CommandDocument {
  readonly $schema: string;
  readonly $id: string;
  readonly title: string;
  readonly description: string;
  /** Bumped only for a breaking change. Adding a command is not breaking. */
  readonly schemaVersion: string;
  readonly $defs: Readonly<Record<string, JsonSchema>>;
  readonly commands: readonly CommandDocumentEntry[];
}

const DOCUMENT_DESCRIPTION = [
  'The commands a WaterX Predict agent host may issue, and the exact input each one accepts.',
  'Every surface — CLI, MCP or any other function adapter — validates against this document and compiles to the same SDK call, so the same intent cannot mean two different things depending on the host.',
  'Money, prices and sizes are decimal STRINGS. A JSON number cannot hold them exactly.',
].join(' ');

function toEntry(command: AgentCommandSpec): CommandDocumentEntry {
  return {
    name: command.name,
    cli: command.cli,
    summary: command.summary,
    description: command.description,
    classification: command.classification,
    sideEffects: command.sideEffects,
    longRunning: command.longRunning,
    idempotency: command.idempotency,
    confirmation: command.confirmation,
    implementation: command.implementation,
    input: command.input,
    examples: command.examples.map((example) => ({ title: example.title, input: example.input })),
  };
}

/**
 * Build the document, asserting on the way out that every command input is
 * inside the subset this repository's validator can actually enforce.
 *
 * The assertion belongs here rather than only in a test: generation is the last
 * point at which a schema the validator would silently under-enforce can be
 * stopped from being published.
 */
export function buildCommandDocument(): CommandDocument {
  const commands = AGENT_COMMANDS.map(toEntry);
  for (const command of commands) {
    assertSupportedSchema(command.input, COMMAND_SCHEMA_DEFS);
  }
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: COMMAND_DOCUMENT_ID,
    title: 'WaterX Predict agent command contract',
    description: DOCUMENT_DESCRIPTION,
    schemaVersion: AGENT_COMMAND_SCHEMA_VERSION,
    $defs: COMMAND_SCHEMA_DEFS,
    commands,
  };
}

/**
 * Serialize deterministically: same input, same bytes, always.
 *
 * Key order comes from construction order rather than sorting, so the emitted
 * document reads in the order the fields were designed in. The trailing newline
 * keeps the committed artifact POSIX-clean and diff-friendly.
 */
export function serializeCommandDocument(document: CommandDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
