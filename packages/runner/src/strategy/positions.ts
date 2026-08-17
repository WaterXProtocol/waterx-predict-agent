/**
 * Finding the position a percentage SELL is a percentage *of*.
 *
 * Only the server knows what an account holds, so freezing "half" at creation is
 * a read before it is arithmetic. Two properties matter more than the lookup
 * itself:
 *
 * - **Not-found must be proven.** The list is paged and `nextCursor` is
 *   three-valued: a string continues, `null` is the server saying it looked past
 *   the end, and ABSENT means it did not answer. Treating the third as the end
 *   would let a real position fall off a page boundary and turn "your position is
 *   not there" into a claim nobody checked. This returns `proven: false` instead,
 *   and the caller refuses rather than sizes.
 * - **The reader is a seam, not a client.** The Runner takes the one method it
 *   needs, structurally satisfied by `PredictAgentClient`, so nothing here
 *   acquires a transport, a token, or an opinion about either.
 */
import { isExhausted, type ListPositionsResponseBody, type PredictPositionSummary } from '@waterx/predict-agent-sdk';

/** The read a frozen fraction needs. `PredictAgentClient` satisfies it as-is. */
export interface StrategyPositionReader {
  getPositions(
    accountId: string,
    page?: { limit?: number; cursor?: string },
    signal?: AbortSignal,
  ): Promise<ListPositionsResponseBody>;
}

export type PositionLookup =
  | { readonly found: true; readonly position: PredictPositionSummary; readonly pagesRead: number }
  | {
      readonly found: false;
      /** Whether the absence is a fact: the server proved the walk reached the end. */
      readonly proven: boolean;
      readonly pagesRead: number;
    };

export interface FindPositionOptions {
  /** A bound on the walk, so a server paging one row at a time cannot hang creation. */
  readonly maxPages?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_MAX_PAGES = 20;

export const findPosition = async (
  reader: StrategyPositionReader,
  accountId: string,
  positionId: string,
  options: FindPositionOptions = {},
): Promise<PositionLookup> => {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesRead = 0;

  while (pagesRead < maxPages) {
    const page = await reader.getPositions(
      accountId,
      cursor === undefined ? undefined : { cursor },
      options.signal,
    );
    pagesRead += 1;

    const match = page.positions.find((position) => position.positionId === positionId);
    if (match !== undefined) return { found: true, position: match, pagesRead };

    if (isExhausted(page)) return { found: false, proven: true, pagesRead };

    const next = page.nextCursor;
    // Absent means the server did not answer the paging question at all, so the
    // walk is incomplete however many rows it read.
    if (typeof next !== 'string') return { found: false, proven: false, pagesRead };
    // A cursor that repeats is a server looping. Stopping is right; calling it
    // exhausted would be the same lie by a different route.
    if (seenCursors.has(next)) return { found: false, proven: false, pagesRead };
    seenCursors.add(next);
    cursor = next;
  }

  return { found: false, proven: false, pagesRead };
};
