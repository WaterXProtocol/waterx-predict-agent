/**
 * The market id direct mode hands out, and takes back.
 *
 * Quotes are keyed by a catalog round and a side; orders by an on-chain market
 * and a selection. No public route maps one to the other, so the id carries
 * both, composed ONLY from fields the server returned together in one catalog
 * response:
 *
 *     wxp1.<roundId>.<on-chain market id, base64url>.<YES side key>.<NO side key | ~>
 *
 * `~` means the round has no separate side for the NO leg (a three-way board),
 * so its price comes from `/predict/quotes/no` under the YES side's key.
 *
 * It is opaque to an agent, which receives it from `market list/search` and
 * must never build one (ADR-0001 §10). It is not opaque to this module, which
 * refuses anything that does not decode exactly.
 */
import { bytesToHex, normalizeSuiAddress } from '../sui-tx.ts';

export interface MarketHandle {
  readonly roundId: string;
  /** `0x` + 64 hex. */
  readonly onchainMarketId: string;
  readonly yesSide: string;
  /** Undefined for a board whose NO leg has no side of its own. */
  readonly noSide: string | undefined;
}

export class MarketHandleError extends Error {
  override readonly name = 'MarketHandleError';
}

const PREFIX = 'wxp1';
const ROUND = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SIDE = /^[A-Za-z0-9_-]{1,16}$/u;

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

export function encodeMarketHandle(handle: MarketHandle): string {
  if (!ROUND.test(handle.roundId)) throw new MarketHandleError(`round id \`${handle.roundId}\` is not a UUID`);
  if (!SIDE.test(handle.yesSide)) throw new MarketHandleError(`side key \`${handle.yesSide}\` is not encodable`);
  if (handle.noSide !== undefined && !SIDE.test(handle.noSide)) {
    throw new MarketHandleError(`side key \`${handle.noSide}\` is not encodable`);
  }
  const hex = normalizeSuiAddress(handle.onchainMarketId).slice(2);
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  const id = [PREFIX, handle.roundId, toBase64Url(bytes), handle.yesSide, handle.noSide ?? '~'].join('.');
  if (id.length > 128) throw new MarketHandleError('the composed market id exceeds 128 characters');
  return id;
}

export function isMarketHandle(value: string): boolean {
  return value.startsWith(`${PREFIX}.`);
}

export function decodeMarketHandle(value: string): MarketHandle {
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== PREFIX) {
    throw new MarketHandleError(
      `\`${value}\` is not a direct-mode market id. Obtain one from \`market search\` or \`market list\`; ids are never constructed.`,
    );
  }
  const [, roundId, market, yesSide, noSide] = parts as [string, string, string, string, string];
  if (!ROUND.test(roundId)) throw new MarketHandleError('the market id names no valid round');
  const bytes = Uint8Array.from(Buffer.from(market, 'base64url'));
  if (bytes.length !== 32 || toBase64Url(bytes) !== market) {
    throw new MarketHandleError('the market id carries no valid on-chain market');
  }
  if (!SIDE.test(yesSide) || (noSide !== '~' && !SIDE.test(noSide))) {
    throw new MarketHandleError('the market id carries an invalid side');
  }
  return {
    roundId,
    onchainMarketId: `0x${bytesToHex(bytes)}`,
    yesSide,
    noSide: noSide === '~' ? undefined : noSide,
  };
}
