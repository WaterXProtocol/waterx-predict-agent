/**
 * Reading a paged history without inventing facts.
 *
 * The wire is deliberately three-valued — a cursor string, `null` for exhausted,
 * or the key absent because the server never answered — and every helper here
 * exists to keep those three apart. Collapsing "unknown" into "done" is how a
 * reconstruction stops early and still reports itself complete.
 */
import type { PredictAgentListQuery, PredictPagedListResponse } from './contract.ts';

/**
 * A page request → the query string the transport sends.
 *
 * An omitted field stays omitted rather than becoming an empty parameter: the
 * server rejects `?cursor=` outright, and it should — a blank cursor is a caller
 * bug, not a request for the first page.
 */
export function pageQuery(
  page?: PredictAgentListQuery,
): Record<string, string | number | undefined> {
  return {
    ...(page?.limit !== undefined ? { limit: page.limit } : {}),
    ...(page?.cursor !== undefined ? { cursor: page.cursor } : {}),
  };
}

/**
 * Is there another page? `true`, `false`, or `null` for "the server did not say".
 *
 * `null` is not a soft `false`. It means this deployment predates keyset paging,
 * so the history may continue past what was returned and nothing here can tell.
 * A caller that must be complete should treat `null` as a failure to answer,
 * not as the end.
 */
export function hasMorePages(response: PredictPagedListResponse): boolean | null {
  if (!('nextCursor' in response) || response.nextCursor === undefined) return null;
  return response.nextCursor !== null;
}

/**
 * Is this walk provably finished? True ONLY on an explicit `null` cursor.
 *
 * The counterpart to {@link hasMorePages} for loop conditions, where the safe
 * default under uncertainty is "keep the door open" rather than "stop".
 */
export function isExhausted(response: PredictPagedListResponse): boolean {
  return hasMorePages(response) === false;
}
