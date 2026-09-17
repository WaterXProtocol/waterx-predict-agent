/**
 * The public WaterX routes direct mode speaks (ADR-0013), transcribed.
 *
 * NOT VENDORED. Unlike `contract.ts`, the backend publishes no contract file
 * for these routes; they are the web app's. Every shape here was read from the
 * deployed backend source (`bucket-backend-mono` at `f091697`) and is cited
 * beside it, so a drift is a diff against a named file rather than a guess.
 * Only the fields this client reads are declared: an unknown field is ignored,
 * and a missing one this client needs is a decode failure where it is read.
 */

/** Route paths, relative to the deployment's base URL. */
export const PUBLIC_ROUTES = {
  /** `predict/predict.controller.ts:175` */
  browse: 'predict/browse',
  /** `predict/predict.controller.ts:419-460` — keyed by round id, then side key. */
  quotes: 'predict/quotes',
  quotesBid: 'predict/quotes/bid',
  quotesNo: 'predict/quotes/no',
  /** `predict/bet/predict-bet-tx.controller.ts:34,48` */
  placeBet: 'predict/bets/place',
  sellBet: 'predict/bets/sell',
  /** `predict/bet/bet.controller.ts:41,66` — `address` is the OWNER wallet. */
  bets: 'predict/bets/me',
  activity: 'predict/bets/me/activity',
  /** `sponsor/sponsor.controller.ts:21-28` */
  sponsorExecute: 'sponsor/execute',
  /** `account/account.controller.ts:71,82,94` */
  accounts: 'account',
  delegates: 'account/delegate',
  delegated: 'account/delegated',
} as const;

/** `libs/shared/dto/response.dto.ts:20-26` */
export type PublicEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: number; message: string }; details?: unknown };

/**
 * Numeric backend error codes this client branches on
 * (`apps/waterx/src/core/error-codes.ts`, shared `libs/shared/error-codes.ts`).
 */
export const PUBLIC_ERROR_CODES = {
  DelegatesQueryFailed: 2020,
  DelegateNotAuthorized: 2022,
  DelegateInsufficientPermission: 2023,
  SponsoredTxNotConfigured: 6001,
  TxWouldFail: 6002,
  SponsorshipRequiredForDelegate: 6003,
  SponsorGasBudgetDepleted: 6006,
  ServiceBusy: 9001,
  SponsorSessionExpired: 9002,
  TransientUpstream: 9003,
  RateLimited: 9004,
  InvalidParameter: 20001,
  MissingRequiredField: 20002,
  ResourceNotFound: 40001,
  BetBelowMinimum: 82003,
  PredictPositionCloseInFlight: 82005,
  PredictSellPositionNotFound: 82006,
  PredictNoSellablePositions: 82007,
  PredictSellAmbiguousTarget: 82008,
  PredictSellAdminGrantedPosition: 82010,
} as const;

/** `core/dto/tx.dto.ts:22-46` */
export interface PublicTxBody {
  /** The account OWNER. The auth subject; not the on-chain sender here. */
  sender: string;
  /** This agent wallet. It becomes the on-chain sender and Enoki sponsors it. */
  delegateSender: string;
}

/** `core/sdk.tokens.ts:17-42` */
export type PublicTxResponse =
  | { sponsored: true; txBytes: string; digest: string }
  | { sponsored: false; txBytes: string; selfPayReason?: string };

/** `predict/bet/dto/predict-bet-tx.dto.ts:26-90` */
export interface PlaceBetBody extends PublicTxBody {
  accountId: string;
  /** The on-chain market id, `0x` + 64 hex. */
  marketId: string;
  selection: 'YES' | 'NO';
  /** wxUSD base units, 6 decimals. At least 1_000_000. */
  maxSpend: string;
  /** Raw shares, 6 decimals. */
  minShares: string;
  /** Maximum price per share, in bps of $1. At most 10000. */
  priceCapBps: string;
  /** Absolute unix milliseconds. */
  expiryTs: string;
}

/** `predict/bet/dto/predict-bet-tx.dto.ts:130-182` */
export interface SellBetBody extends PublicTxBody {
  accountId: string;
  positionId: string;
  /** Raw shares. Omitted for a full close. */
  closeShares?: string;
  /** 0..9999 as a string. The backend prices `min_proceeds` from its own bid. */
  slippageBps: string;
  /** Absolute unix milliseconds. */
  expiryTs: string;
}

/** `sponsor/execute-sponsored.dto.ts:7-29` */
export interface SponsorExecuteBody {
  digest: string;
  signature: string;
  source?: string;
}

/** `predict/domain/predict-round.ts:32-66` */
export interface PublicRoundSide {
  key: string;
  oddsCents: number | null;
  noOddsCents?: number | null;
  trade?: { marketId: string; selection: 'YES' | 'NO' };
}

/** `predict/domain/predict-round.ts`; `startsAt` / `endsAt` are unix SECONDS. */
export interface PublicRound {
  id: string;
  marketId: string;
  phase: string;
  startsAt: number | null;
  endsAt: number | null;
  sides: PublicRoundSide[];
}

export interface PublicCatalogMarket {
  id: string;
  slug: string;
  /** Null for some politics markets, whose text is in `display.question`. */
  title: string | null;
  category: string;
  eventId?: string | null;
  display?: { question?: string | null } | null;
}

/** `predict/application/predict-browse.service.ts:120-147` */
export interface PublicBrowseItem {
  kind: string;
  market?: PublicCatalogMarket;
  nextRound?: PublicRound | null;
}

export interface PublicBrowseResponse {
  items: PublicBrowseItem[];
  nextCursor: string | null;
}

/** `{ [roundId]: { [sideKey]: cents | null } }` — cents at one decimal. */
export type PublicQuoteBoard = Record<string, Record<string, number | null>>;

/** `predict/bet/domain/bet.ts:239-388` */
export interface PublicBet {
  /** `${onchainMarketIdHex}:${positionId}`, or `${hex}:order:${orderId}` while unfilled. */
  betId: string;
  /** Stable from placement through the fill. */
  orderId: string | null;
  /** The CATALOG market id, not the on-chain one. */
  marketId: string;
  roundId: string;
  /** `''` until the order fills. */
  positionId: string;
  marketSlug: string;
  /** Discriminated by `kind`: crypto, sport, sport-line, sport-award, politics, binary, numeric. */
  cardSnapshot?: { kind: string };
  roundEndsAt: number | null;
  side: string;
  /** True when the bet is the NO leg of `side`. */
  betAgainst?: boolean;
  lockedOddsCents: number;
  avgFillPriceCents?: number | null;
  stake: { amountUsd: number; token: 'USD' };
  placedAt: number;
  settledAt: number | null;
  outcome: 'pending' | 'won' | 'lost' | 'refund' | 'unfilled';
  submissionState: 'confirmed' | 'submitting';
  payoutUsd: number | null;
  /** Filled shares, in display units (not raw). */
  shares?: number;
  saleState?: 'pending' | 'filled' | 'failed' | null;
  saleFailReason?: 'market_moved' | 'expired' | null;
  positionIds?: string[];
}

export interface PublicBetsResponse {
  bets: PublicBet[];
  nextCursor: string | null;
}

/** `predict/bet/domain/activity.ts:4-35` */
export type PublicActivityKind =
  | 'bought'
  | 'bought_pending'
  | 'sold'
  | 'bought_unfilled'
  | 'sell_unfilled'
  | 'won'
  | 'lost'
  | 'refund'
  | 'gift_sent'
  | 'gift_received';

export interface PublicActivityEntry {
  txDigest: string;
  kind: PublicActivityKind;
  timestampMs: number;
  roundId: string;
  side: string;
  betAgainst?: boolean;
  positionIds: string[];
  orderIds: string[];
  shares: number | null;
  amountUsd: number | null;
  oddsCents: number | null;
}

export interface PublicActivityResponse {
  activity: PublicActivityEntry[];
  nextCursor: string | null;
}

/** `account/account.service.ts:65-80` */
export interface PublicAccount {
  accountId: string;
  owner: string;
  accountIndex: number;
  isMainAccount: boolean;
}

/** `account/account.service.ts:126-229` — masks are EFFECTIVE: 0 once expired. */
export interface PublicDelegate {
  delegateAddress: string;
  predictPermissions: number;
  predictPermissionList?: string[];
  expiresAtMs: number | null;
  expired?: true;
  stale?: true;
}

/** `account/account.service.ts:88-123` */
export interface PublicDelegatedResponse {
  accounts: { accountId: string; ownerAddress: string | null; delegate: PublicDelegate }[];
  unverifiedAccounts: string[];
  truncated: boolean;
}

/** `@waterx/sdk` `prediction/constants.js:2-11` */
export const PREDICTION_PERMISSIONS = {
  PLACE_ORDER: 1,
  CANCEL_ORDER: 2,
  CLAIM: 4,
  REQUEST_CLOSE: 8,
} as const;
