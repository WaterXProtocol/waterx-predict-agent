/**
 * The host-neutral instructions.
 *
 * Prose is hard to test and easy to quietly weaken, so what is asserted here is
 * structure plus the specific sentences that a host would be dangerous without:
 * the ones about size ambiguity, unit confusion, timeout recovery and the
 * unwatched Runner. Each is tied to a rule id, so removing a rule fails a test
 * rather than shortening a document.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AGENT_COMMANDS } from '@waterx/predict-agent-schema';

import {
  AGENT_INSTRUCTIONS_VERSION,
  buildAgentInstructions,
  renderAgentInstructions,
} from '../src/instructions.ts';
import { toolNameFor } from '../src/tools.ts';

const COMMITTED = fileURLToPath(
  new URL('../../../agent-instructions/AGENT_INSTRUCTIONS.md', import.meta.url),
);

const document = buildAgentInstructions();
const ruleIds = document.sections.flatMap((section) => section.rules.map((rule) => rule.id));

describe('the instructions document', () => {
  it('gives every rule a unique, symbolic id', () => {
    // The ids are quotable: an adapter, a review or a refusal can name one.
    // Two rules sharing an id makes that citation ambiguous.
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    for (const id of ruleIds) expect(id, id).toMatch(/^[A-Z][A-Z0-9_]*$/u);
    for (const section of document.sections) {
      expect(section.rules.length, section.id).toBeGreaterThan(0);
      for (const rule of section.rules) expect(rule.body.length, rule.id).toBeGreaterThan(0);
    }
  });

  it('indexes the contract rather than a copy of it', () => {
    expect(document.commands.map((entry) => entry.command)).toEqual(
      AGENT_COMMANDS.map((command) => command.name),
    );
    for (const [index, command] of AGENT_COMMANDS.entries()) {
      const entry = document.commands[index];
      expect(entry?.cli, command.name).toBe(command.cli);
      expect(entry?.tool, command.name).toBe(toolNameFor(command.name));
      expect(entry?.classification, command.name).toBe(command.classification);
    }
  });

  it('covers every rule §6.7 requires', () => {
    // The plan lists what host-neutral instructions must state. This is that
    // list, as ids, so a deleted rule is a failing test and not a paragraph
    // nobody missed.
    for (const id of [
      'DISCOVER_FIRST',
      'MARKET_IDENTITY_IS_SERVER_RESOLVED',
      'ASK_ON_AMBIGUITY',
      'TARGET_DIRECTION',
      'DECIMAL_STRINGS_ONLY',
      'BUY_AMOUNT_AND_SELL_SHARES_ARE_NOT_INTERCHANGEABLE',
      'CATALOG_PRICES_ARE_INDICATIVE',
      'A_QUOTE_IS_SHORT_LIVED',
      'SLIPPAGE_IS_NOT_OPTIONAL',
      'AMBIGUOUS_IS_NOT_FAILED',
      'PARTIAL_SUCCESS_IS_REPORTED_LEG_BY_LEG',
      'SIZE_AMBIGUITY_STOPS_BEFORE_A_WRITE',
      'ACCOUNT_IS_NEVER_INFERRED',
      'NEVER_ECHO_A_SECRET',
    ]) {
      expect(ruleIds, id).toContain(id);
    }
  });

  it('states the decisions that cost money to get wrong', () => {
    const text = renderAgentInstructions();
    // A BUY target is a ceiling and a SELL target is a floor. Read the other
    // way round, the order trades immediately at the worst available price.
    expect(text).toContain('highest executable ask');
    expect(text).toContain('lowest executable bid');
    // The two sizing fields are different units with no conversion.
    expect(text).toContain('`buyAmount`');
    expect(text).toContain('`sellShares`');
    // Decimal strings, never JSON numbers.
    expect(text).toContain('"12.50"');
    // A timeout is unknown, not failed, and is recovered by reading.
    expect(text).toContain('may already have executed');
    expect(text).toContain('Never resubmit under a fresh idempotency key');
    // A stopped Runner is not watching anything.
    expect(text).toContain('driving: false');
    expect(text).toContain('awake and online');
    // Seven days, and no permanent watcher.
    expect(text).toContain('seven days');
    // The multi-order call is not atomic.
    expect(text).toContain('never atomic');
    // The approval is per intent and belongs to an operator.
    expect(text).toContain('is not a credential');
  });

  it('renders deterministically', () => {
    expect(renderAgentInstructions()).toBe(renderAgentInstructions());
    expect(renderAgentInstructions()).toContain(`Instructions version ${AGENT_INSTRUCTIONS_VERSION}`);
  });

  it('matches the committed document byte for byte', () => {
    // The committed Markdown is what a host that cannot run this toolchain
    // reads, and what the MCP adapter returns at `initialize`. Regenerate with
    // `pnpm instructions:generate`.
    expect(readFileSync(COMMITTED, 'utf8')).toBe(renderAgentInstructions());
  });
});
