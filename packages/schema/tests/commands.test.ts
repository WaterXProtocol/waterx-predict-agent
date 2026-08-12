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
    expect(writes.map((command) => command.name)).toEqual(['order.execute', 'order.execute-many']);
    for (const command of writes) {
      expect(command.sideEffects, command.name).toContain('MOVES_FUNDS');
      expect(command.confirmation, command.name).toBe('REQUIRED_UNLESS_DELEGATED');
      // A retried write without a key is a duplicate trade, not a duplicate request.
      expect(command.idempotency.required, command.name).toBe(true);
    }
    for (const command of AGENT_COMMANDS) {
      if (command.classification === 'read') {
        expect(command.sideEffects, command.name).not.toContain('MOVES_FUNDS');
        expect(command.confirmation, command.name).toBe('NOT_REQUIRED');
      }
    }
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
      expect(address[0]).toMatch(/^0x(11|22|33)+$/u);
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
    for (const name of ['account.allowance', 'account.positions', 'account.executions', 'account.fills']) {
      expect(reject(name, {})).toMatch(/accountId.*is required/u);
    }
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
    expect(getCommand('order.execute')?.sdkMethod).toBe('executeMarketOrder');
  });
});
