import { AppState } from 'react-native';

import { listFriends, type ProfileDetail, type QueryPage } from '../backend/queries';
import { appendSearchPage } from '../discovery/lookup';
import { defaultIsOnline } from '../discovery/searchController';
import { readCache, writeCache } from '../storage/cache';
import type { Storage } from '../storage/database';
import type { AppStateLike } from '../theme/provider';

// Task 12: cached read facade over the friends list.
//
// Ownership: the friends screen's data layer — the account-scoped
// `friends.list` cache entry (storage/cache.ts, `fetched_at` included so
// the screen can show 最終更新), the `list_friends` read with page
// append, the display-name ordering the spec demands (日本語向け文字列
// 照合による表示名順、同名ならUser ID順), and the two refresh triggers
// (復帰 = app resume, 成立 = friendship established). Task 19 reuses the
// same repository for notification-driven refresh, so all three entry
// points (peek/refresh/loadMore + the two subscriptions) are plain
// module functions, not screen state.
//
// The repository never decides who is a friend: the server's
// `list_friends` rows are copied through, so a pending request can never
// be drawn as a friend here.

export type FriendsErrorKind = 'offline' | 'network';

export interface FriendsSnapshot {
  /** Sorted by Japanese-collated display name, ties broken by User ID. */
  friends: ProfileDetail[];
  nextCursor: string | null;
  /** `fetched_at` of the last successful server read (null = never). */
  fetchedAt: number | null;
  error: FriendsErrorKind | null;
}

export interface FriendsRepository {
  /** Cache-backed snapshot for instant display; null when nothing cached. */
  peek(): Promise<FriendsSnapshot | null>;
  /** Fetch the first page; on failure the current snapshot + error kind. */
  refresh(): Promise<FriendsSnapshot>;
  /** Append the next page (もっと見る). */
  loadMore(): Promise<FriendsSnapshot>;
  /** Last successful read time, for 最終更新. */
  lastUpdated(): number | null;
}

export interface FriendsRepositoryOptions {
  storage: Storage | null;
  accountId: string;
  /** Injected page fetch (tests); defaults to the app-query adapter. */
  fetchPage?: (cursor: string | null) => Promise<QueryPage<ProfileDetail>>;
  /** Injected clock (tests); defaults to Date.now. */
  now?: () => number;
  /** Injected connectivity probe (tests / Task 20). */
  isOnline?: () => boolean;
}

export const FRIENDS_CACHE_KEY = 'friends.list';

interface FriendsCachePayload {
  items: ProfileDetail[];
  nextCursor: string | null;
}

// Japanese-collation ordering (CLDR gojūon for kana; the spec accepts that
// kanji reading order is not guaranteed — ふりがなを追加しない). Hermes
// builds without Intl fall back to code-unit order instead of crashing.
const jaCollator: Intl.Collator | null = (() => {
  try {
    return typeof Intl !== 'undefined' && typeof Intl.Collator === 'function'
      ? new Intl.Collator('ja')
      : null;
  } catch {
    return null;
  }
})();

/** 表示名順 (日本語向け文字列照合)、同名ならUser ID順、最後に内部ID. */
export function compareFriendRows(a: ProfileDetail, b: ProfileDetail): number {
  if (jaCollator !== null) {
    const byName = jaCollator.compare(a.displayName, b.displayName);
    if (byName !== 0) return byName;
  } else if (a.displayName !== b.displayName) {
    return a.displayName < b.displayName ? -1 : 1;
  }
  if (a.userIdText !== b.userIdText) return a.userIdText < b.userIdText ? -1 : 1;
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
  return 0;
}

export function sortFriendRows(items: ProfileDetail[]): ProfileDetail[] {
  return items.slice().sort(compareFriendRows);
}

/** 最終更新 HH:MM (端末の現地時刻, no Intl dependency). */
export function formatLastUpdated(fetchedAt: number): string {
  const date = new Date(fetchedAt);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `最終更新 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function createFriendsRepository(
  options: FriendsRepositoryOptions,
): FriendsRepository {
  const { accountId, storage } = options;
  const fetchPage = options.fetchPage ?? ((cursor) => listFriends(cursor));
  const now = options.now ?? (() => Date.now());
  const isOnline = options.isOnline ?? defaultIsOnline;

  let state: FriendsSnapshot = {
    friends: [],
    nextCursor: null,
    fetchedAt: null,
    error: null,
  };
  let cacheHydrated = false;
  let inFlight: Promise<FriendsSnapshot> | null = null;

  async function hydrateFromCache(): Promise<void> {
    if (cacheHydrated) return;
    cacheHydrated = true;
    if (storage === null) return;
    try {
      const record = await readCache<FriendsCachePayload>(
        storage,
        accountId,
        FRIENDS_CACHE_KEY,
      );
      if (record === null) return;
      state = {
        friends: sortFriendRows(record.payload.items ?? []),
        nextCursor: record.payload.nextCursor ?? null,
        fetchedAt: record.fetchedAt,
        error: null,
      };
    } catch {
      // An unreadable cache never blocks the screen; the network read below
      // is the authority anyway.
    }
  }

  async function persist(): Promise<void> {
    if (storage === null || state.fetchedAt === null) return;
    try {
      await writeCache(
        storage,
        accountId,
        FRIENDS_CACHE_KEY,
        { items: state.friends, nextCursor: state.nextCursor } satisfies FriendsCachePayload,
        state.fetchedAt,
      );
    } catch {
      // Cache write failures degrade to "no cache", never to a screen error.
    }
  }

  function failure(): FriendsSnapshot {
    state = { ...state, error: isOnline() ? 'network' : 'offline' };
    return state;
  }

  function readFirstPage(): Promise<FriendsSnapshot> {
    return (async () => {
      try {
        const page = await fetchPage(null);
        const fetchedAt = now();
        state = {
          friends: sortFriendRows(page.items),
          nextCursor: page.nextCursor,
          fetchedAt,
          error: null,
        };
        await persist();
        return state;
      } catch {
        return failure();
      } finally {
        inFlight = null;
      }
    })();
  }

  return {
    async peek(): Promise<FriendsSnapshot | null> {
      await hydrateFromCache();
      if (state.fetchedAt === null && state.friends.length === 0) return null;
      return state;
    },

    async refresh(): Promise<FriendsSnapshot> {
      await hydrateFromCache();
      if (!isOnline()) {
        state = { ...state, error: 'offline' };
        return state;
      }
      if (inFlight !== null) return inFlight;
      inFlight = readFirstPage();
      return inFlight;
    },

    async loadMore(): Promise<FriendsSnapshot> {
      const cursor = state.nextCursor;
      if (cursor === null) return state;
      if (!isOnline()) {
        state = { ...state, error: 'offline' };
        return state;
      }
      if (inFlight !== null) return inFlight;
      inFlight = (async () => {
        try {
          const page = await fetchPage(cursor);
          const merged = appendSearchPage(state.friends, page);
          state = {
            friends: sortFriendRows(merged),
            nextCursor: page.nextCursor,
            fetchedAt: now(),
            error: null,
          };
          await persist();
          return state;
        } catch {
          return failure();
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },

    lastUpdated(): number | null {
      return state.fetchedAt;
    },
  };
}

// ---------------------------------------------------------------------------
// Refresh triggers (復帰 / 友達成立)
// ---------------------------------------------------------------------------

const friendsChangedListeners = new Set<() => void>();

/**
 * Subscribe to "a friendship was established or changed" — screens
 * refresh the list when this fires. Call {@link notifyFriendsChanged}
 * after any friendship mutation (approval, mutual request, removal —
 * later tasks).
 */
export function subscribeFriendsChanged(listener: () => void): () => void {
  friendsChangedListeners.add(listener);
  return () => {
    friendsChangedListeners.delete(listener);
  };
}

export function notifyFriendsChanged(): void {
  for (const listener of [...friendsChangedListeners]) listener();
}

/**
 * App-resume trigger (接続復帰・アプリ復帰で再試行). The AppState source is
 * injectable (same contract as ThemeProvider); a platform without a usable
 * AppState degrades to "no resume trigger" instead of throwing.
 */
export function subscribeAppResume(
  onActive: () => void,
  appState: AppStateLike = AppState,
): () => void {
  try {
    const subscription = appState.addEventListener('change', (status) => {
      if (status === 'active') onActive();
    });
    return () => {
      try {
        subscription.remove();
      } catch {
        // Already removed — unsubscribing twice must stay safe.
      }
    };
  } catch {
    return () => {
      // No app-state source in this environment.
    };
  }
}
