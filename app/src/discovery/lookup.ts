import type { ProfileDetail, QueryPage } from '../backend/queries';

// Task 5: discovery lookup primitives.
//
// Ownership: the client half of the search contract that
// supabase/migrations/0010_discovery_queries.sql enforces server side -
// query normalization, the exact/prefix/substring classification with
// literal (never LIKE-wildcard) semantics, the same ordering the server
// applies (match class, then the normalized User ID, then the internal
// id), and the 20-item page append that never duplicates a row across
// "もっと見る" clicks. The server stays authoritative: these primitives
// describe and verify the contract for the UI (Task 12) and its tests;
// they do not fetch anything - app/src/backend/queries.ts does.
//
// `resolveSingleCandidate` remains only for the legacy one-candidate
// confirmation flow; multi-candidate search never routes through it.

export interface PublicProfile {
  displayName: string;
  userIdText: string;
  avatarPath: string | null;
  introduction: string | null;
}

export function resolveSingleCandidate(candidates: PublicProfile[]): PublicProfile {
  if (candidates.length !== 1) {
    throw new Error('User ID input must resolve to exactly one candidate.');
  }
  return candidates[0];
}

/** One search page holds 20 rows; "もっと見る" fetches the next page. */
export const SEARCH_PAGE_SIZE = 20;

export type SearchMatchClass = 'exact' | 'prefix' | 'substring';

/** The server's query normalization: trim (ECMAScript whitespace set, the
 *  same one command_boundary.visual_trim implements) then casefold. */
export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Classify one User ID against a search query with LITERAL semantics:
 * `_`, `%` and every other character match only themselves (the server
 * uses equality / starts_with / position, never LIKE). Returns null when
 * the id does not match at all.
 */
export function matchClass(query: string, userIdText: string): SearchMatchClass | null {
  const normalized = normalizeSearchQuery(query);
  if (normalized === '') return null;
  const id = userIdText.toLowerCase();
  if (id === normalized) return 'exact';
  if (id.startsWith(normalized)) return 'prefix';
  if (id.includes(normalized)) return 'substring';
  return null;
}

const MATCH_CLASS_ORDER: Record<SearchMatchClass, number> = {
  exact: 0,
  prefix: 1,
  substring: 2,
};

/**
 * The server's total order over one query's results: match class, then
 * the normalized User ID (byte order - ids are ASCII, so JavaScript's
 * code-unit comparison equals the server's COLLATE "C"), then the
 * internal user id as the stable tiebreak.
 */
export function compareSearchMatches(
  a: ProfileDetail,
  b: ProfileDetail,
  query: string,
): number {
  const classA = matchClass(query, a.userIdText);
  const classB = matchClass(query, b.userIdText);
  const orderA = classA === null ? MATCH_CLASS_ORDER.substring + 1 : MATCH_CLASS_ORDER[classA];
  const orderB = classB === null ? MATCH_CLASS_ORDER.substring + 1 : MATCH_CLASS_ORDER[classB];
  if (orderA !== orderB) return orderA - orderB;

  const keyA = a.userIdText.toLowerCase();
  const keyB = b.userIdText.toLowerCase();
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
  return 0;
}

/**
 * Append a fetched page to the accumulated results ("もっと見る"), keeping
 * server order and dropping any row whose internal user id is already
 * present - a page boundary can therefore never show a duplicate, even if
 * the underlying data shifted between the two requests.
 */
export function appendSearchPage(
  existing: ProfileDetail[],
  page: QueryPage<ProfileDetail>,
): ProfileDetail[] {
  const seen = new Set(existing.map((profile) => profile.userId));
  const merged = existing.slice();
  for (const item of page.items) {
    if (seen.has(item.userId)) continue;
    seen.add(item.userId);
    merged.push(item);
  }
  return merged;
}
