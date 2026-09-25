import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Session } from '@supabase/supabase-js';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import {
  OAUTH_PROVIDERS,
  assertSupportedProvider,
  parseAuthCallback,
  startLogin,
} from '../src/auth/oauth';
import { savePendingInvitation } from '../src/storage/invitations';
import { readDraft, saveDraft } from '../src/storage/drafts';
import { REGISTRATION_DRAFT_KEY } from '../src/app/register';
import {
  clearRememberedDestination,
  isRestorableDestination,
  peekDestination,
  rememberDestination,
  resolveEntry,
} from '../src/navigation/entry';

// Task 10: OAuth login + registration flow + entry branching, through the
// REAL route tree (router, screens, auth provider, oauth module, draft SQL).
// What is mocked is the outside world only: the Supabase client, the system
// browser, the redirect URI, and the device database driver (Node SQLite
// behind the production SQL, same as storage.integration.test.ts).
//
// These are MOCKED-LAYER tests: no real OAuth round trip happens here. Real
// device/provider verification status is recorded in
// docs/testing/app-foundation-friends-ui.md — mock success is never claimed
// as a real login.

// ---------------------------------------------------------------------------
// Module mocks (hoisted by jest; factories only read mock* bindings lazily)
// ---------------------------------------------------------------------------

let mockSession: { user: { id: string; email?: string } } | null = null;
let mockProfileRow: {
  user_id_confirmed_at: string | null;
  onboarding_seen_at: string | null;
} | null = null;
let mockStorage: import('../src/storage/database').AppStorage | null = null;
let mockAppClient: unknown;

const mockSignInWithOAuth = jest.fn();
const mockExchangeCodeForSession = jest.fn();
const mockInvoke = jest.fn();
const mockOpenAuthSession = jest.fn();

jest.mock('../src/backend/client', () => ({
  getAppClient: () => {
    if (mockAppClient instanceof Error) throw mockAppClient;
    if (!mockAppClient) throw new Error('registration-flow test: client not installed');
    return mockAppClient;
  },
}));

jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: (url: string, redirect: string) =>
    mockOpenAuthSession(url, redirect),
  maybeCompleteAuthSession: jest.fn(),
}));

jest.mock('expo-auth-session', () => ({
  makeRedirectUri: () => 'app://auth/callback',
}));

jest.mock('../src/storage/database', () => {
  const actual = jest.requireActual('../src/storage/database');
  return {
    ...actual,
    openAppDatabase: async () => {
      if (!mockStorage) throw new Error('registration-flow test: storage not installed');
      return mockStorage;
    },
  };
});

const actualDatabase = jest.requireActual('../src/storage/database') as typeof import('../src/storage/database');
const actualBackendClient = jest.requireActual('../src/backend/client') as typeof import('../src/backend/client');
const { NodeSqliteDriver } = jest.requireActual('../src/storage/testSupport/nodePorts') as typeof import('../src/storage/testSupport/nodePorts');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fakeSession(id: string, email?: string): Session {
  return { user: { id, email } } as unknown as Session;
}

function installClient(): void {
  mockAppClient = {
    auth: {
      getSession: async () => ({ data: { session: mockSession }, error: null }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
      signInWithOAuth: (args: unknown) => mockSignInWithOAuth(args),
      exchangeCodeForSession: (code: string) => mockExchangeCodeForSession(code),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: mockProfileRow, error: null }),
        }),
      }),
    }),
    functions: {
      invoke: (name: string, options: { body: unknown }) => mockInvoke(name, options),
    },
  };
}

let tmpDir: string;

async function installStorage(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registration-flow-'));
  const driver = new NodeSqliteDriver(path.join(tmpDir, 'app.db'));
  mockStorage = await actualDatabase.openAppDatabase({ driver });
}

async function renderApp(initialUrl: string) {
  const router = renderRouter('./src/app', { initialUrl });
  const result = await router;
  // renderRouter attaches router helpers to the render promise itself, while
  // unmount lives on the awaited RNTL result — bridge both here.
  return {
    app: {
      getPathname: () => router.getPathname(),
      unmount: async () => {
        await result.unmount();
      },
    },
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockSession = null;
  mockProfileRow = null;
  mockAppClient = undefined;
  clearRememberedDestination();
  await installStorage();
  installClient();

  mockSignInWithOAuth.mockResolvedValue({
    data: { provider: 'apple', url: 'https://example.com/authorize?provider=apple&code_challenge=x' },
    error: null,
  });
  mockOpenAuthSession.mockResolvedValue({ type: 'cancel' });
  mockInvoke.mockResolvedValue({ data: { result: {} }, error: null });
  mockExchangeCodeForSession.mockImplementation(async () => {
    const session = fakeSession('account-1', 'a@example.com');
    mockSession = session;
    return { data: { session }, error: null };
  });
});

afterEach(async () => {
  await mockStorage?.close();
  mockStorage = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Supabase configuration: env-driven, fail-clear, no hardcoded secrets
// ---------------------------------------------------------------------------

describe('Supabase configuration', () => {
  it('fails clearly when env vars are missing, naming both', () => {
    expect(() => actualBackendClient.readSupabaseConfig({})).toThrow(
      /EXPO_PUBLIC_SUPABASE_URL.*EXPO_PUBLIC_SUPABASE_ANON_KEY|EXPO_PUBLIC_SUPABASE_ANON_KEY.*EXPO_PUBLIC_SUPABASE_URL/,
    );
  });

  it('reads trimmed values from env', () => {
    const config = actualBackendClient.readSupabaseConfig({
      EXPO_PUBLIC_SUPABASE_URL: ' http://127.0.0.1:54321 ',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: ' sbp_test ',
    });
    expect(config).toEqual({ url: 'http://127.0.0.1:54321', anonKey: 'sbp_test' });
  });

  it('builds the client with PKCE and no browser URL sniffing', () => {
    const client = actualBackendClient.createAppClient({
      env: {
        EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        EXPO_PUBLIC_SUPABASE_ANON_KEY: 'test-anon',
      },
      authStorage: {
        getItem: async () => null,
        setItem: async () => {},
        removeItem: async () => {},
      },
    });
    const auth = client.auth as unknown as { flowType: string; detectSessionInUrl: boolean };
    expect(auth.flowType).toBe('pkce');
    expect(auth.detectSessionInUrl).toBe(false);
  });

  it('keeps the in-repo Supabase config honest: email signup off, secrets from env, callback allow-listed', () => {
    const config = fs.readFileSync(
      path.join(__dirname, '..', '..', 'supabase', 'config.toml'),
      'utf8',
    );
    const emailSection = config.split('[auth.email]')[1]?.split('\n[')[0] ?? '';
    expect(emailSection).toMatch(/enable_signup = false/);
    const appleSection = config.split('[auth.external.apple]')[1]?.split('\n[')[0] ?? '';
    // The Apple secret must be an env() substitution, never a literal value.
    expect(appleSection).toContain('env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)');
    // The app's PKCE callback must be allow-listed.
    expect(config).toContain('"app://auth/callback"');

    const envExample = fs.readFileSync(
      path.join(__dirname, '..', '..', 'app', '.env.example'),
      'utf8',
    );
    expect(envExample).toContain('EXPO_PUBLIC_SUPABASE_URL');
    expect(envExample).toContain('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  });
});

// ---------------------------------------------------------------------------
// OAuth parsing and provider allowlist (URL ≠ token ≠ invitation)
// ---------------------------------------------------------------------------

describe('OAuth callback parsing', () => {
  it('extracts an authorization code', () => {
    expect(parseAuthCallback('app://auth/callback?code=abc123&state=x')).toEqual({
      kind: 'code',
      code: 'abc123',
    });
  });

  it('extracts provider errors', () => {
    expect(parseAuthCallback('app://auth/callback?error=access_denied&error_description=nope')).toEqual({
      kind: 'error',
      error: 'access_denied',
      description: 'nope',
    });
  });

  it('never treats an invitation link as an OAuth callback', () => {
    expect(parseAuthCallback('app://invitation/tok-123')).toEqual({ kind: 'none' });
    expect(parseAuthCallback('app://auth/callback?invitation_token=tok-123')).toEqual({
      kind: 'none',
    });
    // A token in the URL is never a code either (PKCE: no tokens in URLs).
    expect(parseAuthCallback('app://auth/callback?access_token=secret')).toEqual({
      kind: 'none',
    });
  });

  it('offers only Apple and Google', () => {
    expect([...OAUTH_PROVIDERS]).toEqual(['apple', 'google']);
    expect(() => assertSupportedProvider('github')).toThrow(/Unsupported sign-in provider/);
    expect(() => assertSupportedProvider('email')).toThrow(/Unsupported sign-in provider/);
  });
});

describe('startLogin (browser round trip)', () => {
  const deps = () => ({
    client: mockAppClient as never,
    redirectUri: 'app://auth/callback',
  });

  it('sends the PKCE authorize request to the app callback URL', async () => {
    mockOpenAuthSession.mockResolvedValue({ type: 'cancel' });
    const result = await startLogin('apple', deps());
    expect(result).toEqual({ status: 'cancelled' });
    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: 'apple',
      options: { redirectTo: 'app://auth/callback', skipBrowserRedirect: true },
    });
  });

  it('exchanges a callback code for a session', async () => {
    mockOpenAuthSession.mockResolvedValue({
      type: 'success',
      url: 'app://auth/callback?code=the-code',
    });
    const result = await startLogin('google', deps());
    expect(result.status).toBe('authenticated');
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith('the-code');
  });

  it('treats access_denied as cancel, not as success', async () => {
    mockOpenAuthSession.mockResolvedValue({
      type: 'success',
      url: 'app://auth/callback?error=access_denied',
    });
    const result = await startLogin('apple', deps());
    expect(result).toEqual({ status: 'cancelled' });
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('classifies a lost callback as a retryable failure without a session', async () => {
    mockOpenAuthSession.mockResolvedValue({
      type: 'success',
      url: 'app://auth/callback',
    });
    const result = await startLogin('apple', deps());
    expect(result).toMatchObject({ status: 'failed', retryable: true });
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('classifies a network failure as retryable', async () => {
    mockSignInWithOAuth.mockRejectedValue(new TypeError('Network request failed'));
    const result = await startLogin('apple', deps());
    expect(result).toMatchObject({ status: 'failed', retryable: true });
  });
});

// ---------------------------------------------------------------------------
// navigation/entry: cold start → home, warm resume → detail, guards
// ---------------------------------------------------------------------------

describe('navigation/entry', () => {
  beforeEach(() => clearRememberedDestination());

  it('routes a signed-out cold start to login', () => {
    expect(
      resolveEntry({ phase: 'cold', auth: 'signedOut', registration: 'loading', destination: null }),
    ).toEqual({ kind: 'route', path: '/login', reason: expect.any(String) });
  });

  it('routes a signed-in unregistered user to register (未登録ガード)', () => {
    expect(
      resolveEntry({ phase: 'warm', auth: 'signedIn', registration: 'unregistered', destination: '/friends/add' }),
    ).toEqual({ kind: 'route', path: '/register', reason: 'registration not confirmed' });
  });

  it('routes a registered cold start to home', () => {
    expect(
      resolveEntry({ phase: 'cold', auth: 'signedIn', registration: 'registered', destination: null }),
    ).toMatchObject({ kind: 'route', path: '/home' });
  });

  it('resumes the last destination on warm resume', () => {
    expect(
      resolveEntry({ phase: 'warm', auth: 'signedIn', registration: 'registered', destination: '/friends/u-1' }),
    ).toEqual({ kind: 'resume', path: '/friends/u-1', reason: 'warm resume' });
  });

  it('falls back to home when warm resume has no destination', () => {
    expect(
      resolveEntry({ phase: 'warm', auth: 'signedIn', registration: 'registered', destination: null }),
    ).toMatchObject({ kind: 'route', path: '/home' });
  });

  it('waits while auth state is loading', () => {
    expect(
      resolveEntry({ phase: 'cold', auth: 'loading', registration: 'loading', destination: null }),
    ).toEqual({ kind: 'wait' });
  });

  it('only remembers restorable in-app destinations', () => {
    clearRememberedDestination();
    rememberDestination('/friends/u-1');
    expect(peekDestination()).toBe('/friends/u-1');
    rememberDestination('/login');
    rememberDestination('/auth/callback?code=x');
    rememberDestination('/invitation/tok');
    rememberDestination('https://evil.example');
    expect(peekDestination()).toBe('/friends/u-1');
    expect(isRestorableDestination('/home')).toBe(true);
    expect(isRestorableDestination('/mypage')).toBe(true);
    expect(isRestorableDestination('/other')).toBe(false);
    clearRememberedDestination();
    expect(peekDestination()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Login flow through the real router
// ---------------------------------------------------------------------------

describe('login flow', () => {
  it('offers only Apple and Google on a signed-out cold start', async () => {
    const { app } = await renderApp('/');
    await waitFor(() => expect(app.getPathname()).toBe('/login'));
    expect(screen.getByTestId('login-apple')).toBeTruthy();
    expect(screen.getByTestId('login-google')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/メール|password/i)).toBeNull();
  });

  it('sends deep links to /home to login when signed out', async () => {
    const { app } = await renderApp('/friends');
    await waitFor(() => expect(app.getPathname()).toBe('/login'));
  });

  it('offers retry after a cancelled browser session and retries the same provider', async () => {
    mockSession = null;
    mockProfileRow = null;
    const { app } = await renderApp('/');
    await waitFor(() => expect(app.getPathname()).toBe('/login'));

    mockOpenAuthSession.mockResolvedValue({ type: 'cancel' });
    await fireEvent.press(screen.getByTestId('login-apple'));
    await waitFor(() => expect(screen.getByTestId('login-notice')).toBeTruthy());
    expect(screen.getByText(/ログインをキャンセルしました/)).toBeTruthy();
    expect(screen.getByTestId('login-retry')).toBeTruthy();

    // Retry re-attempts the SAME provider — the user's choice is preserved.
    mockOpenAuthSession.mockResolvedValue({
      type: 'success',
      url: 'app://auth/callback?code=abc',
    });
    mockProfileRow = null; // still unregistered
    await fireEvent.press(screen.getByTestId('login-retry'));
    await waitFor(() => expect(app.getPathname()).toBe('/register'));
    expect(mockSignInWithOAuth).toHaveBeenCalledTimes(2);
    expect(mockSignInWithOAuth.mock.calls[0][0]).toMatchObject({ provider: 'apple' });
    expect(mockSignInWithOAuth.mock.calls[1][0]).toMatchObject({ provider: 'apple' });
  });

  it('offers retry after a network failure and succeeds on retry', async () => {
    mockSignInWithOAuth.mockRejectedValueOnce(new TypeError('Network request failed'));
    const { app } = await renderApp('/');
    await waitFor(() => expect(app.getPathname()).toBe('/login'));

    await fireEvent.press(screen.getByTestId('login-google'));
    await waitFor(() => expect(screen.getByTestId('login-notice')).toBeTruthy());
    expect(screen.getByText(/通信に失敗しました/)).toBeTruthy();

    // On retry the network is healthy again and the provider round trip completes.
    mockProfileRow = { user_id_confirmed_at: null, onboarding_seen_at: null };
    mockOpenAuthSession.mockResolvedValue({
      type: 'success',
      url: 'app://auth/callback?code=abc',
    });
    await fireEvent.press(screen.getByTestId('login-retry'));
    await waitFor(() => expect(app.getPathname()).toBe('/register'));
  });

  it('sends a registered user to home after login', async () => {
    mockProfileRow = {
      user_id_confirmed_at: '2026-09-26T00:00:00Z',
      onboarding_seen_at: null,
    };
    mockOpenAuthSession.mockResolvedValue({
      type: 'success',
      url: 'app://auth/callback?code=abc',
    });
    const { app } = await renderApp('/');
    await waitFor(() => expect(app.getPathname()).toBe('/login'));
    await fireEvent.press(screen.getByTestId('login-apple'));
    await waitFor(() => expect(app.getPathname()).toBe('/home'));
    expect(screen.getByTestId('tab-home')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 未登録ガード: unregistered signed-in users cannot enter the tab shell
// ---------------------------------------------------------------------------

describe('unregistered guard', () => {
  it('redirects an unregistered signed-in user from /friends to /register', async () => {
    mockSession = fakeSession('account-1', 'a@example.com');
    mockProfileRow = { user_id_confirmed_at: null, onboarding_seen_at: null };
    const { app } = await renderApp('/friends');
    await waitFor(() => expect(app.getPathname()).toBe('/register'));
  });

  it('redirects a signed-out user from /register to /login', async () => {
    const { app } = await renderApp('/register');
    await waitFor(() => expect(app.getPathname()).toBe('/login'));
  });
});

// ---------------------------------------------------------------------------
// Registration flow through the real router
// ---------------------------------------------------------------------------

async function fillRegistrationAndReview(userId: string, displayName: string): Promise<void> {
  await fireEvent.changeText(screen.getByTestId('register-user-id'), userId);
  await fireEvent.changeText(screen.getByTestId('register-display-name'), displayName);
  // Wait for the controlled inputs to reflect the typed state before review.
  await waitFor(() => expect(screen.getByTestId('register-user-id').props.value).toBe(userId));
  await fireEvent.press(screen.getByTestId('register-review'));
  await waitFor(() => expect(screen.getByTestId('register-submit')).toBeTruthy());
}

describe('registration flow', () => {
  beforeEach(() => {
    mockSession = fakeSession('account-1', 'a@example.com');
    mockProfileRow = { user_id_confirmed_at: null, onboarding_seen_at: null };
  });

  it('confirms input on a review step, registers, clears the draft and goes home', async () => {
    const { app } = await renderApp('/register');
    await waitFor(() => expect(screen.getByTestId('register-user-id')).toBeTruthy());

    await fillRegistrationAndReview('hanako', '花子');
    expect(screen.getByText(/User ID: hanako/)).toBeTruthy();
    expect(screen.getByText(/確定後に変更できません/)).toBeTruthy();

    mockInvoke.mockImplementation(async (_name: string, options: { body: any }) => {
      expect(options.body.kind).toBe('register');
      expect(options.body.payload).toEqual({
        user_id_text: 'hanako',
        display_name: '花子',
      });
      return { data: { result: { user_id_text: 'hanako' } }, error: null };
    });

    await fireEvent.press(screen.getByTestId('register-submit'));
    await waitFor(() => expect(app.getPathname()).toBe('/home'));
    // Draft is deleted inside submit() before the redirect, so it is already
    // gone once the app reached /home.
    expect(
      await readDraft(mockStorage!, 'account-1', REGISTRATION_DRAFT_KEY),
    ).toBeNull();
  });

  it('keeps the input and offers editable similar-ID candidates on a server conflict', async () => {
    const { app } = await renderApp('/register');
    await waitFor(() => expect(screen.getByTestId('register-user-id')).toBeTruthy());
    await fillRegistrationAndReview('hanako', '花子');

    mockInvoke.mockResolvedValue({
      data: null,
      error: {
        message: 'User ID is already taken.',
        context: {
          status: 409,
          json: async () => ({ error: 'User ID is already taken.' }),
        },
      },
    });

    await fireEvent.press(screen.getByTestId('register-submit'));
    await waitFor(() => expect(screen.getByTestId('register-error')).toBeTruthy());
    // Conflict returns to the input step with everything preserved.
    expect(app.getPathname()).toBe('/register');
    expect(screen.getByTestId('register-user-id').props.value).toBe('hanako');
    expect(screen.getByTestId('register-display-name').props.value).toBe('花子');
    expect(screen.getByText(/User ID is already taken/)).toBeTruthy();
    const candidates = screen.getByTestId('register-candidates');
    expect(candidates).toBeTruthy();
    expect(screen.getByTestId('register-candidate-hanako2')).toBeTruthy();

    // A candidate is an editable suggestion, not a reservation: tapping it
    // only fills the still-editable field.
    await fireEvent.press(screen.getByTestId('register-candidate-hanako2'));
    expect(screen.getByTestId('register-user-id').props.value).toBe('hanako2');

    // Resubmitting with the changed payload starts a NEW operation id.
    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue({ data: { result: {} }, error: null });
    await fillRegistrationAndReview('hanako2', '花子');
    await fireEvent.press(screen.getByTestId('register-submit'));
    await waitFor(() => expect(app.getPathname()).toBe('/home'));
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('offers retry after a network failure and reuses the same operation id', async () => {
    const { app } = await renderApp('/register');
    await waitFor(() => expect(screen.getByTestId('register-user-id')).toBeTruthy());
    await fillRegistrationAndReview('taro', '太郎');

    mockInvoke.mockResolvedValueOnce({
      data: null,
      error: new TypeError('Network request failed'),
    });
    await fireEvent.press(screen.getByTestId('register-submit'));
    await waitFor(() => expect(screen.getByTestId('register-retry')).toBeTruthy());
    expect(screen.getByText(/通信に失敗|Network request failed/)).toBeTruthy();
    // Input preserved on the review step.
    expect(screen.getByText(/User ID: taro/)).toBeTruthy();

    mockInvoke.mockResolvedValue({ data: { result: {} }, error: null });
    await fireEvent.press(screen.getByTestId('register-retry'));
    await waitFor(() => expect(app.getPathname()).toBe('/home'));

    const operations = mockInvoke.mock.calls.map(([, options]) => (options as any).body.operation_id);
    expect(operations).toHaveLength(2);
    expect(operations[1]).toBe(operations[0]);
  });

  it('saves the typed registration input as an account-scoped draft', async () => {
    const { app } = await renderApp('/register');
    await waitFor(() => expect(screen.getByTestId('register-user-id')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('register-user-id'), 'alice');
    await fireEvent.changeText(screen.getByTestId('register-display-name'), 'Alice');
    // persistDraft is fire-and-forget; poll the real SQL until it lands.
    let draft: { body: { userIdText?: string; displayName?: string } } | null = null;
    for (let i = 0; i < 50 && !draft?.body?.userIdText; i += 1) {
      draft = await readDraft<{ userIdText?: string; displayName?: string }>(
        mockStorage!,
        'account-1',
        REGISTRATION_DRAFT_KEY,
      );
      if (!draft?.body?.userIdText) await new Promise((r) => setImmediate(r));
    }
    expect(draft?.body?.userIdText).toBe('alice');
    expect(draft?.body?.displayName).toBe('Alice');
    expect(app.getPathname()).toBe('/register');
  });

  it("never restores another account's draft", async () => {
    // account-1 has a stored draft; the screen opens as account-2.
    await saveDraft(mockStorage!, 'account-1', REGISTRATION_DRAFT_KEY, {
      userIdText: 'alice',
      displayName: 'Alice',
    });
    mockSession = fakeSession('account-2', 'b@example.com');
    const { app } = await renderApp('/register');
    await waitFor(() => expect(screen.getByTestId('register-user-id')).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByTestId('register-user-id').props.value).toBe(''),
    );
    expect(screen.getByTestId('register-display-name').props.value).toBe('');
    expect(app.getPathname()).toBe('/register');
  });

  it("restores the account's own draft on a fresh launch", async () => {
    // A relaunch = a fresh render against the same device DB, same account.
    await saveDraft(mockStorage!, 'account-1', REGISTRATION_DRAFT_KEY, {
      userIdText: 'alice',
      displayName: 'Alice',
    });
    const { app } = await renderApp('/register');
    await waitFor(() => expect(screen.getByTestId('register-user-id')).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByTestId('register-user-id').props.value).toBe('alice'),
    );
    expect(screen.getByTestId('register-display-name').props.value).toBe('Alice');
    expect(app.getPathname()).toBe('/register');
  });

  it('sends only the register command for an account without invitation', async () => {
    const { app } = await renderApp('/register');
    await waitFor(() => expect(screen.getByTestId('register-user-id')).toBeTruthy());
    await fillRegistrationAndReview('ken', '健');
    await fireEvent.press(screen.getByTestId('register-submit'));
    await waitFor(() => expect(app.getPathname()).toBe('/home'));
    const kinds = mockInvoke.mock.calls.map(([, options]) => (options as any).body.kind);
    expect(kinds).toEqual(['register']);
  });

  it('marks the guide seen on the server when an invited account reaches confirmation', async () => {
    // 招待: a pending invitation for this account is stored on the device.
    await savePendingInvitation(mockStorage!, {
      accountId: 'account-1',
      invitationKey: 'inv-1',
      payload: { token: 'tok-1' },
    });
    const { app } = await renderApp('/register');
    await waitFor(() => expect(screen.getByTestId('register-user-id')).toBeTruthy());
    await fillRegistrationAndReview('yuki', '雪');
    await fireEvent.press(screen.getByTestId('register-submit'));
    await waitFor(() => expect(app.getPathname()).toBe('/home'));
    const kinds = mockInvoke.mock.calls.map(([, options]) => (options as any).body.kind);
    expect(kinds).toEqual(['register', 'mark_onboarding_seen']);
  });

});

// ---------------------------------------------------------------------------
// auth/callback deep link: code exchanged, invitation URLs rejected
// ---------------------------------------------------------------------------

describe('auth callback route', () => {
  it('exchanges a callback code and routes by registration state', async () => {
    mockProfileRow = {
      user_id_confirmed_at: '2026-09-26T00:00:00Z',
      onboarding_seen_at: null,
    };
    const { app } = await renderApp('/auth/callback?code=deep-code');
    await waitFor(() => expect(app.getPathname()).toBe('/home'));
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith('deep-code');
  });

  it('rejects a URL without an OAuth code instead of inventing a session', async () => {
    const { app } = await renderApp('/auth/callback?invitation_token=tok-1');
    await waitFor(() => expect(screen.getByTestId('callback-failed')).toBeTruthy());
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockSession).toBeNull();
    expect(app.getPathname()).toBe('/auth/callback');
  });
});

// ---------------------------------------------------------------------------
// Cold start entry + warm resume through the real router
// ---------------------------------------------------------------------------

describe('entry through the router', () => {
  it('cold start with a registered session lands on home', async () => {
    mockSession = fakeSession('account-1', 'a@example.com');
    mockProfileRow = {
      user_id_confirmed_at: '2026-09-26T00:00:00Z',
      onboarding_seen_at: null,
    };
    const { app } = await renderApp('/');
    await waitFor(() => expect(app.getPathname()).toBe('/home'));
  });

  it('warm resume reopens the remembered detail destination', async () => {
    mockSession = fakeSession('account-1', 'a@example.com');
    mockProfileRow = {
      user_id_confirmed_at: '2026-09-26T00:00:00Z',
      onboarding_seen_at: null,
    };

    // First session reaches a detail screen; the recorder remembers it.
    const first = await renderApp('/friends/add');
    expect(first.app.getPathname()).toBe('/friends/add');
    expect(peekDestination()).toBe('/friends/add');
    await first.app.unmount();

    // Warm resume: the process (module state) survived — '/' reopens the
    // detail instead of the generic home.
    const second = await renderApp('/');
    await waitFor(() => expect(second.app.getPathname()).toBe('/friends/add'));
  });
});

// ---------------------------------------------------------------------------
// Missing configuration fails clearly (no placeholder values)
// ---------------------------------------------------------------------------

describe('missing Supabase configuration', () => {
  it('shows a clear error instead of a fake home', async () => {
    mockAppClient = new Error(
      'Supabase is not configured: missing EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.',
    );
    const { app } = await renderApp('/');
    await waitFor(() => expect(screen.getByTestId('entry-error')).toBeTruthy());
    expect(screen.getByText(/EXPO_PUBLIC_SUPABASE_URL/)).toBeTruthy();
    expect(app.getPathname()).toBe('/');
  });
});
