import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';

import { QueryError, getProfile, listFriends, searchProfiles } from '../src/backend/queries';
import type { ProfileDetail, QueryPage } from '../src/backend/queries';
import { AddArea } from '../src/app/(tabs)/friends/add';
import { ProfilePanel } from '../src/app/(tabs)/friends/[userId]';
import {
  RELATIONSHIP_LABELS,
  SEARCH_DEBOUNCE_MS,
  SearchController,
} from '../src/discovery/searchController';
import { AdaptiveLayoutProvider } from '../src/navigation/AdaptiveLayout';
import {
  createFriendsRepository,
  formatLastUpdated,
  notifyFriendsChanged,
  sortFriendRows,
  subscribeAppResume,
  subscribeFriendsChanged,
} from '../src/requests/friendsRepository';
import { zeroFriendGuidance } from '../src/requests/zeroFriends';
import { ThemeProvider } from '../src/theme/provider';
import type { Storage } from '../src/storage/database';

// Task 12: 友達一覧・部分一致検索・プロフィール閲覧.
//
// MOCKED-LAYER: `backend/queries` is the injected wire (the server
// contract itself is verified by pgTAP/deno suites); the auth context is
// injected like navigation-shell / theme-layout, and the account cache
// runs through the REAL storage/cache.ts SQL statements against a fake
// Storage handle (SQL semantics are covered by storage.integration).
// Timers: the controller unit tests drive an injected clock (exact
// 299/300ms assertions); the screen tests use real timers inside `act`.

// ---------------------------------------------------------------------------
// Module mocks (hoisted by jest; factories read mock* bindings lazily)
// ---------------------------------------------------------------------------

let mockFriendsStorage: Storage | null = null;

jest.mock('../src/auth/provider', () => {
  const React = require('react');
  const value = {
    status: 'ready',
    error: null,
    accountId: 'account-friends',
    registration: 'registered',
    onboardingSeen: false,
    get storage() {
      return mockFriendsStorage;
    },
    refresh: async () => {},
    signIn: async () => ({ status: 'cancelled' }),
    submitRegistration: async () => ({ status: 'registered' }),
    markOnboardingSeen: async () => true,
    markOnboardingSeenIfInvited: async () => false,
  };
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useAuth: () => value,
    classifyCompletedLogin: () => ({ kind: 'returning', accountId: 'account-friends' }),
  };
});

jest.mock('../src/backend/queries', () => {
  const actual = jest.requireActual('../src/backend/queries');
  return {
    ...actual,
    searchProfiles: jest.fn(),
    getProfile: jest.fn(),
    listFriends: jest.fn(),
    listRequests: jest.fn(),
  };
});

const mockSearchProfiles = jest.mocked(searchProfiles);
const mockGetProfile = jest.mocked(getProfile);
const mockListFriends = jest.mocked(listFriends);

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function detail(userIdText: string, n: number, overrides: Partial<ProfileDetail> = {}): ProfileDetail {
  return {
    userId: uuid(n),
    userIdText,
    displayName: 'あおい',
    avatarPath: null,
    introduction: null,
    relationship: 'none',
    ...overrides,
  };
}

function page(items: ProfileDetail[], nextCursor: string | null = null): QueryPage<ProfileDetail> {
  return { items, nextCursor };
}

const emptyPage = (): QueryPage<ProfileDetail> => page([]);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits real time (debounce) inside `act` so timer-driven commits are captured. */
async function advanceReal(ms: number): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
}

/** Drains pending promise chains started by a controller/repository call. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

/** Injected clock for the debounce (exact 299/300ms boundaries). */
function manualClock(): {
  timers: { set(fn: () => void, ms: number): number; clear(id: number): void };
  advance: (ms: number) => void;
} {
  let now = 0;
  let sequence = 1;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set(fn: () => void, ms: number): number {
        const id = sequence;
        sequence += 1;
        tasks.set(id, { at: now + ms, fn });
        return id;
      },
      clear(id: number): void {
        tasks.delete(id);
      },
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let dueId: number | null = null;
        let due: { at: number; fn: () => void } | null = null;
        for (const [id, task] of tasks) {
          if (task.at <= target && (due === null || task.at < due.at)) {
            due = task;
            dueId = id;
          }
        }
        if (due === null || dueId === null) break;
        tasks.delete(dueId);
        now = due.at;
        due.fn();
      }
      now = target;
    },
  };
}

/** Fake account Storage: the real cache.ts SQL runs against this map. */
function fakeStorage(): Storage {
  const rows = new Map<string, { payload: string; fetched_at: number }>();
  const db = {
    rows,
    async getFirstAsync(sql: string, params?: readonly unknown[]): Promise<unknown> {
      if (sql.includes('FROM cache') && params) {
        return rows.get(`${String(params[0])}|${String(params[1])}`) ?? null;
      }
      return null;
    },
    async withWriteTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        async runAsync(sql: string, params?: readonly unknown[]) {
          if (sql.includes('INSERT INTO cache') && params) {
            rows.set(`${String(params[0])}|${String(params[1])}`, {
              payload: String(params[2]),
              fetched_at: Number(params[3]),
            });
            return { changes: 1, lastInsertRowId: 0 };
          }
          return { changes: 0, lastInsertRowId: 0 };
        },
      };
      return fn(tx);
    },
  };
  return db as unknown as Storage;
}

function memoryStore(): { store: import('../src/theme/provider').ThemeSettingsStore } {
  const data = new Map<string, string>();
  return {
    store: {
      read: async (key: string) => data.get(key) ?? null,
      write: async (key: string, value: string) => {
        data.set(key, value);
      },
    },
  };
}

function addTree(store: import('../src/theme/provider').ThemeSettingsStore, width: number) {
  return (
    <ThemeProvider store={store} deviceScheme="light">
      <AdaptiveLayoutProvider>
        <AddArea metrics={{ width, fontScale: 1 }} />
      </AdaptiveLayoutProvider>
    </ThemeProvider>
  );
}

function profileTree(store: import('../src/theme/provider').ThemeSettingsStore, userId: string) {
  return (
    <ThemeProvider store={store} deviceScheme="light">
      <ProfilePanel userId={userId} />
    </ThemeProvider>
  );
}

async function renderApp(initialUrl: string) {
  const router = await renderRouter('./src/app', { initialUrl });
  return {
    app: {
      getPathname: () => router.getPathname(),
      unmount: async () => {
        await router.unmount();
      },
    },
  };
}

function fakeAppState() {
  const listeners = new Set<(state: string) => void>();
  return {
    appState: {
      addEventListener: (_type: string, handler: (state: string) => void) => {
        listeners.add(handler);
        return {
          remove: () => {
            listeners.delete(handler);
          },
        };
      },
    },
    emit: (state: string) => {
      for (const handler of [...listeners]) handler(state);
    },
  };
}

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setNavigatorOnline(online: boolean): void {
  const current = (globalThis as { navigator?: unknown }).navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...(current as object), onLine: online },
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

function restoreNavigator(): void {
  if (navigatorDescriptor !== undefined) {
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
}

beforeEach(() => {
  // Reset ONLY the injected wire mocks: a blanket jest.resetAllMocks()
  // would wipe jest-expo's internal native mocks (AppState, Linking…) and
  // break the router and the theme provider.
  mockSearchProfiles.mockReset();
  mockGetProfile.mockReset();
  mockListFriends.mockReset();
  mockFriendsStorage = fakeStorage();
  mockSearchProfiles.mockResolvedValue(emptyPage());
  mockListFriends.mockResolvedValue(emptyPage());
  mockGetProfile.mockResolvedValue(detail('placeholder', 999));
});

afterEach(() => {
  restoreNavigator();
});

// ---------------------------------------------------------------------------
// A. searchController: 2文字境界, 300ms debounce, 変換中抑止
// ---------------------------------------------------------------------------

describe('searchController (debounce・変換中・世代)', () => {
  it('searches only from 2 characters, exactly 300ms after typing stops', async () => {
    const clock = manualClock();
    const search = jest.fn().mockResolvedValue(page([detail('ab_01', 1)]));
    const controller = new SearchController({ search, timers: clock.timers });

    controller.handleTextChange('a');
    clock.advance(5000);
    expect(search).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe('tooShort');

    controller.handleTextChange('  ab  ');
    clock.advance(299);
    expect(search).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe('debouncing');
    clock.advance(1);
    expect(search).toHaveBeenCalledTimes(1);
    // Wire query is normalized (trim + casefold), input display is untouched.
    expect(search).toHaveBeenCalledWith('ab', null);
    await flush();
    expect(controller.getState().status).toBe('success');
    expect(controller.getState().results).toHaveLength(1);
    controller.dispose();
  });

  it('never searches while the IME composition is active, then searches after it ends', async () => {
    const clock = manualClock();
    const search = jest.fn().mockResolvedValue(page([detail('aoi_07', 1)]));
    const controller = new SearchController({ search, timers: clock.timers });

    controller.handleTextChange('あお', { composing: true });
    controller.handleTextChange('あおい', { composing: true });
    clock.advance(5000);
    expect(search).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe('composing');
    expect(controller.getState().input).toBe('あおい');

    controller.handleTextChange('あおい', { composing: false });
    clock.advance(299);
    expect(search).not.toHaveBeenCalled();
    clock.advance(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('あおい', null);
    controller.dispose();
  });

  it('setComposing(true) cancels a pending debounce; setComposing(false) restarts it', async () => {
    const clock = manualClock();
    const search = jest.fn().mockResolvedValue(page([]));
    const controller = new SearchController({ search, timers: clock.timers });

    controller.handleTextChange('ky');
    controller.setComposing(true);
    clock.advance(10000);
    expect(search).not.toHaveBeenCalled();

    controller.setComposing(false);
    clock.advance(299);
    expect(search).not.toHaveBeenCalled();
    clock.advance(1);
    expect(search).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('discards a slow older response so it never overwrites the newer one', async () => {
    const clock = manualClock();
    const slowA = deferred<QueryPage<ProfileDetail>>();
    const fastB = deferred<QueryPage<ProfileDetail>>();
    const search = jest
      .fn()
      .mockImplementationOnce(() => slowA.promise)
      .mockImplementationOnce(() => fastB.promise);
    const controller = new SearchController({ search, timers: clock.timers });

    controller.handleTextChange('ab');
    clock.advance(300); // request A (slow) is in flight
    controller.handleTextChange('cd');
    clock.advance(300); // request B starts

    fastB.resolve(page([detail('cdef', 2)]));
    await flush();
    expect(controller.getState().status).toBe('success');
    expect(controller.getState().results.map((item) => item.userIdText)).toEqual(['cdef']);

    // The OLD response arrives last — it must be dropped entirely.
    slowA.resolve(page([detail('abzz', 1)]));
    await flush();
    expect(controller.getState().results.map((item) => item.userIdText)).toEqual(['cdef']);
    expect(controller.getState().completedQuery).toBe('cd');
    expect(controller.getState().searchedQuery).toBe('cd');
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// B. searchController: もっと見る・cursorリセット・オフライン/通信失敗
// ---------------------------------------------------------------------------

describe('searchController (ページ追加と失敗の区別)', () => {
  it('appends pages with もっと見る and resets the cursor when the query changes', async () => {
    const clock = manualClock();
    const first = Array.from({ length: 20 }, (_, index) =>
      detail(`aoi_${String(index).padStart(2, '0')}`, index + 1),
    );
    const extra = detail('aoi_extra', 100);
    const other = detail('zz_01', 200);
    const search = jest
      .fn()
      .mockResolvedValueOnce(page(first, 'cursor-1'))
      .mockResolvedValueOnce(page([first[19], extra], null))
      .mockResolvedValueOnce(page([other], null));
    const controller = new SearchController({ search, timers: clock.timers });

    controller.handleTextChange('aa');
    clock.advance(300);
    await flush();
    expect(controller.getState().results).toHaveLength(20);
    expect(controller.getState().nextCursor).toBe('cursor-1');

    controller.loadMore();
    await flush();
    expect(search).toHaveBeenLastCalledWith('aa', 'cursor-1');
    expect(controller.getState().results).toHaveLength(21); // boundary row deduped
    expect(controller.getState().nextCursor).toBeNull();

    // 検索条件変更でcursorをリセットする (next search starts from the head).
    controller.handleTextChange('bb');
    clock.advance(300);
    await flush();
    expect(search).toHaveBeenLastCalledWith('bb', null);
    expect(controller.getState().results.map((item) => item.userIdText)).toEqual(['zz_01']);
    controller.dispose();
  });

  it('distinguishes offline (no request attempted) from a network failure (retryable)', async () => {
    const clock = manualClock();
    let online = true;
    const search = jest.fn();
    const controller = new SearchController({
      search,
      timers: clock.timers,
      isOnline: () => online,
    });

    online = false;
    controller.handleTextChange('ab');
    clock.advance(300);
    await flush();
    expect(search).not.toHaveBeenCalled(); // offline never reaches the wire
    expect(controller.getState()).toMatchObject({ status: 'error', error: 'offline' });

    online = true;
    search.mockRejectedValueOnce(new Error('boom'));
    controller.handleTextChange('cd');
    clock.advance(300);
    await flush();
    expect(search).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ status: 'error', error: 'network' });

    search.mockResolvedValueOnce(page([detail('cdef', 2)]));
    controller.retry();
    await flush();
    expect(search).toHaveBeenLastCalledWith('cd', null);
    expect(controller.getState().status).toBe('success');
    controller.dispose();
  });

  it('names the API relationship values with visible labels', () => {
    expect(RELATIONSHIP_LABELS).toEqual({
      self: '自分',
      friend: '友達',
      request_outgoing: '申請中',
      request_incoming: '申請受信中',
      none: '未申請',
    });
  });
});

// ---------------------------------------------------------------------------
// C. friendsRepository: 表示名順・キャッシュ・最終更新・失敗区別
// ---------------------------------------------------------------------------

describe('friendsRepository', () => {
  const FIXED_NOW = new Date(2026, 8, 26, 9, 15, 0).getTime();

  it('sorts by Japanese-collated display name, ties by User ID, and caches with fetched_at', async () => {
    const storage = fakeStorage();
    const rows = [
      detail('zzz', 1, { displayName: 'あおい' }),
      detail('sakura', 2, { displayName: 'さくら' }),
      detail('aaa', 3, { displayName: 'あおい' }),
      detail('komorebi', 4, { displayName: 'こもれび' }),
    ];
    const fetchPage = jest.fn().mockResolvedValue(page(rows));
    const repository = createFriendsRepository({
      storage,
      accountId: 'account-friends',
      fetchPage,
      now: () => FIXED_NOW,
    });

    const snapshot = await repository.refresh();
    expect(snapshot.friends.map((item) => [item.displayName, item.userIdText])).toEqual([
      ['あおい', 'aaa'],
      ['あおい', 'zzz'],
      ['こもれび', 'komorebi'],
      ['さくら', 'sakura'],
    ]);
    expect(snapshot.fetchedAt).toBe(FIXED_NOW);
    expect(snapshot.error).toBeNull();
    expect(formatLastUpdated(FIXED_NOW)).toBe('最終更新 09:15');
    expect(repository.lastUpdated()).toBe(FIXED_NOW);

    // A fresh repository over the same account cache serves without fetching.
    const fetch2 = jest.fn();
    const second = createFriendsRepository({
      storage,
      accountId: 'account-friends',
      fetchPage: fetch2,
      now: () => FIXED_NOW,
    });
    const cached = await second.peek();
    expect(fetch2).not.toHaveBeenCalled();
    expect(cached?.friends).toHaveLength(4);
    expect(cached?.fetchedAt).toBe(FIXED_NOW);
    expect(cached?.friends.map((item) => item.userIdText)[0]).toBe('aaa');
  });

  it('keeps the cached list on a network failure but reports offline without fetching', async () => {
    const storage = fakeStorage();
    let online = true;
    let failNext = false;
    const fetchPage = jest.fn().mockImplementation(async () => {
      if (failNext) throw new Error('boom');
      return page([detail('aoi_07', 1, { displayName: 'あおい', relationship: 'friend' })]);
    });
    const repository = createFriendsRepository({
      storage,
      accountId: 'account-friends',
      fetchPage,
      isOnline: () => online,
      now: () => FIXED_NOW,
    });

    const first = await repository.refresh();
    expect(first.error).toBeNull();
    expect(first.friends).toHaveLength(1);

    failNext = true;
    const failed = await repository.refresh();
    expect(failed.error).toBe('network');
    expect(failed.friends.map((item) => item.userIdText)).toEqual(['aoi_07']); // cache kept
    expect(failed.fetchedAt).toBe(FIXED_NOW); // 最終更新 not invented

    online = false;
    failNext = false;
    const callsBefore = fetchPage.mock.calls.length;
    const offline = await repository.refresh();
    expect(offline.error).toBe('offline');
    expect(fetchPage.mock.calls.length).toBe(callsBefore); // no wire attempt
  });

  it('exposes the friendship-established and app-resume refresh triggers', () => {
    const established = jest.fn();
    const unsubscribe = subscribeFriendsChanged(established);
    notifyFriendsChanged();
    expect(established).toHaveBeenCalledTimes(1);
    unsubscribe();
    notifyFriendsChanged();
    expect(established).toHaveBeenCalledTimes(1);

    const { appState, emit } = fakeAppState();
    const resumed = jest.fn();
    const unsubResume = subscribeAppResume(resumed, appState);
    emit('background');
    expect(resumed).not.toHaveBeenCalled();
    emit('active');
    expect(resumed).toHaveBeenCalledTimes(1);
    unsubResume();
    emit('active');
    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it('sortFriendRows never mutates the input array', () => {
    const input = [detail('z', 1, { displayName: 'さくら' }), detail('a', 2, { displayName: 'あおい' })];
    const sorted = sortFriendRows(input);
    expect(sorted.map((item) => item.userIdText)).toEqual(['a', 'z']);
    expect(input.map((item) => item.userIdText)).toEqual(['z', 'a']);
  });
});

// ---------------------------------------------------------------------------
// D. 友達追加画面: 検索入力 → 候補 → 確認プロフィール
// ---------------------------------------------------------------------------

describe('友達追加画面 (search → candidate → profile)', () => {
  it('shows the length hint below 2 chars, then renders same-name candidates separately', async () => {
    mockSearchProfiles.mockResolvedValue(
      page([
        detail('aoi_01', 1, { displayName: 'あおい' }),
        detail('aoi_02', 2, { displayName: 'あおい' }),
      ]),
    );
    const store = memoryStore().store;
    await render(addTree(store, 900));
    const input = screen.getByTestId('search-input');

    await fireEvent.changeText(input, 'a');
    expect(screen.getByTestId('search-too-short')).toBeTruthy();
    await advanceReal(SEARCH_DEBOUNCE_MS + 50);
    expect(mockSearchProfiles).not.toHaveBeenCalled(); // 1 char never fires

    await fireEvent.changeText(input, 'ao');
    await advanceReal(SEARCH_DEBOUNCE_MS + 50);
    expect(mockSearchProfiles).toHaveBeenCalledWith('ao', null);

    // 同名 results: both rows stay (dedupe is by internal id, never by name).
    await screen.findByTestId('candidate-row-aoi_01');
    expect(screen.getByTestId('candidate-row-aoi_02')).toBeTruthy();
    expect(screen.getAllByText('あおい')).toHaveLength(2);
    expect(screen.getByTestId('candidate-relationship-aoi_01').props.children).toBe('未申請');
  });

  it('suppresses the search during IME composition detected from onChange', async () => {
    mockSearchProfiles.mockResolvedValue(page([detail('aoi_07', 7, { displayName: 'あおい' })]));
    const store = memoryStore().store;
    await render(addTree(store, 900));
    const input = screen.getByTestId('search-input');

    await fireEvent(input, 'change', { nativeEvent: { text: 'あおい', isComposing: true } });
    await fireEvent.changeText(input, 'あおい');
    await advanceReal(SEARCH_DEBOUNCE_MS + 100);
    expect(mockSearchProfiles).not.toHaveBeenCalled(); // 変換中は検索しない

    await fireEvent(input, 'change', { nativeEvent: { text: 'あおい', isComposing: false } });
    await screen.findByTestId('candidate-row-aoi_07');
    expect(mockSearchProfiles).toHaveBeenCalledTimes(1);
  });

  it('reports offline without touching the wire', async () => {
    setNavigatorOnline(false);
    const store = memoryStore().store;
    await render(addTree(store, 900));
    const input = screen.getByTestId('search-input');

    await fireEvent.changeText(input, 'ao');
    await advanceReal(SEARCH_DEBOUNCE_MS + 50);
    expect(mockSearchProfiles).not.toHaveBeenCalled();
    expect(screen.getByTestId('search-offline')).toBeTruthy();
    expect(screen.queryByTestId('search-network')).toBeNull();
  });

  it('opens the confirmation profile of a candidate (internal id, label, no Streak)', async () => {
    mockSearchProfiles.mockResolvedValue(page([detail('aoi_01', 1, { displayName: 'あおい' })]));
    mockGetProfile.mockResolvedValue(
      detail('aoi_01', 1, {
        displayName: 'あおい',
        relationship: 'none',
        introduction: 'よろしくお願いします。',
      }),
    );
    const store = memoryStore().store;
    await render(addTree(store, 900));

    await fireEvent.changeText(screen.getByTestId('search-input'), 'ao');
    await screen.findByTestId('candidate-row-aoi_01');
    await fireEvent.press(screen.getByTestId('candidate-row-aoi_01'));

    await screen.findByTestId('profile-name');
    expect(mockGetProfile).toHaveBeenCalledWith(uuid(1)); // internal uuid from the DTO
    expect(screen.getByTestId('profile-name').props.children).toBe('あおい');
    expect(screen.getByTestId('profile-userid').props.children).toBe('aoi_01');
    expect(screen.getByTestId('profile-relationship').props.children).toBe('未申請');
    expect(screen.getByTestId('profile-introduction').props.children).toBe('よろしくお願いします。');
    // 友達になる前のStreakは見せない.
    expect(screen.queryByTestId('profile-streak')).toBeNull();
  });

  it('appends the next page with もっと見る', async () => {
    const first = Array.from({ length: 20 }, (_, index) =>
      detail(`aoi_${String(index).padStart(2, '0')}`, index + 1),
    );
    const extra = detail('aoi_extra', 100);
    mockSearchProfiles
      .mockResolvedValueOnce(page(first, 'cursor-1'))
      .mockResolvedValueOnce(page([first[19], extra], null));
    const store = memoryStore().store;
    await render(addTree(store, 900));

    await fireEvent.changeText(screen.getByTestId('search-input'), 'ao');
    await screen.findByTestId('candidate-row-aoi_19');
    expect(screen.queryByTestId('candidate-row-aoi_extra')).toBeNull();

    await fireEvent.press(screen.getByTestId('search-load-more'));
    await screen.findByTestId('candidate-row-aoi_extra');
    expect(mockSearchProfiles).toHaveBeenLastCalledWith('ao', 'cursor-1');
    expect(screen.queryByTestId('search-load-more')).toBeNull(); // last page
  });

  it('keeps the selection and the input across a width change (900 → 899 → 900)', async () => {
    mockSearchProfiles.mockResolvedValue(page([detail('aoi_01', 1, { displayName: 'あおい' })]));
    mockGetProfile.mockResolvedValue(detail('aoi_01', 1, { displayName: 'あおい' }));
    const store = memoryStore().store;

    const view = await render(addTree(store, 900));
    await fireEvent.changeText(screen.getByTestId('search-input'), 'ao');
    await screen.findByTestId('candidate-row-aoi_01');
    await fireEvent.press(screen.getByTestId('candidate-row-aoi_01'));
    await screen.findByTestId('profile-name');
    expect(screen.getByTestId('add-layout-list')).toBeTruthy();
    expect(screen.getByTestId('add-layout-detail')).toBeTruthy();

    // 899: single column — the detail replaces the list, same selection,
    // search input untouched.
    await view.rerender(addTree(store, 899));
    expect(screen.queryByTestId('add-layout-list')).toBeNull();
    expect(screen.getByTestId('add-layout-detail')).toBeTruthy();
    expect(screen.getByTestId('profile-name').props.children).toBe('あおい');
    expect(screen.getByTestId('search-input').props.value).toBe('ao');

    // Back to wide: both panes, still the same selected candidate.
    await view.rerender(addTree(store, 900));
    expect(screen.getByTestId('add-layout-list')).toBeTruthy();
    expect(screen.getByTestId('profile-name').props.children).toBe('あおい');
    expect(screen.getByTestId('search-input').props.value).toBe('ao');
  });
});

// ---------------------------------------------------------------------------
// E. プロフィール: Streakは友達前後で変わる・消失と通信失敗の区別
// ---------------------------------------------------------------------------

describe('プロフィール閲覧', () => {
  it('hides Streak before the friendship (pending request included)', async () => {
    mockGetProfile.mockResolvedValue(
      detail('hanako', 5, { displayName: 'はなこ', relationship: 'none' }),
    );
    const store = memoryStore().store;
    await render(profileTree(store, uuid(5)));
    await screen.findByTestId('profile-name');
    expect(screen.getByTestId('profile-relationship').props.children).toBe('未申請');
    expect(screen.queryByTestId('profile-streak')).toBeNull();
  });

  it('never draws a pending request as a friend, even with a stray streak field', async () => {
    mockGetProfile.mockResolvedValue(
      detail('hanako', 5, { displayName: 'はなこ', relationship: 'request_outgoing', streak: 5 }),
    );
    const store = memoryStore().store;
    await render(profileTree(store, uuid(5)));
    await screen.findByTestId('profile-name');
    expect(screen.getByTestId('profile-relationship').props.children).toBe('申請中');
    expect(screen.queryByTestId('profile-streak')).toBeNull();
    expect(screen.queryByText('友達')).toBeNull();
  });

  it('shows Streak once the profile is a friendship', async () => {
    mockGetProfile.mockResolvedValue(
      detail('hanako', 5, { displayName: 'はなこ', relationship: 'friend', streak: 12 }),
    );
    const store = memoryStore().store;
    await render(profileTree(store, uuid(5)));
    await screen.findByTestId('profile-name');
    expect(screen.getByTestId('profile-relationship').props.children).toBe('友達');
    expect(screen.getByTestId('profile-streak').props.children).toBe('12 日 継続');
    expect(screen.getByTestId('profile-streak').props.accessibilityLabel).toBe('12日継続');
  });

  it('separates a block/disappearance (404) from a network failure (retryable)', async () => {
    mockGetProfile.mockRejectedValueOnce(new QueryError('Target user not found.', 404));
    const store = memoryStore().store;
    const view = await render(profileTree(store, uuid(5)));
    await screen.findByTestId('profile-gone');
    expect(screen.queryByTestId('profile-network')).toBeNull();
    await view.unmount();

    mockGetProfile
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(detail('hanako', 5, { displayName: 'はなこ' }));
    const second = await render(profileTree(store, uuid(5)));
    await screen.findByTestId('profile-network');
    expect(screen.queryByTestId('profile-gone')).toBeNull();
    await fireEvent.press(screen.getByTestId('profile-retry'));
    await screen.findByTestId('profile-name');
    await second.unmount();
  });
});

// ---------------------------------------------------------------------------
// F. ルート経由: [userId] は内部uuid、表示はUser ID文字列
// ---------------------------------------------------------------------------

describe('friends/[userId] route', () => {
  it('opens the profile by the internal uuid and shows the visible User ID', async () => {
    mockGetProfile.mockResolvedValue(
      detail('Qorder_1', 42, { displayName: 'Q order', relationship: 'friend', streak: 3 }),
    );
    const { app } = await renderApp(`/friends/${uuid(42)}`);
    await waitFor(() => expect(app.getPathname()).toBe(`/friends/${uuid(42)}`));
    await screen.findByTestId('profile-name');
    expect(mockGetProfile).toHaveBeenCalledWith(uuid(42));
    expect(screen.getByTestId('profile-userid').props.children).toBe('Qorder_1');
    expect(screen.getByTestId('profile-streak').props.children).toBe('3 日 継続');
  });
});

// ---------------------------------------------------------------------------
// G. 友達一覧: キャッシュ・最終更新・状態区別・復帰/成立更新
// ---------------------------------------------------------------------------

describe('友達一覧画面', () => {
  it('shows first load, then the list with 最終更新 and a friend Streak', async () => {
    const pending = deferred<QueryPage<ProfileDetail>>();
    mockListFriends.mockImplementationOnce(() => pending.promise);
    const { app } = await renderApp('/friends');
    await waitFor(() => expect(app.getPathname()).toBe('/friends'));

    // 初回読込 is its own state, not "empty".
    expect(screen.getByTestId('friends-loading')).toBeTruthy();
    expect(screen.queryByTestId('friends-zero')).toBeNull();

    await act(async () => {
      pending.resolve(
        page([detail('aoi_07', 7, { displayName: 'あおい', relationship: 'friend', streak: 12 })]),
      );
    });
    await screen.findByTestId('friend-row-aoi_07');
    expect(screen.getByTestId('friend-streak-aoi_07').props.children).toBe('12 日');
    expect(screen.getByTestId('friends-last-updated').props.children).toMatch(
      /^最終更新 \d{2}:\d{2}$/,
    );
    expect(screen.queryByTestId('friends-loading')).toBeNull();
  });

  it('serves the cached list (最終更新付き) while the network read is still pending', async () => {
    // First session: fetch succeeds and writes the account cache.
    mockListFriends.mockResolvedValueOnce(
      page([detail('aoi_07', 7, { displayName: 'あおい', relationship: 'friend', streak: 12 })]),
    );
    const first = await renderApp('/friends');
    await screen.findByTestId('friend-row-aoi_07');
    await first.app.unmount();

    // Second session: the network hangs — the cache still shows the list.
    mockListFriends.mockImplementationOnce(() => new Promise<QueryPage<ProfileDetail>>(() => {}));
    const second = await renderApp('/friends');
    await screen.findByTestId('friend-row-aoi_07');
    expect(screen.getByTestId('friends-last-updated').props.children).toMatch(
      /^最終更新 \d{2}:\d{2}$/,
    );
    expect(screen.queryByTestId('friends-loading')).toBeNull();
    expect(second.app.getPathname()).toBe('/friends');
  });

  it('distinguishes an empty list (zero-friend guidance + あとで) from failures', async () => {
    const { app } = await renderApp('/friends');
    await waitFor(() => expect(app.getPathname()).toBe('/friends'));

    await screen.findByTestId('friends-zero');
    // 友達0人の案内 comes from the existing zero-friends module.
    expect(screen.getByText(zeroFriendGuidance().message)).toBeTruthy();
    expect(screen.getByTestId('friends-add-entry')).toBeTruthy();
    expect(screen.queryByTestId('friends-error')).toBeNull();

    // あとで hides the guidance; the add entries remain.
    await fireEvent.press(screen.getByTestId('friends-zero-later'));
    expect(screen.queryByTestId('friends-zero')).toBeNull();
    expect(screen.getByTestId('friends-add-entry')).toBeTruthy();
  });

  it('shows a network failure with 再試行 and recovers', async () => {
    mockListFriends.mockRejectedValueOnce(new Error('boom'));
    const { app } = await renderApp('/friends');
    await waitFor(() => expect(app.getPathname()).toBe('/friends'));

    await screen.findByTestId('friends-error');
    expect(screen.queryByTestId('friends-zero')).toBeNull(); // failure ≠ empty

    mockListFriends.mockResolvedValueOnce(
      page([detail('aoi_07', 7, { displayName: 'あおい', relationship: 'friend', streak: 12 })]),
    );
    await fireEvent.press(screen.getByTestId('friends-retry'));
    await screen.findByTestId('friend-row-aoi_07');
    expect(screen.queryByTestId('friends-error')).toBeNull();
  });

  it('reports offline without a wire attempt', async () => {
    setNavigatorOnline(false);
    const { app } = await renderApp('/friends');
    await waitFor(() => expect(app.getPathname()).toBe('/friends'));

    await screen.findByTestId('friends-offline');
    expect(mockListFriends).not.toHaveBeenCalled();
    expect(screen.queryByTestId('friends-zero')).toBeNull(); // offline ≠ empty
    expect(screen.queryByTestId('friends-error')).toBeNull();
  });

  it('refreshes when a friendship is established (友達成立で更新)', async () => {
    mockListFriends
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(
        page([detail('sakura_24', 24, { displayName: 'さくら', relationship: 'friend', streak: 1 })]),
      );
    const { app } = await renderApp('/friends');
    await waitFor(() => expect(app.getPathname()).toBe('/friends'));
    await screen.findByTestId('friends-zero');
    expect(mockListFriends).toHaveBeenCalledTimes(1);

    await act(async () => {
      notifyFriendsChanged();
    });
    await screen.findByTestId('friend-row-sakura_24');
    expect(mockListFriends).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('friends-zero')).toBeNull();
  });
});
