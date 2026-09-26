import type { ProfileDetail, QueryPage, Relationship } from '../backend/queries';
import { appendSearchPage, normalizeSearchQuery } from './lookup';

// Task 12: UI-framework-agnostic search state machine.
//
// Ownership: every timing and staleness rule of the User ID search —
// the 2-character minimum (2文字以上で入力すると検索する), the 300ms
// debounce after typing stops (入力停止から300ミリ秒), IME composition
// suppression (入力変換中は検索しない), generation-based discarding of
// older responses (古い結果で最新の結果を上書きしない), keyset page
// append with a cursor reset whenever the query changes, and the
// offline / network-failure distinction. The screen (friends/add.tsx)
// wires TextInput events into `handleTextChange` and renders
// `getState()`; tests drive the whole machine through an injected clock
// (`timers`), so no real time passes in unit tests.
//
// The server stays authoritative for matching and ordering: the
// controller only relays `search(query, cursor)` pages (backend/queries.ts)
// and copies relationship labels through untouched.

/** 2文字以上で入力したときだけ検索する (グローバル制約). */
export const SEARCH_MIN_CHARS = 2;

/** 入力停止からこのミリ秒後に検索する (グローバル制約). */
export const SEARCH_DEBOUNCE_MS = 300;

/** Why a read failed: no connection vs. a connection that failed. */
export type SearchErrorKind = 'offline' | 'network';

export type SearchStatus =
  | 'idle'
  /** Non-empty input below {@link SEARCH_MIN_CHARS}: show the length hint. */
  | 'tooShort'
  /** IME composition is active: no request may start. */
  | 'composing'
  /** The debounce timer is running. */
  | 'debouncing'
  /** First page request in flight. */
  | 'loading'
  /** Results for `completedQuery` are on screen (may legitimately be empty). */
  | 'success'
  | 'error';

export interface SearchState {
  /** Raw text currently in the input (kept even while composing). */
  input: string;
  composing: boolean;
  status: SearchStatus;
  results: ProfileDetail[];
  /** Cursor for 「もっと見る」; null on the last page or before a search. */
  nextCursor: string | null;
  /** Query the visible results / in-flight request belong to. */
  searchedQuery: string | null;
  /** Query whose completed results are on screen (status === 'success'). */
  completedQuery: string | null;
  /** Set only when status === 'error'. */
  error: SearchErrorKind | null;
  loadingMore: boolean;
  loadMoreError: SearchErrorKind | null;
}

/** Injectable timer port so tests can drive the debounce with a fake clock. */
export interface SearchTimers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

const systemTimers: SearchTimers = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (id) => clearTimeout(id),
};

/**
 * Connectivity seam. `navigator.onLine` where the platform exposes it
 * (web / future expo-network shim — Task 20 replaces this default),
 * otherwise "online": an unknown connectivity state must not disable
 * reads. Tests override the probe through the `isOnline` option.
 */
export function defaultIsOnline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: unknown } }).navigator;
  if (nav !== undefined && typeof nav.onLine === 'boolean') return nav.onLine;
  return true;
}

/**
 * 関係ラベル: the API's `relationship` value rendered as visible text.
 * The relationship itself always comes from the reference API — this map
 * only names the value the server sent (a pending request is therefore
 * never drawn as a friend).
 */
export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  self: '自分',
  friend: '友達',
  request_outgoing: '申請中',
  request_incoming: '申請受信中',
  none: '未申請',
};

export interface SearchPageFetch {
  (query: string, cursor: string | null): Promise<QueryPage<ProfileDetail>>;
}

export interface SearchControllerOptions {
  search: SearchPageFetch;
  /** Injected timers (tests); defaults to setTimeout/clearTimeout. */
  timers?: SearchTimers;
  /** Injected connectivity probe (tests / Task 20); defaults to defaultIsOnline. */
  isOnline?: () => boolean;
}

const INITIAL_STATE: SearchState = {
  input: '',
  composing: false,
  status: 'idle',
  results: [],
  nextCursor: null,
  searchedQuery: null,
  completedQuery: null,
  error: null,
  loadingMore: false,
  loadMoreError: null,
};

export class SearchController {
  private readonly search: SearchPageFetch;
  private readonly timers: SearchTimers;
  private readonly isOnline: () => boolean;
  private readonly listeners = new Set<(state: SearchState) => void>();

  private state: SearchState = INITIAL_STATE;
  /** Bumped for every first-page request; older generations never commit. */
  private generation = 0;
  private debounceId: number | null = null;
  private composing = false;

  constructor(options: SearchControllerOptions) {
    this.search = options.search;
    this.timers = options.timers ?? systemTimers;
    this.isOnline = options.isOnline ?? defaultIsOnline;
  }

  getState(): SearchState {
    return this.state;
  }

  subscribe(listener: (state: SearchState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Text change from the input. `composing` is the onChange composing
   * detection the screen forwards (IME変換中は検索しない): while true no
   * debounce may run, and the pending one is cancelled immediately.
   */
  handleTextChange(text: string, options: { composing?: boolean } = {}): void {
    const composing = options.composing === true;
    this.composing = composing;
    this.cancelDebounce();
    this.commit({ input: text, composing });
    if (composing) {
      this.refreshComposingStatus();
      return;
    }
    this.evaluate();
  }

  /** Composition boundary without a text change (composition end keeps the same text). */
  setComposing(composing: boolean): void {
    if (composing === this.composing) return;
    this.composing = composing;
    this.cancelDebounce();
    if (composing) {
      this.commit({ composing: true });
      this.refreshComposingStatus();
      return;
    }
    this.commit({ composing: false });
    this.evaluate();
  }

  /** 「もっと見る」: append the next page of the CURRENT query. */
  loadMore(): void {
    const { status, nextCursor, searchedQuery, loadingMore, results } = this.state;
    if (status !== 'success' || nextCursor === null || searchedQuery === null || loadingMore) {
      return;
    }
    if (!this.isOnline()) {
      this.commit({ loadMoreError: 'offline' });
      return;
    }
    const generation = this.generation;
    const query = searchedQuery;
    this.commit({ loadingMore: true, loadMoreError: null });
    this.search(query, nextCursor)
      .then((page) => {
        // A query change bumps the generation: a slow older page must
        // never append itself onto the new query's results.
        if (generation !== this.generation) return;
        if (query !== normalizeSearchQuery(this.state.input)) return;
        this.commit({
          results: appendSearchPage(this.state.results, page),
          nextCursor: page.nextCursor,
          loadingMore: false,
          loadMoreError: null,
        });
      })
      .catch(() => {
        if (generation !== this.generation) return;
        this.commit({ loadingMore: false, loadMoreError: this.classifyError() });
      });
  }

  /** Retry the failed first page, or the failed page append when one exists. */
  retry(): void {
    if (this.composing) return;
    this.cancelDebounce();
    const query = normalizeSearchQuery(this.state.input);
    if (
      this.state.loadMoreError !== null &&
      this.state.results.length > 0 &&
      this.state.nextCursor !== null
    ) {
      this.commit({ loadMoreError: null });
      this.loadMore();
      return;
    }
    if (query.length >= SEARCH_MIN_CHARS) {
      void this.beginSearch();
    }
  }

  dispose(): void {
    this.cancelDebounce();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private commit(partial: Partial<SearchState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of [...this.listeners]) listener(this.state);
  }

  private cancelDebounce(): void {
    if (this.debounceId !== null) {
      this.timers.clear(this.debounceId);
      this.debounceId = null;
    }
  }

  private classifyError(): SearchErrorKind {
    return this.isOnline() ? 'network' : 'offline';
  }

  /** Status while composition may have cancelled a scheduled search. */
  private refreshComposingStatus(): void {
    const { status } = this.state;
    if (status === 'loading' || status === 'success' || status === 'error') return;
    const query = normalizeSearchQuery(this.state.input);
    if (query === '') {
      this.commit({ status: 'idle' });
      return;
    }
    if (query.length < SEARCH_MIN_CHARS) {
      this.commit({ status: 'tooShort' });
      return;
    }
    this.commit({ status: 'composing' });
  }

  /** Decide what a (non-composing) input state deserves. */
  private evaluate(): void {
    const query = normalizeSearchQuery(this.state.input);
    if (query === '') {
      this.cancelDebounce();
      this.commit({
        status: 'idle',
        results: [],
        nextCursor: null,
        searchedQuery: null,
        completedQuery: null,
        error: null,
        loadingMore: false,
        loadMoreError: null,
      });
      return;
    }
    if (query.length < SEARCH_MIN_CHARS) {
      this.cancelDebounce();
      this.commit({
        status: 'tooShort',
        results: [],
        nextCursor: null,
        searchedQuery: null,
        completedQuery: null,
        error: null,
        loadingMore: false,
        loadMoreError: null,
      });
      return;
    }
    if (query === this.state.completedQuery) {
      // The input came back to the query already on screen.
      this.cancelDebounce();
      this.commit({ status: 'success', error: null, loadMoreError: null });
      return;
    }
    if (
      query === this.state.searchedQuery &&
      (this.state.status === 'loading' || this.state.status === 'debouncing')
    ) {
      // Already scheduled or in flight for exactly this query.
      return;
    }
    this.scheduleDebounce();
  }

  private scheduleDebounce(): void {
    this.cancelDebounce();
    this.commit({ status: 'debouncing' });
    this.debounceId = this.timers.set(() => {
      this.debounceId = null;
      void this.beginSearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  private async beginSearch(): Promise<void> {
    const query = normalizeSearchQuery(this.state.input);
    if (query.length < SEARCH_MIN_CHARS || this.composing) return;
    if (!this.isOnline()) {
      this.commit({
        status: 'error',
        error: 'offline',
        results: [],
        nextCursor: null,
        searchedQuery: query,
        completedQuery: null,
        loadingMore: false,
        loadMoreError: null,
      });
      return;
    }
    const generation = ++this.generation;
    this.commit({
      status: 'loading',
      error: null,
      results: [],
      nextCursor: null,
      searchedQuery: query,
      completedQuery: null,
      loadingMore: false,
      loadMoreError: null,
    });
    try {
      const page = await this.search(query, null);
      if (!this.isCurrent(generation, query)) return;
      this.commit({
        status: 'success',
        results: page.items,
        nextCursor: page.nextCursor,
        searchedQuery: query,
        completedQuery: query,
        error: null,
      });
    } catch {
      if (!this.isCurrent(generation, query)) return;
      this.commit({
        status: 'error',
        error: this.classifyError(),
        results: [],
        nextCursor: null,
        searchedQuery: query,
        completedQuery: null,
      });
    }
  }

  /**
   * A response may commit only when it is the NEWEST generation and its
   * query is still what the input holds — an older, slower response can
   * therefore never overwrite a newer one.
   */
  private isCurrent(generation: number, query: string): boolean {
    return generation === this.generation && query === normalizeSearchQuery(this.state.input);
  }
}
