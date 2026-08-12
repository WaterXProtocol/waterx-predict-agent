/**
 * `@waterx/predict-agent-schema` — the versioned agent command contract.
 *
 * The published artifact is `schemas/v1/agent-commands.json`; this package is
 * the source it is generated from, plus the runtime validator that enforces it.
 * It has no dependency on the SDK, the CLI or any adapter: the contract has to
 * be readable by a surface that cannot import a Node client.
 */
export {
  AGENT_COMMANDS,
  AGENT_COMMAND_SCHEMA_VERSION,
  COMMAND_SCHEMA_DEFS,
  getCommand,
  listCommandNames,
  type AgentCommandClassification,
  type AgentCommandConfirmation,
  type AgentCommandExample,
  type AgentCommandIdempotency,
  type AgentCommandImplementation,
  type AgentCommandSideEffect,
  type AgentCommandSpec,
} from './commands.ts';

export {
  DECIMAL_AMOUNT_PATTERN,
  DECIMAL_SCALE,
  ORDER_INTENT_PROPERTIES,
  ORDER_INTENT_REQUIRED,
  ORDER_INTENT_RULES,
  POSITIVE_DECIMAL_AMOUNT_PATTERN,
  PROBABILITY_PRICE_PATTERN,
  SUI_ADDRESS_PATTERN,
} from './defs.ts';

export {
  buildCommandDocument,
  serializeCommandDocument,
  COMMAND_DOCUMENT_ID,
  JSON_SCHEMA_DIALECT,
  type AgentCommandExampleEntry,
  type CommandDocument,
  type CommandDocumentEntry,
} from './document.ts';

export {
  assertSupportedSchema,
  formatViolations,
  validateAgainstSchema,
  type JsonSchema,
  type JsonSchemaScalar,
  type JsonSchemaType,
  type SchemaViolation,
} from './json-schema.ts';

export {
  assertValidCommandInput,
  validateCommandInput,
  type CommandValidationFailure,
  type CommandValidationResult,
  type CommandValidationSuccess,
} from './validate.ts';
