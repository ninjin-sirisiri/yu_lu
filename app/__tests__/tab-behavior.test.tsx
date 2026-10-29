import {
  fireEvent,
  renderRouter,
  screen,
  waitFor,
} from 'expo-router/testing-library';
import { ScrollView } from 'react-native';

// Task 22 (spec line 32): 別タブから戻ると詳細画面を保持する / 選択中タブの
// 再選択はその先頭へ戻り、すでに一覧なら先頭へスクロールする.
//
// Like navigation-shell, this test injects a signed-in registered auth
// context and mocks only the read boundary (backend/queries + own profile)
// so the real tab shell, the real stack and the real tabPress listener run
// through actual router startup. No test reaches the network.
jest.mock('../src/auth/provider', () => {
  const React = require('react');
  const value = {
    status: 'ready',
    error: null,
    accountId: 'account-tabreselect',
    registration: 'registered',
    onboardingSeen: false,
    storage: null,
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
    classifyCompletedLogin: () => ({ kind: 'returning', accountId: 'account-tabreselect' }),
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

// マイページ is visited in the tab-switch test; the published profile read
// stays deterministic (same mock as navigation-shell).
jest.mock('../src/backend/profile', () => {
  const actual = jest.requireActual('../src/backend/profile');
  return {
    ...actual,
    getOwnPublication: jest.fn(async () => ({
      userIdText: 'tab_user',
      displayName: '自分',
      introduction: null,
      avatarPath: null,
      profileVersion: 1,
    })),
    profileImageUrl: jest.fn(async () => null),
  };
});

import {
  getProfile,
  listFriends,
  listRequests,
  type ProfileDetail,
  type QueryPage,
} from '../src/backend/queries';
import { resetTabReselectListeners, subscribeTabReselect } from '../src/navigation/tabReselect';

const mockGetProfile = jest.mocked(getProfile);
const mockListFriends = jest.mocked(listFriends);
const mockListRequests = jest.mocked(listRequests);

// In jest the ScrollView is RN's component mock: `scrollTo` is a shared
// jest.fn on its prototype, so every scroll-to-top request the app makes is
// observable as a call with the exact target offset.
const scrollToMock = ScrollView.prototype.scrollTo as unknown as jest.Mock;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const PROFILE_UUID = uuid(1);
const FRIEND_ROW_TEXT = 'aoi_01';

const PROFILE: ProfileDetail = {
  userId: PROFILE_UUID,
  userIdText: 'target_1',
  displayName: '相手',
  avatarPath: null,
  introduction: null,
  relationship: 'none',
};

const FRIEND: ProfileDetail = {
  userId: uuid(2),
  userIdText: FRIEND_ROW_TEXT,
  displayName: 'あおい',
  avatarPath: null,
  introduction: null,
  relationship: 'friend',
  streak: 3,
};

const emptyPage = <T,>(): QueryPage<T> => ({ items: [], nextCursor: null });

beforeEach(() => {
  mockGetProfile.mockResolvedValue(PROFILE);
  mockListFriends.mockResolvedValue(emptyPage());
  mockListRequests.mockResolvedValue(emptyPage());
  scrollToMock.mockClear();
  resetTabReselectListeners();
});

// Renders the real route tree under app/src/app (cwd = app/), same as
// navigation-shell: the tab shell and its tabPress listener are verified
// through actual router startup.
async function renderApp(initialUrl: string) {
  const app = await renderRouter('./src/app', { initialUrl });
  return { app };
}

describe('focused tab re-selection (spec line 32)', () => {
  it('keeps new-chat selection inside the chat stack and pops it on chat tab reselect', async () => {
    const { app } = await renderApp('/chat');
    await fireEvent.press(screen.getByText('新しいチャット'));
    await waitFor(() => expect(app.getPathname()).toBe('/chat/new'));
    await fireEvent.press(screen.getByTestId('tab-friends'));
    await waitFor(() => expect(app.getPathname()).toBe('/friends'));
    await fireEvent.press(screen.getByTestId('tab-chat'));
    await waitFor(() => expect(app.getPathname()).toBe('/chat/new'));
    await fireEvent.press(screen.getByTestId('tab-chat'));
    await waitFor(() => expect(app.getPathname()).toBe('/chat'));
    expect(screen.getByText('新しいチャット')).toBeTruthy();
  });

  it('keeps the friend detail screen when returning from another tab', async () => {
    const { app } = await renderApp(`/friends/${PROFILE_UUID}`);
    await waitFor(() => expect(app.getPathname()).toBe(`/friends/${PROFILE_UUID}`));
    await waitFor(() => expect(screen.getByTestId('profile-name')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('tab-mypage'));
    await waitFor(() => expect(app.getPathname()).toBe('/mypage'));

    // Switching BACK must not reset the friends stack: the detail route is
    // still where it was (別タブから戻ると詳細画面を保持する).
    await fireEvent.press(screen.getByTestId('tab-friends'));
    await waitFor(() => expect(app.getPathname()).toBe(`/friends/${PROFILE_UUID}`));
    expect(screen.getByTestId('profile-name')).toBeTruthy();
  });

  it('pops the friends stack to its root when the focused tab is re-selected', async () => {
    const { app } = await renderApp('/friends');
    await waitFor(() => expect(app.getPathname()).toBe('/friends'));

    // Push a deeper screen first, so the tab stack really has a root to
    // return to (user-driven, same as 申請を確認 in the app).
    await fireEvent.press(screen.getByTestId('friends-requests-entry'));
    await waitFor(() => expect(app.getPathname()).toBe('/friends/requests'));
    await waitFor(() => expect(screen.getByTestId('requests-tab-incoming')).toBeTruthy());

    // The friends tab is ALREADY focused — re-selecting it returns to the
    // first screen of the tab (再選択はその先頭へ戻り).
    await fireEvent.press(screen.getByTestId('tab-friends'));

    await waitFor(() => expect(app.getPathname()).toBe('/friends'));
    expect(screen.getByTestId('friends-add-entry')).toBeTruthy();
    expect(screen.queryByTestId('requests-list')).toBeNull();
  });

  it('scrolls the friends list to the top when re-selected already at the root', async () => {
    mockListFriends.mockResolvedValue({
      items: [FRIEND],
      nextCursor: null,
    } satisfies QueryPage<ProfileDetail>);

    const signals: string[] = [];
    const unsubscribe = subscribeTabReselect('friends', () => signals.push('friends'));
    try {
      const { app } = await renderApp('/friends');
      await waitFor(() => expect(app.getPathname()).toBe('/friends'));
      await waitFor(() => expect(screen.getByTestId(`friend-row-${FRIEND_ROW_TEXT}`)).toBeTruthy());
      scrollToMock.mockClear();

      await fireEvent.press(screen.getByTestId('tab-friends'));

      // Already at the root: the route does not change, but the re-select
      // signal fires and the mounted list scrolls back to its top
      // (すでに一覧なら先頭へスクロールする).
      expect(app.getPathname()).toBe('/friends');
      expect(signals).toEqual(['friends']);
      expect(scrollToMock).toHaveBeenCalledWith({ y: 0, animated: true });
    } finally {
      unsubscribe();
    }
  });

  it('scrolls the requests list to the top while the requests screen is open', async () => {
    const { app } = await renderApp('/friends');
    await waitFor(() => expect(app.getPathname()).toBe('/friends'));
    await fireEvent.press(screen.getByTestId('friends-requests-entry'));
    await waitFor(() => expect(app.getPathname()).toBe('/friends/requests'));
    await waitFor(() => expect(screen.getByTestId('requests-tab-incoming')).toBeTruthy());
    scrollToMock.mockClear();

    await fireEvent.press(screen.getByTestId('tab-friends'));

    // The requests list is the mounted scrollable here (the friends list
    // renders no ScrollView while empty) — it answers the same signal
    // before the pop lands it back at the root.
    expect(scrollToMock).toHaveBeenCalledWith({ y: 0, animated: true });
    await waitFor(() => expect(app.getPathname()).toBe('/friends'));
  });
});
