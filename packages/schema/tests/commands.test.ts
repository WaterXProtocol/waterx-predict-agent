import { AGENT_COMMANDS, COMMAND_SCHEMA_DEFS, getCommand } from '../src/commands.ts';
import { assertSupportedSchema, type JsonSchema } from '../src/json-schema.ts';
import { validateCommandInput } from '../src/validate.ts';

const ACCOUNT_ID = `0x${'11'.repeat(32)}`;
const MARKET_ID = `0x${'22'.repeat(32)}`;
const POSITION_ID = `0x${'33'.repeat(32)}`;
const QUOTE_ID = 'quo_test_0000000000';

/** A valid BUY, spread over in each case so a test states only its own change. */
const BUY = {
  accountId: ACCOUNT_ID,
  marketId: MARKET_ID,
  outcomeId: 'YES',
  side: 'BUY',
  size: { buyAmount: '50' },
  referenceQuoteId: QUOTE_ID,
  maxSlippageBps: 100,
} as const;

const SELL = {
  ...BUY,
  side: 'SELL',
  size: { sellShares: '100' },
  positionId: POSITION_ID,
} as const;

function reject(name: string, input: unknown): string {
  const result = validateCommandInput(name, input);
  if (result.ok) throw new Error(`expected ${name} to reject ${JSON.stringify(input)}`);
  return result.message;
}

function accept(name: string, input: unknown): void {
  const result = validateCommandInput(name, input);
  if (!result.ok) throw new Error(result.message);
}

describe('the command registry', () => {
  it('has unique, stably named commands', () => {
    const names = AGENT_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+\.[a-z-]+$/u);
  });

  it('describes every command input inside the enforceable subset', () => {
    for (const command of AGENT_COMMANDS) {
      expect(() => assertSupportedSchema(command.input, COMMAND_SCHEMA_DEFS)).not.toThrow();
    }
  });

  it('closes every command input, so a typo is an error and not a silently dropped field', () => {
    for (const command of AGENT_COMMANDS) {
      expect(command.input.additionalProperties, command.name).toBe(false);
      expect(command.input.type, command.name).toBe('object');
    }
  });

  it('marks exactly the fund-moving commands as writes needing confirmation', () => {
    const writes = AGENT_COMMANDS.filter((command) => command.classification === 'write');
    expect(writes.map((command) => command.name)).toEqual([
      'order.execute',
      'order.execute-many',
      'strategy.create',
      'strategy.cancel',
    ]);

    const fundMovers = writes.filter((command) => command.sideEffects.includes('MOVES_FUNDS'));
    expect(fundMovers.map((command) => command.name)).toEqual([
      'order.execute',
      'order.execute-many',
      // Arming a strategy places nothing today and is the reason something is
      // placed tomorrow, unattended. Anything less than MOVES_FUNDS would let it
      // through a gate written for trades.
      'strategy.create',
    ]);
    for (const command of fundMovers) {
      expect(command.confirmation, command.name).toBe('REQUIRED_UNLESS_DELEGATED');
    }

    // A retried write without a key is a duplicate trade — but only where a key
    // would help. The Runner does not deduplicate a create at all, so demanding
    // one there would advertise a safety it cannot deliver; `strategy.create`
    // says UNSUPPORTED and tells the caller to list before retrying instead.
    for (const command of fundMovers) {
      if (command.implementation.kind === 'sdk') {
        expect(command.idempotency.required, command.name).toBe(true);
      } else {
        expect(command.idempotency.required, command.name).toBe(false);
        expect(command.idempotency.callerSupplied, command.name).toBe('UNSUPPORTED');
        expect(command.idempotency.note, command.name).toMatch(/list/iu);
      }
    }

    // The one write that moves nothing. Cancelling can only ever stop trading,
    // so making an operator approve it would be a gate that costs money to pass.
    const stoppers = writes.filter((command) => !command.sideEffects.includes('MOVES_FUNDS'));
    expect(stoppers.map((command) => command.name)).toEqual(['strategy.cancel']);
    for (const command of stoppers) {
      expect(command.sideEffects, command.name).toEqual(['NONE']);
      expect(command.confirmation, command.name).toBe('NOT_REQUIRED');
    }

    for (const command of AGENT_COMMANDS) {
      if (command.classification === 'read') {
        expect(command.sideEffects, command.name).not.toContain('MOVES_FUNDS');
        expect(command.confirmation, command.name).toBe('NOT_REQUIRED');
      }
    }
  });

  it('keeps runner-implemented commands honest about where they run', () => {
    // A `runner` command is served by a process on this machine, not by the
    // exchange. Two things must stay true of every one of them: the socket
    // command name is carried here (the surface must not guess it), and no
    // strategy command claims to be an SDK call, because none of them can be
    // answered without a Runner running.
    const runnerCommands = AGENT_COMMANDS.filter(
      (command) => command.implementation.kind === 'runner',
    );
    expect(runnerCommands.map((command) => command.name)).toEqual([
      'strategy.create',
      'strategy.get',
      'strategy.list',
      'strategy.cancel',
      'strategy.events',
    ]);
    for (const command of runnerCommands) {
      if (command.implementation.kind !== 'runner') throw new Error('unreachable');
      // The socket name is the contract name. A divergence here would be a
      // command the CLI can spell and the Runner cannot answer.
      expect(command.implementation.command, command.name).toBe(command.name);
      expect(command.implementation.note.length, command.name).toBeGreaterThan(0);
      expect(command.longRunning, command.name).toBe(false);
    }
    for (const command of AGENT_COMMANDS) {
      if (!command.name.startsWith('strategy.')) continue;
      expect(command.implementation.kind, command.name).toBe('runner');
    }
  });

  it('demands an expiry on a strategy without letting the schema answer for the Runner', () => {
    const create = AGENT_COMMANDS.find((command) => command.name === 'strategy.create');
    if (!create) throw new Error('strategy.create is missing');

    // expiresAt is mandatory, and is deliberately NOT in `required`. A schema
    // rejection here would be an anonymous "input invalid"; leaving it out lets
    // the Runner answer EXPIRY_REQUIRED and name the seven-day cap, which is the
    // sentence the operator actually needs. The obligation lives in the text.
    expect(create.input.properties?.expiresAt).toBeDefined();
    expect(create.input.required).not.toContain('expiresAt');
    expect(create.description).toMatch(/seven days/u);
    expect(create.description).toMatch(/refused, never clamped/u);

    // Same reasoning for sizing: four fields, all optional, exactly one allowed.
    // The Runner is the single place that decides which, and it says so.
    const leg = COMMAND_SCHEMA_DEFS.strategyLeg;
    if (!leg) throw new Error('strategyLeg is missing');
    const sizing = [
      'buyAmount',
      'sellShares',
      'sellFractionOfPosition',
      'dynamicSellFractionOfPosition',
    ];
    for (const field of sizing) {
      expect(leg.properties?.[field], field).toBeDefined();
      expect(leg.required, field).not.toContain(field);
    }
    expect(create.description).toMatch(/Exactly one sizing field/u);
  });

  it('keeps runtime-implemented commands away from anything that moves funds', () => {
    // A `runtime` command has no single SDK method behind it, so nothing checks
    // its behaviour against one call. That freedom is only safe while it stays
    // read-shaped: a second, unaudited way to trade is exactly what it must not
    // become (see AgentCommandImplementation).
    for (const command of AGENT_COMMANDS) {
      if (command.implementation.kind !== 'runtime') continue;
      expect(command.classification, command.name).toBe('read');
      expect(command.sideEffects, command.name).not.toContain('MOVES_FUNDS');
      expect(command.sideEffects, command.name).not.toContain('SIGNS_TRANSACTION');
      expect(command.implementation.note.length, command.name).toBeGreaterThan(0);
    }
  });

  it('names a distinct SDK method for every sdk-implemented command', () => {
    const methods = AGENT_COMMANDS.flatMap((command) =>
      command.implementation.kind === 'sdk' ? [command.implementation.method] : [],
    );
    expect(new Set(methods).size).toBe(methods.length);
  });

  it('reaches every shared definition from a command input', () => {
    // An unreachable definition is a rule nobody applies. It reads like a
    // guarantee in the published document while enforcing nothing.
    const reached = new Set<string>();
    const collect = (schema: JsonSchema): void => {
      if (schema.$ref !== undefined) {
        const name = schema.$ref.slice('#/$defs/'.length);
        if (reached.has(name)) return;
        reached.add(name);
        const target = COMMAND_SCHEMA_DEFS[name];
        if (target !== undefined) collect(target);
        return;
      }
      Object.values(schema.properties ?? {}).forEach(collect);
      if (schema.items !== undefined) collect(schema.items);
      schema.oneOf?.forEach(collect);
      schema.allOf?.forEach(collect);
    };
    AGENT_COMMANDS.forEach((command) => collect(command.input));
    expect([...reached].sort()).toEqual(Object.keys(COMMAND_SCHEMA_DEFS).sort());
  });

  it('validates every published example against its own command', () => {
    for (const command of AGENT_COMMANDS) {
      expect(command.examples.length, command.name).toBeGreaterThan(0);
      for (const example of command.examples) {
        const result = validateCommandInput(command.name, example.input);
        expect(result.ok ? null : result.message, `${command.name}: ${example.title}`).toBeNull();
      }
    }
  });

  it('keeps example data obviously synthetic', () => {
    // Examples get copied verbatim by agents. Nothing in one may resolve to a
    // real account, and nothing may look like a credential.
    const serialized = JSON.stringify(AGENT_COMMANDS.map((command) => command.examples));
    expect(serialized).not.toMatch(/(?:secret|private|token|bearer|apikey|api_key)/iu);
    for (const address of serialized.matchAll(/0x[0-9a-fA-F]{64}/gu)) {
      expect(address[0]).toMatch(/^0x(11|22|33|44|55)+$/u);
    }
  });
});

describe('validateCommandInput', () => {
  it('names the known commands when the command is unknown', () => {
    const result = validateCommandInput('order.yolo', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNKNOWN_COMMAND');
    expect(result.message).toContain('order.execute');
  });

  it('returns the input unchanged rather than a coerced copy', () => {
    const input = { marketId: MARKET_ID };
    const result = validateCommandInput('market.get', input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toBe(input);
  });

  it('reports INVALID_INPUT with machine-readable violations', () => {
    const result = validateCommandInput('market.get', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_INPUT');
    expect(result.violations).toEqual([
      { path: '/marketId', keyword: 'required', message: 'is required' },
    ]);
  });
});

describe('order.execute size units', () => {
  it('accepts a BUY stating buyAmount and a SELL stating sellShares', () => {
    accept('order.execute', BUY);
    accept('order.execute', SELL);
  });

  it('refuses a BUY stating shares', () => {
    // BUY ⇒ buyAmount, SELL ⇒ sellShares. Guessing here trades the wrong size by
    // roughly the price of the outcome.
    expect(reject('order.execute', { ...BUY, size: { sellShares: '100' } })).toMatch(
      /BUY with buyAmount/u,
    );
  });

  it('refuses a SELL stating an amount', () => {
    expect(
      reject('order.execute', { ...SELL, size: { buyAmount: '100' } }),
    ).toMatch(/SELL with sellShares/u);
  });

  it('refuses a size stating both units', () => {
    expect(
      reject('order.execute', { ...BUY, size: { buyAmount: '50', sellShares: '100' } }),
    ).toMatch(/size/u);
  });

  it('refuses a size stating neither', () => {
    expect(reject('order.execute', { ...BUY, size: {} })).toMatch(/size/u);
  });

  it('refuses a JSON number as a size', () => {
    // The whole decimal-string discipline exists because a double cannot hold
    // 6-dp money exactly.
    expect(reject('order.execute', { ...BUY, size: { buyAmount: 50 } })).toMatch(
      /expected string/u,
    );
  });

  it('refuses a zero size before it reaches the server', () => {
    expect(reject('order.execute', { ...BUY, size: { buyAmount: '0' } })).toMatch(/does not match/u);
    expect(reject('order.execute', { ...BUY, size: { buyAmount: '0.000' } })).toMatch(
      /does not match/u,
    );
  });

  it('refuses more precision than the API carries', () => {
    expect(reject('order.execute', { ...BUY, size: { buyAmount: '1.1234567' } })).toMatch(
      /does not match/u,
    );
    accept('order.execute', { ...BUY, size: { buyAmount: '1.123456' } });
  });

  it('refuses a negative, signed, padded or exponential amount', () => {
    for (const amount of ['-1', '+1', '1e3', '.5', '1.', ' 1', '1 ', '', '1,000']) {
      expect(
        reject('order.execute', { ...BUY, size: { buyAmount: amount } }),
        `buyAmount ${JSON.stringify(amount)}`,
      ).toMatch(/BUY size|does not match/u);
    }
  });
});

describe('order.execute position agreement', () => {
  it('refuses a BUY that names a position', () => {
    expect(reject('order.execute', { ...BUY, positionId: POSITION_ID })).toMatch(
      /BUY closes no position/u,
    );
  });

  it('refuses a SELL that does not name the position it closes', () => {
    const { positionId: _omitted, ...withoutPosition } = SELL;
    expect(reject('order.execute', withoutPosition)).toMatch(/SELL names the position/u);
  });

  it('refuses an explicit null position on a BUY', () => {
    // The BUY variant permits `null` so that "absent" passes; the field
    // definition still rejects a null that was actually sent.
    expect(reject('order.execute', { ...BUY, positionId: null })).toMatch(/expected string/u);
  });
});

describe('order.execute price protection', () => {
  it('requires slippage protection', () => {
    const { maxSlippageBps: _omitted, ...unprotected } = BUY;
    expect(reject('order.execute', unprotected)).toMatch(/maxSlippageBps.*is required/u);
  });

  it('refuses 10000 bps, which looks protected and is not', () => {
    expect(reject('order.execute', { ...BUY, maxSlippageBps: 10_000 })).toMatch(/<= 9999/u);
  });

  it('refuses a fractional bps', () => {
    expect(reject('order.execute', { ...BUY, maxSlippageBps: 12.5 })).toMatch(/expected integer/u);
  });

  it('bounds worstAcceptablePrice to a probability', () => {
    accept('order.execute', { ...BUY, worstAcceptablePrice: '0.82' });
    accept('order.execute', { ...BUY, worstAcceptablePrice: '1' });
    accept('order.execute', { ...BUY, worstAcceptablePrice: '0' });
    expect(reject('order.execute', { ...BUY, worstAcceptablePrice: '1.5' })).toMatch(
      /does not match/u,
    );
    expect(reject('order.execute', { ...BUY, worstAcceptablePrice: 0.82 })).toMatch(
      /expected string/u,
    );
  });

  it('requires a reference quote', () => {
    const { referenceQuoteId: _omitted, ...unquoted } = BUY;
    expect(reject('order.execute', unquoted)).toMatch(/referenceQuoteId.*is required/u);
  });
});

describe('order.execute identity fields', () => {
  it('requires a full-length Sui account address', () => {
    expect(reject('order.execute', { ...BUY, accountId: '0xabc' })).toMatch(/does not match/u);
    expect(reject('order.execute', { ...BUY, accountId: '11'.repeat(32) })).toMatch(
      /does not match/u,
    );
    accept('order.execute', { ...BUY, accountId: `0x${'AB'.repeat(32)}` });
  });

  it('rejects an unknown outcome rather than assuming YES', () => {
    expect(reject('order.execute', { ...BUY, outcomeId: 'MAYBE' })).toMatch(/must be one of/u);
  });

  it('rejects an unknown field instead of dropping it', () => {
    expect(reject('order.execute', { ...BUY, maxSlippage: 100 })).toMatch(/not a known field/u);
  });

  it('keeps clientOrderId distinct from the idempotency key', () => {
    accept('order.execute', { ...BUY, clientOrderId: 'strategy-a-1', idempotencyKey: 'idem-1' });
  });
});

describe('order.execute-many', () => {
  it('accepts independent legs', () => {
    accept('order.execute-many', { orders: [BUY, SELL], concurrency: 2, failurePolicy: 'STOP' });
  });

  it('refuses an empty batch', () => {
    expect(reject('order.execute-many', { orders: [] })).toMatch(/at least 1/u);
  });

  it('applies the same order rules to every leg, and says which leg failed', () => {
    const message = reject('order.execute-many', {
      orders: [BUY, { ...BUY, size: { sellShares: '1' } }],
    });
    expect(message).toContain('/orders/1');
  });
});

describe('read commands', () => {
  it('accepts the documented filters and rejects an unknown status', () => {
    accept('market.list', { category: 'FOOTBALL', status: 'IN_PLAY', tradeable: true, limit: 20 });
    expect(reject('market.list', { status: 'HALFTIME' })).toMatch(/must be one of/u);
  });

  it('tolerates an unlisted category, because the catalog is an open set', () => {
    accept('market.list', { category: 'ESPORTS' });
  });

  it('caps limit at the server page size', () => {
    expect(reject('account.positions', { accountId: ACCOUNT_ID, limit: 500 })).toMatch(/<= 200/u);
    expect(reject('account.positions', { accountId: ACCOUNT_ID, limit: 0 })).toMatch(/>= 1/u);
  });

  it('requires the account on every account-scoped read', () => {
    const scoped = ['account.allowance', 'account.positions', 'account.executions', 'account.fills', 'account.performance'];
    for (const name of scoped) {
      expect(reject(name, {})).toMatch(/accountId.*is required/u);
    }
  });

  it('narrows performance by strategy, and refuses a window it does not compute', () => {
    accept('account.performance', { accountId: ACCOUNT_ID, strategyId: 'take-profit' });
    // Every figure is lifetime-to-date. Accepting `since` and ignoring it would
    // hand back a total the caller believes is windowed.
    expect(reject('account.performance', { accountId: ACCOUNT_ID, since: '2026-01-01' })).toMatch(
      /since/u,
    );
  });

  it('prices a quote with the same size rules as an order', () => {
    accept('market.quote', { marketId: MARKET_ID, outcomeId: 'YES', side: 'BUY', size: { buyAmount: '50' } });
    expect(
      reject('market.quote', {
        marketId: MARKET_ID,
        outcomeId: 'YES',
        side: 'SELL',
        size: { buyAmount: '50' },
      }),
    ).toMatch(/SELL with sellShares/u);
  });

  it('does not let a quote carry order-only fields', () => {
    expect(
      reject('market.quote', {
        marketId: MARKET_ID,
        outcomeId: 'YES',
        side: 'BUY',
        size: { buyAmount: '50' },
        maxSlippageBps: 100,
      }),
    ).toMatch(/not a known field/u);
  });
});

describe('getCommand', () => {
  it('returns undefined for an unknown name', () => {
    expect(getCommand('order.nope')).toBeUndefined();
    expect(getCommand('order.execute')?.implementation).toEqual({
      kind: 'sdk',
      method: 'executeMarketOrder',
    });
  });
});
