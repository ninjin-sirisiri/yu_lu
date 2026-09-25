import {
  fireEvent,
  renderRouter,
  screen,
  waitFor,
} from 'expo-router/testing-library';

// Task 10 put the tab shell behind the auth+registration guard, so this
// navigation-focused test injects a signed-in, registered auth context and
// keeps asserting the shell itself. Auth branching is covered by
// __tests__/registration-flow.test.tsx.
jest.mock('../src/auth/provider', () => {
  const React = require('react');
  const value = {
    status: 'ready',
    error: null,
    accountId: 'account-shell',
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
    classifyCompletedLogin: () => ({ kind: 'returning', accountId: 'account-shell' }),
  };
});

// Renders the real route tree under app/src/app so the tab shell, the home
// entry point and every tab destination are verified through actual router
// startup instead of hand-built fixtures. Jest runs with cwd = app/
// (npm --prefix app test), which is what renderRouter resolves from.
async function renderApp(initialUrl: string) {
  // The router helpers (getPathname, ...) are attached to the render promise
  // itself, so keep a reference to it and wrap it in a plain object — awaiting
  // the promise directly would unwrap and drop the helpers.
  const app = renderRouter('./src/app', { initialUrl });
  await app;
  return { app };
}

describe('navigation shell', () => {
  it('boots through the router and lands on the home tab', async () => {
    const { app } = await renderApp('/');
    await waitFor(() => expect(app.getPathname()).toBe('/home'));
    expect(screen.getAllByText('準備中').length).toBeGreaterThan(0);
  });

  it('shows exactly the four Japanese bottom tabs', async () => {
    const { app } = await renderApp('/home');
    await waitFor(() => expect(app.getPathname()).toBe('/home'));

    const tabIds = ['tab-home', 'tab-chat', 'tab-friends', 'tab-mypage'];
    for (const id of tabIds) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    for (const label of ['ホーム', 'チャット', '友達', 'マイページ']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // The add-friends destination lives inside the friends area and must not
    // appear as a fifth tab.
    expect(screen.queryByTestId('tab-add')).toBeNull();
    expect(screen.queryByTestId('tab-friends-add')).toBeNull();
  });

  it('reaches the add-friends destination from home without showing success', async () => {
    const { app } = await renderApp('/home');
    await waitFor(() => expect(app.getPathname()).toBe('/home'));

    await fireEvent.press(screen.getByText('友達を追加'));

    await waitFor(() => expect(app.getPathname()).toBe('/friends/add'));
    expect(screen.getByText('友達追加')).toBeTruthy();
    expect(screen.getByText('友達追加は準備中です')).toBeTruthy();
    // The bottom tab bar stays visible while inside the friends area, so the
    // entry lands in the friends tab area rather than a separate flow.
    expect(screen.getByTestId('tab-friends')).toBeTruthy();
    // An unimplemented operation must never be presented as completed.
    expect(screen.queryByText(/追加しました|登録しました|完了/)).toBeNull();
  });

  it('reaches the chat, friends and mypage destinations from the tab bar', async () => {
    const { app } = await renderApp('/home');
    await waitFor(() => expect(app.getPathname()).toBe('/home'));

    await fireEvent.press(screen.getByTestId('tab-chat'));
    await waitFor(() => expect(app.getPathname()).toBe('/chat'));
    expect(screen.getAllByText('準備中').length).toBeGreaterThan(0);
    expect(
      screen.queryByText(/送信しました|削除しました|ブロックしました/),
    ).toBeNull();

    await fireEvent.press(screen.getByTestId('tab-friends'));
    await waitFor(() => expect(app.getPathname()).toBe('/friends'));
    expect(screen.getByText('友達一覧は準備中です')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('tab-mypage'));
    await waitFor(() => expect(app.getPathname()).toBe('/mypage'));
    expect(screen.getByText('マイページは準備中です')).toBeTruthy();
    expect(screen.queryByText(/変更しました|保存しました/)).toBeNull();
  });
});
