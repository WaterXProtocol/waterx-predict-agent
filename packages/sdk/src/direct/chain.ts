/**
 * Whether a transaction digest landed, read from Sui's public GraphQL.
 *
 * The one question direct mode cannot ask WaterX: after a `/sponsor/execute`
 * that did not answer, did the transaction execute? The activity feed says so
 * only once the indexer has seen it, and silence there is not absence. The
 * chain is the authority, and this reads it — nothing else, no key, no write.
 */
import type { FunctionReader, FunctionShape } from './abi.ts';
import type { DirectNetwork } from './deployment.ts';

export const SUI_GRAPHQL_URLS: Readonly<Record<DirectNetwork, string>> = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
};

/** `UNKNOWN` is a failed read, and is never treated as `NOT_FOUND`. */
export type LandingStatus = 'SUCCESS' | 'FAILURE' | 'NOT_FOUND' | 'UNKNOWN';

/** One delegate entry of an on-chain `account::Account`, as read. */
export interface ChainDelegate {
  readonly address: string;
  /** Per-protocol masks, keyed by the full permission-key TYPE as the chain prints it. */
  readonly protocolPermissions: readonly { readonly keyType: string; readonly mask: number }[];
  readonly expiresAtMs: number | null;
}

export interface ChainAccount {
  /** The object's Move type, as the chain prints it. */
  readonly type: string;
  readonly owner: string;
  readonly delegates: readonly ChainDelegate[];
}

/** An order a transaction placed, from its own events. */
export interface PlacedOrder {
  readonly registry: string;
  readonly orderId: string;
  /** `OPEN` for a buy (`OrderPlaced`), `CLOSE` for a sell (`CloseRequested`). */
  readonly kind: 'OPEN' | 'CLOSE';
  /** The position a close order closes; for a partial close, the split-off one. */
  readonly positionId?: string;
}

/**
 * Where an order stands in the registry right now.
 *
 * `OPEN` is in `orders`; `FILLED` is indexed in `position_id_by_order` (the
 * position is read alongside when it still exists); `GONE` is neither — the
 * order was cancelled, or filled and its position since closed or claimed.
 */
export type ChainOrderState =
  | { readonly state: 'OPEN'; readonly expiryTs: number; readonly selfCancelAfterTs: number; readonly escrow: string }
  | {
      readonly state: 'FILLED';
      readonly positionId: string;
      readonly position?: { readonly filledShares: string; readonly filledCost: string; readonly openedTs: number };
    }
  | { readonly state: 'GONE' };

export interface ChainReader extends Partial<FunctionReader> {
  landing(digest: string, signal?: AbortSignal): Promise<LandingStatus>;
  /**
   * The account object, straight from the chain: `undefined` when there is no
   * such object. Throws when the read fails — a failed read is never "absent".
   * Optional so a reader that cannot answer simply is not asked.
   */
  account?(accountId: string, signal?: AbortSignal): Promise<ChainAccount | undefined>;
  /**
   * The orders a transaction placed, read from its events and filtered to the
   * given prediction package (its ORIGINAL id). `undefined` when the chain does
   * not know the transaction; throws when the read fails.
   */
  placedOrders?(digest: string, predictionPackage: string, signal?: AbortSignal): Promise<PlacedOrder[] | undefined>;
  /** One order's state in a registry. Throws when the read fails. */
  orderState?(registry: string, orderId: string, signal?: AbortSignal): Promise<ChainOrderState>;
  /**
   * Accounts whose recent `DelegateAdded` / `DelegateUpdated` events name
   * `delegate` — candidates only, newest first: a grant may have been revoked
   * since, so every one is re-read before it counts. Throws when the read fails.
   */
  delegationCandidates?(accountPackage: string, delegate: string, signal?: AbortSignal): Promise<string[]>;
  /** Whether a position still exists in a registry. Throws when the read fails. */
  positionOpen?(registry: string, positionId: string, signal?: AbortSignal): Promise<boolean>;
}

/** How far back the event fallback looks: 4 × 50 events of each kind. */
const DELEGATION_EVENT_PAGES = 4;
/** How many candidates it re-reads at most. Each is one chain read. */
const DELEGATION_CANDIDATE_LIMIT = 20;

const sameAddress = (a: string, b: string): boolean => {
  const strip = (value: string): string => value.toLowerCase().replace(/^0x/u, '').replace(/^0+/u, '');
  return strip(a) === strip(b);
};

export class ChainReadError extends Error {
  override readonly name = 'ChainReadError';
}

export class SuiGraphqlChainReader implements ChainReader {
  private readonly url: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: { network: DirectNetwork; url?: string; fetch?: typeof globalThis.fetch }) {
    this.url = options.url ?? SUI_GRAPHQL_URLS[options.network];
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private readonly tables = new Map<string, Promise<{ orders: string; filled: string; positions: string }>>();

  private async query<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let body: { data?: T; errors?: unknown[] };
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: signal ?? AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new ChainReadError(`the chain read answered HTTP ${String(response.status)}`);
      body = (await response.json()) as typeof body;
    } catch (error: unknown) {
      if (error instanceof ChainReadError) throw error;
      throw new ChainReadError('the chain read did not complete');
    }
    if (body.errors !== undefined && body.errors.length > 0) throw new ChainReadError('the chain read returned errors');
    if (body.data === undefined) throw new ChainReadError('the chain read returned no data');
    return body.data;
  }

  async placedOrders(digest: string, predictionPackage: string, signal?: AbortSignal): Promise<PlacedOrder[] | undefined> {
    const data = await this.query<{
      transaction: {
        effects: { events: { nodes: { contents: { type: { repr: string }; json: Record<string, unknown> } }[] } } | null;
      } | null;
    }>(
      'query($d: String!) { transaction(digest: $d) { effects { events(first: 50) { nodes { contents { type { repr } json } } } } } }',
      { d: digest },
      signal,
    );
    if (data.transaction === null) return undefined;
    const prefix = predictionPackage.toLowerCase();
    const orders: PlacedOrder[] = [];
    for (const node of data.transaction.effects?.events.nodes ?? []) {
      const [address, module, name] = node.contents.type.repr.split('::');
      if (address === undefined || !sameAddress(address, prefix) || module !== 'events') continue;
      const json = node.contents.json;
      const registry = json['market_registry_id'];
      const id =
        name === 'OrderPlaced'
          ? json['order_id']
          : name === 'CloseRequested'
            ? json['order_id']
            : undefined;
      if (typeof registry !== 'string' || (typeof id !== 'string' && typeof id !== 'number')) continue;
      const position = json['position_id'];
      orders.push({
        registry,
        orderId: String(id),
        kind: name === 'OrderPlaced' ? 'OPEN' : 'CLOSE',
        ...(name === 'CloseRequested' && (typeof position === 'string' || typeof position === 'number')
          ? { positionId: String(position) }
          : {}),
      });
    }
    return orders;
  }

  private registryTables(registry: string, signal?: AbortSignal): Promise<{ orders: string; filled: string; positions: string }> {
    let tables = this.tables.get(registry);
    if (tables === undefined) {
      tables = this.query<{ object: { asMoveObject: { contents: { json: Record<string, { id?: unknown }> } } | null } | null }>(
        'query($a: SuiAddress!) { object(address: $a) { asMoveObject { contents { json } } } }',
        { a: registry },
        signal,
      ).then((data) => {
        const json = data.object?.asMoveObject?.contents.json;
        const orders = json?.['orders']?.id;
        const filled = json?.['position_id_by_order']?.id;
        const positions = json?.['positions']?.id;
        if (typeof orders !== 'string' || typeof filled !== 'string' || typeof positions !== 'string') {
          throw new ChainReadError('the market registry does not have the expected tables');
        }
        return { orders, filled, positions };
      });
      tables.catch(() => this.tables.delete(registry));
      this.tables.set(registry, tables);
    }
    return tables;
  }

  private async field(table: string, key: string, signal?: AbortSignal): Promise<unknown> {
    const name = Buffer.alloc(8);
    name.writeBigUInt64LE(BigInt(key));
    const data = await this.query<{ address: { dynamicField: { value: { json?: unknown } } | null } | null }>(
      'query($a: SuiAddress!, $n: Base64!) { address(address: $a) { dynamicField(name: { type: "u64", bcs: $n }) { value { ... on MoveValue { json } } } } }',
      { a: table, n: name.toString('base64') },
      signal,
    );
    const value = data.address?.dynamicField?.value.json;
    return value === undefined ? undefined : value;
  }

  async functionShape(packageId: string, module: string, name: string, signal?: AbortSignal): Promise<FunctionShape | undefined> {
    const data = await this.query<{
      object: {
        asMovePackage: {
          module: { function: { typeParameters: unknown[]; parameters: { repr: string }[] } | null } | null;
        } | null;
      } | null;
    }>(
      'query($p: SuiAddress!, $m: String!, $f: String!) { object(address: $p) { asMovePackage { module(name: $m) { function(name: $f) { typeParameters { constraints } parameters { repr } } } } } }',
      { p: packageId, m: module, f: name },
      signal,
    );
    if (data.object === null) throw new ChainReadError(`package ${packageId} is not on this chain`);
    const found = data.object.asMovePackage?.module?.function;
    if (found === null || found === undefined) return undefined;
    return { typeParameters: found.typeParameters.length, parameters: found.parameters.map((parameter) => parameter.repr) };
  }

  async delegationCandidates(accountPackage: string, delegate: string, signal?: AbortSignal): Promise<string[]> {
    const found: string[] = [];
    for (const name of ['DelegateAdded', 'DelegateUpdated']) {
      let before: string | null = null;
      for (let page = 0; page < DELEGATION_EVENT_PAGES; page += 1) {
        const data: {
          events: {
            nodes: { contents: { json: { account_object_address?: unknown; delegate?: unknown } } }[];
            pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
          };
        } = await this.query(
          'query($t: String!, $b: String) { events(last: 50, before: $b, filter: { type: $t }) { nodes { contents { json } } pageInfo { hasPreviousPage startCursor } } }',
          { t: `${accountPackage}::events::${name}`, b: before },
          signal,
        );
        for (const node of [...data.events.nodes].reverse()) {
          const { account_object_address: account, delegate: named } = node.contents.json;
          if (typeof account === 'string' && typeof named === 'string' && sameAddress(named, delegate) && !found.includes(account)) {
            found.push(account);
          }
        }
        if (!data.events.pageInfo.hasPreviousPage || data.events.pageInfo.startCursor === null) break;
        before = data.events.pageInfo.startCursor;
      }
    }
    return found.slice(0, DELEGATION_CANDIDATE_LIMIT);
  }

  async positionOpen(registry: string, positionId: string, signal?: AbortSignal): Promise<boolean> {
    if (!/^\d+$/u.test(positionId)) throw new ChainReadError('a position id is a u64');
    const tables = await this.registryTables(registry, signal);
    return (await this.field(tables.positions, positionId, signal)) !== undefined;
  }

  async orderState(registry: string, orderId: string, signal?: AbortSignal): Promise<ChainOrderState> {
    if (!/^\d+$/u.test(orderId)) throw new ChainReadError('an order id is a u64');
    const tables = await this.registryTables(registry, signal);
    // A linked-table entry is a node; the order is its `value`.
    const node = (await this.field(tables.orders, orderId, signal)) as { value?: Record<string, unknown> } | undefined;
    const open = node?.value;
    if (open !== undefined) {
      return {
        state: 'OPEN',
        expiryTs: Number(open['expiry_ts']),
        selfCancelAfterTs: Number(open['self_cancel_after_ts']),
        escrow: String(open['max_spend'] ?? '0'),
      };
    }
    const positionId = await this.field(tables.filled, orderId, signal);
    if (typeof positionId !== 'string' && typeof positionId !== 'number') return { state: 'GONE' };
    const positionNode = (await this.field(tables.positions, String(positionId), signal)) as
      | { value?: Record<string, unknown> }
      | undefined;
    const position = positionNode?.value;
    return {
      state: 'FILLED',
      positionId: String(positionId),
      ...(position === undefined
        ? {}
        : {
            position: {
              filledShares: String(position['filled_shares']),
              filledCost: String(position['filled_cost']),
              openedTs: Number(position['opened_ts']),
            },
          }),
    };
  }

  async account(accountId: string, signal?: AbortSignal): Promise<ChainAccount | undefined> {
    if (!/^0x[0-9a-fA-F]{64}$/u.test(accountId)) return undefined;
    let body: {
      data?: { object?: { asMoveObject?: { contents?: { type?: { repr?: string }; json?: unknown } | null } | null } | null };
      errors?: unknown[];
    };
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query: 'query($a: SuiAddress!) { object(address: $a) { asMoveObject { contents { type { repr } json } } } }',
          variables: { a: accountId },
        }),
        signal: signal ?? AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new ChainReadError(`the account read answered HTTP ${String(response.status)}`);
      body = (await response.json()) as typeof body;
    } catch (error: unknown) {
      if (error instanceof ChainReadError) throw error;
      throw new ChainReadError('the account read did not complete');
    }
    if (body.errors !== undefined && body.errors.length > 0) throw new ChainReadError('the account read returned errors');
    const object = body.data?.object;
    if (object === null) return undefined;
    const contents = object?.asMoveObject?.contents;
    const type = contents?.type?.repr;
    const json = contents?.json as
      | {
          owner_address?: unknown;
          delegates?: {
            delegate_address?: unknown;
            protocol_permissions?: { contents?: { key?: unknown; value?: unknown }[] };
            expires_at_ms?: unknown;
          }[];
        }
      | undefined;
    if (typeof type !== 'string' || json === undefined || typeof json.owner_address !== 'string') {
      // An object that is not shaped like an account is not one.
      return undefined;
    }
    const delegates: ChainDelegate[] = [];
    for (const row of json.delegates ?? []) {
      if (typeof row.delegate_address !== 'string') continue;
      const protocolPermissions = (row.protocol_permissions?.contents ?? []).flatMap((entry) =>
        typeof entry.key === 'string' && typeof entry.value === 'number'
          ? [{ keyType: entry.key, mask: entry.value }]
          : [],
      );
      const expires = row.expires_at_ms;
      delegates.push({
        address: row.delegate_address,
        protocolPermissions,
        expiresAtMs: typeof expires === 'number' ? expires : typeof expires === 'string' ? Number(expires) : null,
      });
    }
    return { type, owner: json.owner_address, delegates };
  }

  async landing(digest: string, signal?: AbortSignal): Promise<LandingStatus> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(digest)) return 'UNKNOWN';
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query: 'query($d: String!) { transaction(digest: $d) { effects { status } } }',
          variables: { d: digest },
        }),
        signal: signal ?? AbortSignal.timeout(15_000),
      });
      if (!response.ok) return 'UNKNOWN';
      const body = (await response.json()) as {
        data?: { transaction?: { effects?: { status?: string } | null } | null };
        errors?: unknown[];
      };
      if (body.errors !== undefined && body.errors.length > 0) return 'UNKNOWN';
      const transaction = body.data?.transaction;
      if (transaction === null) return 'NOT_FOUND';
      const status = transaction?.effects?.status;
      if (status === 'SUCCESS') return 'SUCCESS';
      if (status === 'FAILURE') return 'FAILURE';
      return 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }
}
