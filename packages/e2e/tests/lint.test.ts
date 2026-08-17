/**
 * The linter that would have caught the defect it was written for.
 *
 * `order reconcile --execution-id <id>` was a real recovery instruction this CLI
 * printed, and it exits USAGE — so the one command a caller runs while holding
 * an order of unknown outcome did not run. The first test below is that exact
 * string.
 */
import { extractInvocations, lintInvocation, resolveCliPath } from '../src/lint.ts';

describe('lintInvocation', () => {
  it('catches the flag spelling that broke the ambiguous-write recovery', () => {
    // Hyphenated, as it was printed. Flags are named after SCHEMA FIELDS, which
    // are camelCase, so this one is not a field of anything.
    const violations = lintInvocation(['order', 'reconcile', '--execution-id', 'exec-1']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('UNKNOWN_FLAG');
    // The message has to say what to write instead, or it just relocates the
    // confusion.
    expect(violations[0]?.message).toContain('--executionId');
  });

  it('passes the corrected spelling', () => {
    expect(lintInvocation(['order', 'reconcile', '--executionId', 'exec-1'])).toEqual([]);
  });

  it('rejects a command that is not in the contract', () => {
    const violations = lintInvocation(['order', 'cancel', '--executionId', 'exec-1']);
    expect(violations[0]?.kind).toBe('UNKNOWN_COMMAND');
  });

  it('resolves the two-word path before the one-word one', () => {
    expect(resolveCliPath(['market', 'get'])?.cli).toBe('market get');
    expect(resolveCliPath(['describe'])?.cli).toBe('describe');
    expect(resolveCliPath(['market', 'invent'])).toBeUndefined();
  });

  it('refuses a structured field as a flag, and says how to pass it', () => {
    // `size` is an object. A flag cannot carry one, and a caller who tries gets
    // a type error at runtime rather than a coercion.
    const violations = lintInvocation(['market', 'quote', '--size', '1']);
    expect(violations[0]?.kind).toBe('STRUCTURED_FLAG');
    expect(violations[0]?.message).toContain("--input '<json>'");
  });

  it('allows the global flags, which belong to no command in particular', () => {
    expect(
      lintInvocation(['order', 'reconcile', '--executionId', 'e', '--timeout-ms', '5000', '--json']),
    ).toEqual([]);
  });

  it('does not check values, which the schema owns at runtime', () => {
    // A lint that needed real ids could not run before provisioning — which is
    // exactly when the documentation is most likely to be wrong.
    expect(lintInvocation(['market', 'get', '--marketId', '$MARKET_ID'])).toEqual([]);
  });
});

describe('extractInvocations', () => {
  it('finds an invocation inside a command substitution', () => {
    expect(extractInvocations('id="$(waterx-predict market list --limit 5)"')).toEqual([
      ['market', 'list', '--limit', '5'],
    ]);
  });

  it('finds every invocation on a line, not just the first', () => {
    const found = extractInvocations(
      'waterx-predict market get --marketId "$(waterx-predict market search --search x)"',
    );
    expect(found).toHaveLength(2);
    expect(found[1]).toEqual(['market', 'search', '--search', 'x']);
  });

  it('joins a backslash continuation, because a wrapped example is one command', () => {
    expect(
      extractInvocations('waterx-predict order reconcile \\\n  --executionId exec-1\n'),
    ).toEqual([['order', 'reconcile', '--executionId', 'exec-1']]);
  });

  it('reads an invocation out of a comment', () => {
    expect(extractInvocations('# waterx-predict doctor --accountId 0x1')).toEqual([
      ['doctor', '--accountId', '0x1'],
    ]);
  });

  it('reads a recovery instruction quoted inside another command', () => {
    // This is the shape a printed instruction actually takes — and the shape the
    // original defect took. A linter that skipped it would miss the case it
    // exists for.
    expect(extractInvocations('say "  waterx-predict order reconcile --executionId $ID"')).toEqual([
      ['order', 'reconcile', '--executionId', '$ID'],
    ]);
  });

  it('stops at a shell operator, which begins a different command', () => {
    expect(extractInvocations('waterx-predict describe | jq .data')).toEqual([['describe']]);
    expect(extractInvocations('waterx-predict describe 2>/dev/null')).toEqual([['describe']]);
  });

  it('ignores an invocation whose command path is computed', () => {
    // `try() { OUT="$(waterx-predict "$@")"; }` names no command statically, and
    // inventing a violation about `$@` would be noise.
    expect(extractInvocations('OUT="$(waterx-predict "$@" 2>/dev/null)"')).toEqual([]);
  });

  it('finds nothing in prose that merely mentions the name', () => {
    expect(extractInvocations('The waterx-predict binary is installed.')).toEqual([]);
    expect(extractInvocations('Run waterx-predict to see what it can do.')).toEqual([]);
  });

  it('still yields a wrong SUBCOMMAND under a real root, so the typo is caught', () => {
    const found = extractInvocations('waterx-predict order cancel --executionId exec-1');
    expect(found).toEqual([['order', 'cancel', '--executionId', 'exec-1']]);
    expect(lintInvocation(found[0] ?? [])[0]?.kind).toBe('UNKNOWN_COMMAND');
  });
});
