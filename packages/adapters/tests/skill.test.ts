/**
 * The skill.
 *
 * Two failure modes are worth testing and they pull in opposite directions. A
 * skill that cites a rule which no longer exists sends a reader nowhere; a
 * skill that restates the rules becomes a second copy, and the copy a host
 * loaded is the one nobody re-reads. So: every citation must resolve, and the
 * document must stay markedly smaller than the one it routes to.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildAgentInstructions, renderAgentInstructions } from '../src/instructions.ts';
import { AGENT_SKILL_VERSION, buildAgentSkill, renderAgentSkill } from '../src/skill.ts';

const COMMITTED = fileURLToPath(new URL('../../../agent-instructions/SKILL.md', import.meta.url));
/** The copy `@waterx/predict-agent-sdk` ships in its tarball. */
const SHIPPED = fileURLToPath(new URL('../../sdk/SKILL.md', import.meta.url));

const skill = buildAgentSkill();
const ruleIds = new Set(
  buildAgentInstructions().sections.flatMap((section) => section.rules.map((rule) => rule.id)),
);

describe('the skill document', () => {
  it('cites only rules that exist', () => {
    // The whole design is that this document routes rather than restates. A
    // citation that resolves to nothing is worse than no citation: a reader
    // told to consult `SIZE_AMBIGUITY_STOPS_BEFORE_A_WRITE` and unable to find
    // it concludes the rule was withdrawn.
    for (const stop of skill.stops) expect(ruleIds, stop.rule).toContain(stop.rule);
  });

  it('gives every step a unique, symbolic id', () => {
    const ids = skill.steps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[A-Z][A-Z0-9_]*$/u);
    for (const step of skill.steps) expect(step.body.length, step.id).toBeGreaterThan(0);
  });

  it('stays a route rather than becoming a second copy of the rules', () => {
    // Not a style preference. The instructions are the tested, versioned,
    // shipped document; anything restated here is a duplicate that will
    // disagree with them the first time one of the two is edited. Half the
    // length is a generous ceiling — the point is that it cannot quietly grow
    // into a rulebook without failing.
    expect(renderAgentSkill().length).toBeLessThan(renderAgentInstructions().length / 2);
  });

  it('opens with frontmatter a host can parse', () => {
    const text = renderAgentSkill();
    const lines = text.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines[1]).toBe(`name: ${skill.name}`);
    // One line. A wrapped description is a parse difference between hosts, and
    // this field is the only thing deciding whether the skill loads at all.
    expect(lines[2]).toBe(`description: ${skill.description}`);
    expect(lines[3]).toBe('---');
    expect(skill.description).not.toContain('\n');
  });

  it('carries the words someone would actually say', () => {
    // The description is the trigger. A user asks to install the thing and
    // place a bet; if those words are absent, a host never selects this skill
    // and every rule behind it is unreachable however well written.
    const description = skill.description.toLowerCase();
    for (const trigger of ['install', 'bet', 'prediction market', 'waterx predict', 'order']) {
      expect(description, trigger).toContain(trigger);
    }
  });

  it('says where the flow stops rather than promising the order', () => {
    // Under the default policy a write through a tool adapter is refused, by
    // design. A skill that read as "and then it places the bet" would set every
    // user up to meet POLICY_DENIED as a fault instead of as the control it is.
    const text = renderAgentSkill();
    expect(text).toContain('POLICY_DENIED');
    expect(text).toContain('APPROVAL_IS_PER_INTENT_AND_OPERATOR_HELD');
    expect(text).toContain('previewed order they can approve IS the completed task');
  });

  it('sends a reader to the shipped rules by their installed path', () => {
    // A path relative to this repository is unusable to the reader this
    // document is for: they have a `node_modules` directory and no checkout.
    expect(renderAgentSkill()).toContain(
      'node_modules/@waterx/predict-agent-sdk/AGENT_INSTRUCTIONS.md',
    );
  });

  it('renders deterministically and matches both committed copies', () => {
    const rendered = renderAgentSkill();
    expect(rendered).toBe(renderAgentSkill());
    expect(rendered).toContain(`Skill version ${AGENT_SKILL_VERSION}`);
    expect(readFileSync(COMMITTED, 'utf8')).toBe(rendered);
    expect(readFileSync(SHIPPED, 'utf8')).toBe(rendered);
  });
});

describe('what the skill claims is installed', () => {
  it('never promises a package the SDK does not depend on', () => {
    // The SDK's only runtime dependency is `socket.io-client`, so
    // `node_modules/@waterx/predict-agent-schema/` is absent for anyone who
    // installed the SDK alone. The skill sent them there twice as though it
    // were there — the exact failure `A_SURFACE_YOU_LACK_IS_NOT_A_CAPABILITY_TO_REBUILD`
    // is about, committed by the document that teaches it.
    const text = renderAgentSkill();
    const mentions = text.split('@waterx/predict-agent-schema').length - 1;
    if (mentions > 0) {
      expect(text).toMatch(/does not depend on it|only if you installed it/u);
    }
    // The path form is the dangerous one: it reads as a file that is there.
    for (const line of text.split('\n')) {
      if (!line.includes('node_modules/@waterx/predict-agent-schema')) continue;
      expect(line).toMatch(/only if you installed it|Check before you read it/u);
    }
  });

  it('points a caller at the types it definitely has', () => {
    expect(renderAgentSkill()).toMatch(/`\.d\.ts` IS the contract/u);
  });
});
