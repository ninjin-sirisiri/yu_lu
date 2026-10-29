import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Session } from '@supabase/supabase-js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';

import type { OwnInvitationStatus, ProfileSummary } from '../src/backend/queries';
import {
  QueryError,
  getInvitationStatus,
  resolveInvitation,
} from '../src/backend/queries';
import { clearRememberedDestination } from '../src/navigation/entry';
import { AdaptiveLayoutProvider } from '../src/navigation/AdaptiveLayout';
import { AddArea } from '../src/app/(tabs)/friends/add';
import { AuthProvider } from '../src/auth/provider';
import {
  InviteOriginError,
  buildInvitationUrl,
  buildQrMatrix,
  parseInstallReferrer,
  parseInvitationUrl,
  parsePastedInvitation,
} from '../src/invitations/links';
import {
  INVITE_CACHE_KEY,
  InvitationPanel,
  formatFetchedAt,
  qrPath,
} from '../src/invitations/InvitePanel';
import { InvitationScanner, interpretScanResults } from '../src/invitations/scanner';
import { InstallHandoff } from '../src/invitations/InstallHandoff';
import {
  PENDING_KEY,
  PRE_LOGIN_ACCOUNT_ID,
  attachPendingInvitations,
  clearPendingInvitation,
  clearPostAuthInvitation,
  loadPendingInvitation,
  peekPostAuthInvitation,
  recordInvitationResolution,
  savePendingInvitation,
  setPostAuthInvitation,
  takePostAuthInvitation,
} from '../src/invitations/pending';
import {
  listPendingInvitations,
  savePendingInvitation as writePendingRow,
} from '../src/storage/invitations';
import { readCache, writeCache } from '../src/storage/cache';
import type { AppStorage } from '../src/storage/database';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { ThemeProvider } from '../src/theme/provider';
import type { CommandEnvelope, CommandOutcome } from '../src/sync/api';

// Task 14: 招待保存・QR・iOS貼り付け・Android取得, end to end.
//
// MOCKED-LAYER: `backend/queries` is the injected read wire and `sync/api`
// the injected command wire (the server contract itself is verified by the
// pgTAP/deno suites); the device storage is REAL SQLite, so the pending
// invitation rows, the offline cache and the send queue are the production
// SQL. Native modules (camera, clipboard, install referrer, image picker)
// are mocked — real device behaviour (camera session, UIPasteControl,
// Google Play Install Referrer) is recorded as device-pending in
// docs/testing/app-foundation-friends-ui.md and is NEVER claimed verified
// by these tests.
//
// Timers: renderRouter enables jest fake timers — every wait goes through
// waitFor/findBy, which advance the fake clock.

// ---------------------------------------------------------------------------
// Module mocks (hoisted by jest; factories only read mock* bindings lazily)
// ---------------------------------------------------------------------------

let mockSession: { user: { id: string; email?: string } } | null = null;
let mockProfileRow: {
  user_id_confirmed_at: string | null;
  onboarding_seen_at: string | null;
} | null = null;
let mockStorage: AppStorage | null = null;
let mockAppClient: unknown;
let mockSend: jest.Mock;

const mockSignInWithOAuth = jest.fn();
const mockExchangeCodeForSession = jest.fn();
const mockOpenAuthSession = jest.fn();
const mockInvoke = jest.fn();

// Native seams (read lazily inside the mocked factories).
let mockCameraGranted = false;
const mockRequestPermission = jest.fn();
const mockScanFromURL = jest.fn();
const mockLaunchImageLibrary = jest.fn();
const mockGetStringAsync = jest.fn();
const mockSetStringAsync = jest.fn();
const mockGetInstallReferrer = jest.fn();

jest.mock('../src/backend/client', () => ({
  getAppClient: () => {
    if (mockAppClient instanceof Error) throw mockAppClient;
    if (!mockAppClient) throw new Error('invitation-flow test: client not installed');
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
      if (!mockStorage) throw new Error('invitation-flow test: storage not installed');
      return mockStorage;
    },
  };
});

jest.mock('../src/backend/queries', () => {
  const actual = jest.requireActual('../src/backend/queries');
  return {
    ...actual,
    resolveInvitation: jest.fn(),
    getInvitationStatus: jest.fn(),
    searchProfiles: jest.fn(),
    getProfile: jest.fn(),
    listFriends: jest.fn(),
    listRequests: jest.fn(),
  };
});

jest.mock('../src/sync/api', () => {
  const actual = jest.requireActual('../src/sync/api');
  return {
    ...actual,
    createCommandApi: jest.fn(() => ({
      send: (envelope: CommandEnvelope) => mockSend(envelope),
    })),
  };
});

jest.mock('expo-camera', () => {
  const React = require('react');
  return {
    Camera: {
      scanFromURLAsync: (uri: string, types: string[]) => mockScanFromURL(uri, types),
    },
    CameraView: (props: Record<string, unknown>) =>
      React.createElement('CameraViewMock', props),
    useCameraPermissions: () => [
      { granted: mockCameraGranted, status: mockCameraGranted ? 'granted' : 'denied' },
      mockRequestPermission,
    ],
  };
});

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (options: unknown) => mockLaunchImageLibrary(options),
}));

jest.mock('expo-clipboard', () => {
  const React = require('react');
  return {
    isPasteButtonAvailable: true,
    getStringAsync: (...args: unknown[]) => mockGetStringAsync(...args),
    setStringAsync: (...args: unknown[]) => mockSetStringAsync(...args),
    ClipboardPasteButton: (props: Record<string, unknown>) =>
      React.createElement('ClipboardPasteButtonMock', props),
  };
});

jest.mock('expo-application', () => ({
  getInstallReferrerAsync: () => mockGetInstallReferrer(),
}));

const mockResolveInvitation = jest.mocked(resolveInvitation);
const mockGetInvitationStatus = jest.mocked(getInvitationStatus);

const actualDatabase = jest.requireActual(
  '../src/storage/database',
) as typeof import('../src/storage/database');

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const INVITE_ORIGIN = 'https://invite.example.com';
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const TOKEN_C = 'c'.repeat(32);
const ACCOUNT = 'account-1';
const INVITER_UUID = '00000000-0000-4000-8000-000000000001';

const inviter: ProfileSummary = {
  userId: INVITER_UUID,
  userIdText: 'aoi_07',
  displayName: 'あおい',
  avatarPath: null,
};

const EXPIRES_IN_5_DAYS = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

function fakeSession(id: string, email?: string): Session {
  return { user: { id, email } } as unknown as Session;
}

function validResolution(status: 'valid' | 'invalidated' | 'expired' = 'valid') {
  return { status, expiresAt: EXPIRES_IN_5_DAYS, inviter };
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

function defaultSend(envelope: CommandEnvelope): CommandOutcome {
  switch (envelope.kind) {
    case 'get_or_create_invitation':
      return {
        status: 'ok',
        data: { result: { invitation_token: TOKEN_C, expires_at: EXPIRES_IN_5_DAYS } },
      };
    case 'reissue_invitation':
      return {
        status: 'ok',
        data: { result: { invitation_token: TOKEN_B, expires_at: EXPIRES_IN_5_DAYS } },
      };
    default:
      return { status: 'ok' };
  }
}

function sentKinds(): string[] {
  return mockSend.mock.calls.map(
    ([envelope]) => (envelope as CommandEnvelope).kind,
  );
}

/**
 * Waits until at least `minimum` 案内済み記録 commands were sent. A route
 * that resolved successfully still has this trailing await when the visible
 * assertion passes; ending the test there leaks its act() scope into the
 * NEXT test (blank tree). Every test that reaches a resolved confirmation
 * drains the chain before finishing.
 */
async function drainGuideMarks(minimum: number): Promise<void> {
  await waitFor(() =>
    expect(
      sentKinds().filter((kind) => kind === 'mark_onboarding_seen').length,
    ).toBeGreaterThanOrEqual(minimum),
  );
  // Seeing the command is only the MIDDLE of the chain: the provider still
  // commits setOnboardingSeen(true) afterwards. Flush that tail so no act()
  // scope is left open when this test ends (an open scope corrupts the next
  // test's render — blank tree).
  await act(async () => {
    await Promise.resolve();
  });
}

let tmpDir: string;

async function installStorage(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invitation-flow-'));
  const driver = new NodeSqliteDriver(path.join(tmpDir, 'app.db'));
  mockStorage = await actualDatabase.openAppDatabase({ driver });
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

function memoryThemeStore() {
  const data = new Map<string, string>();
  return {
    read: async (key: string) => data.get(key) ?? null,
    write: async (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

type ThemeStore = ReturnType<typeof memoryThemeStore>;

function themed(ui: React.ReactNode, store: ThemeStore = memoryThemeStore()) {
  return (
    <ThemeProvider store={store} deviceScheme="light">
      {ui}
    </ThemeProvider>
  );
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockSession = null;
  mockProfileRow = null;
  mockAppClient = undefined;
  mockCameraGranted = false;
  mockRequestPermission.mockResolvedValue({ granted: false });
  mockScanFromURL.mockResolvedValue([]);
  mockLaunchImageLibrary.mockResolvedValue({ canceled: true });
  mockGetInstallReferrer.mockResolvedValue('');
  clearRememberedDestination();
  clearPostAuthInvitation();
  // Test-only origin: the invite URL must come from configuration, never
  // from a fabricated domain. Individual tests delete it to assert the
  // fail-clear behaviour.
  process.env.EXPO_PUBLIC_INVITE_ORIGIN = INVITE_ORIGIN;
  await installStorage();
  installClient();

  mockSignInWithOAuth.mockResolvedValue({
    data: { provider: 'apple', url: 'https://example.com/authorize?provider=apple&code_challenge=x' },
    error: null,
  });
  mockOpenAuthSession.mockResolvedValue({ type: 'cancel' });
  mockInvoke.mockResolvedValue({ data: { result: {} }, error: null });
  mockExchangeCodeForSession.mockImplementation(async () => {
    const session = fakeSession(ACCOUNT, 'a@example.com');
    mockSession = session;
    return { data: { session }, error: null };
  });
  mockSend = jest.fn(async (envelope: CommandEnvelope) => defaultSend(envelope));
  mockResolveInvitation.mockResolvedValue(validResolution());
  mockGetInvitationStatus.mockResolvedValue({
    status: 'valid',
    invitationToken: TOKEN_A,
    expiresAt: EXPIRES_IN_5_DAYS,
  } satisfies OwnInvitationStatus);
});

afterEach(async () => {
  // Settle any work still queued by the finished test so its act() scope
  // cannot overlap the NEXT test's render (blank tree otherwise).
  await act(async () => {
    await Promise.resolve();
  });
  delete process.env.EXPO_PUBLIC_INVITE_ORIGIN;
  const storage = mockStorage;
  mockStorage = null;
  if (storage !== null) {
    try {
      await storage.close();
    } catch {
      // Already closed by the screen's teardown.
    }
  }
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A. Invitation link building / parsing (the ONLY token entry points)
// ---------------------------------------------------------------------------

describe('招待リンクの構築と解析', () => {
  it('builds <origin>/invitation/<token> and fails clearly without an origin', () => {
    expect(buildInvitationUrl(TOKEN_A)).toBe(`${INVITE_ORIGIN}/invitation/${TOKEN_A}`);
    // No configured origin → a named error, never a fabricated domain.
    delete process.env.EXPO_PUBLIC_INVITE_ORIGIN;
    expect(() => buildInvitationUrl(TOKEN_A)).toThrow(InviteOriginError);
    try {
      buildInvitationUrl(TOKEN_A);
      throw new Error('expected buildInvitationUrl to throw');
    } catch (cause) {
      expect(String(cause)).toContain('EXPO_PUBLIC_INVITE_ORIGIN');
    }
    // A malformed token never produces a URL either.
    process.env.EXPO_PUBLIC_INVITE_ORIGIN = INVITE_ORIGIN;
    expect(() => buildInvitationUrl('not-a-token')).toThrow(/invalid invitation token/);
  });

  it('parses invitation links in URL, deep-link and bare-path shapes', () => {
    expect(parseInvitationUrl(`${INVITE_ORIGIN}/invitation/${TOKEN_A}`)).toBe(TOKEN_A);
    expect(parseInvitationUrl(`app://invitation/${TOKEN_A}`)).toBe(TOKEN_A);
    expect(parseInvitationUrl(`/invitation/${TOKEN_A}`)).toBe(TOKEN_A);
    expect(parseInvitationUrl(`${INVITE_ORIGIN}/invitation/${TOKEN_A}?x=1#y`)).toBe(TOKEN_A);
  });

  it('rejects anything that is not an invitation link (不正URL)', () => {
    expect(parseInvitationUrl('https://example.com/other')).toBeNull();
    expect(parseInvitationUrl(`${INVITE_ORIGIN}/invitation/${TOKEN_A.toUpperCase()}`)).toBeNull();
    expect(parseInvitationUrl(`${INVITE_ORIGIN}/invitation/${'a'.repeat(31)}`)).toBeNull();
    expect(parseInvitationUrl('random words')).toBeNull();
    expect(parseInvitationUrl('')).toBeNull();
  });

  it('reads ONLY the allowed invitation parameter from install referrers', () => {
    // The value "may not be a complete, absolute URL" — query-string form.
    expect(parseInstallReferrer('utm_source=google-play&utm_medium=organic')).toEqual({
      kind: 'none',
    });
    expect(parseInstallReferrer(`invitation=${TOKEN_A}`)).toEqual({
      kind: 'token',
      token: TOKEN_A,
    });
    expect(
      parseInstallReferrer(`utm_source=google-play&invitation=${TOKEN_A}&fb=xyz`),
    ).toEqual({ kind: 'token', token: TOKEN_A });
    // Full URL form.
    expect(
      parseInstallReferrer(
        `https://play.google.com/store/apps/details?id=x.y&invitation=${TOKEN_A}`,
      ),
    ).toEqual({ kind: 'token', token: TOKEN_A });
    // Other parameters can NEVER produce a token, even with valid hex.
    expect(parseInstallReferrer(`ref=${TOKEN_B}`)).toEqual({ kind: 'none' });
    expect(parseInstallReferrer('invitation=nope')).toEqual({ kind: 'invalid' });
    expect(parseInstallReferrer('')).toEqual({ kind: 'none' });
  });

  it('parses pasted text (link, referrer-style, empty, garbage)', () => {
    expect(parsePastedInvitation(`${INVITE_ORIGIN}/invitation/${TOKEN_A}`)).toEqual({
      kind: 'token',
      token: TOKEN_A,
    });
    expect(parsePastedInvitation(`invitation=${TOKEN_B}`)).toEqual({
      kind: 'token',
      token: TOKEN_B,
    });
    expect(parsePastedInvitation('   ')).toEqual({ kind: 'none' });
    expect(parsePastedInvitation('hello world')).toEqual({ kind: 'invalid' });
  });

  it('builds a QR matrix from the URL and one SVG path from the matrix', () => {
    const url = `${INVITE_ORIGIN}/invitation/${TOKEN_A}`;
    const other = `${INVITE_ORIGIN}/invitation/${TOKEN_B}`;
    const qr = buildQrMatrix(url);
    // Square matrix of odd size (QR spec), deterministic per input.
    expect(qr.modules).toHaveLength(qr.size);
    for (const row of qr.modules) expect(row).toHaveLength(qr.size);
    expect(qr.size % 2).toBe(1);
    expect(buildQrMatrix(url)).toEqual(qr);
    // The rendered path covers the dark modules as ONE path data string.
    const d = qrPath(qr.modules);
    expect(d.length).toBeGreaterThan(0);
    expect(d.startsWith('M')).toBe(true);
    const darkCount = qr.modules.flat().filter(Boolean).length;
    expect(d.match(/h1v1h-1z/g)).toHaveLength(darkCount);
    // A different URL → a different matrix (the QR encodes the URL).
    expect(buildQrMatrix(other)).not.toEqual(qr);
  });
});

// ---------------------------------------------------------------------------
// B. Pending invitation storage rules (real SQLite): 別招待・復元不能・OAuth attach
// ---------------------------------------------------------------------------

describe('pending invitation の保存規則', () => {
  it('keeps the FIRST invitation when a second one is opened (別招待)', async () => {
    const db = mockStorage!;
    const first = await savePendingInvitation(db, {
      accountId: null,
      payload: { token: TOKEN_A, url: `${INVITE_ORIGIN}/invitation/${TOKEN_A}`, source: 'route' },
      now: Date.now(),
    });
    expect(first.keptExisting).toBe(false);

    const second = await savePendingInvitation(db, {
      accountId: null,
      payload: { token: TOKEN_B, url: `${INVITE_ORIGIN}/invitation/${TOKEN_B}`, source: 'qr' },
      now: Date.now(),
    });
    // 別の招待を開いても最初の招待を維持する.
    expect(second.keptExisting).toBe(true);
    expect(second.payload.token).toBe(TOKEN_A);

    const loaded = await loadPendingInvitation(db, null);
    expect(loaded?.token).toBe(TOKEN_A);
    expect(loaded?.source).toBe('route'); // the first save's metadata wins
  });

  it('replaces a dead first invitation so the user is not stuck', async () => {
    const db = mockStorage!;
    const past = new Date(Date.now() - 60_000).toISOString();
    await savePendingInvitation(db, {
      accountId: null,
      payload: { token: TOKEN_A, url: '', source: 'route', expiresAt: past },
      now: Date.now(),
    });
    const result = await savePendingInvitation(db, {
      accountId: null,
      payload: { token: TOKEN_B, url: '', source: 'link' },
      now: Date.now(),
    });
    expect(result.keptExisting).toBe(false);
    expect((await loadPendingInvitation(db, null))?.token).toBe(TOKEN_B);
  });

  it('drops a corrupt row without throwing (復元不能でも登録を止めない)', async () => {
    const db = mockStorage!;
    await writePendingRow(db, {
      accountId: PRE_LOGIN_ACCOUNT_ID,
      invitationKey: PENDING_KEY,
      payload: { not: 'an invitation' },
    });
    expect(await loadPendingInvitation(db, null)).toBeNull();
    // The unreadable row is gone so the next save can land cleanly.
    expect(await listPendingInvitations(db, PRE_LOGIN_ACCOUNT_ID)).toHaveLength(0);
    const saved = await savePendingInvitation(db, {
      accountId: null,
      payload: { token: TOKEN_A, url: '', source: 'paste' },
    });
    expect(saved.keptExisting).toBe(false);
    expect((await loadPendingInvitation(db, null))?.token).toBe(TOKEN_A);
  });

  it('moves pre-login rows to the account after OAuth, keeping the live first', async () => {
    const db = mockStorage!;
    // The account already has a live invitation; a pre-login row exists too.
    await savePendingInvitation(db, {
      accountId: ACCOUNT,
      payload: { token: TOKEN_A, url: '', source: 'route' },
    });
    await savePendingInvitation(db, {
      accountId: null,
      payload: { token: TOKEN_B, url: '', source: 'link' },
    });

    const merged = await attachPendingInvitations(db, ACCOUNT);
    expect(merged.map((payload) => payload.token)).toEqual([TOKEN_A]); // first wins
    // The pre-login bucket is emptied — the row was MOVED, not copied.
    expect(await listPendingInvitations(db, PRE_LOGIN_ACCOUNT_ID)).toHaveLength(0);
    expect((await loadPendingInvitation(db, ACCOUNT))?.token).toBe(TOKEN_A);
  });

  it('records a resolution only for the SAME token (取得時点 cache)', async () => {
    const db = mockStorage!;
    await savePendingInvitation(db, {
      accountId: ACCOUNT,
      payload: { token: TOKEN_A, url: '', source: 'route' },
    });
    const fetchedAt = Date.now();
    const applied = await recordInvitationResolution(db, ACCOUNT, {
      token: TOKEN_B, // different token: must NOT be applied
      status: 'valid',
      expiresAt: EXPIRES_IN_5_DAYS,
      inviter: { displayName: inviter.displayName, userIdText: inviter.userIdText },
      fetchedAt,
    });
    expect(applied).toBe(false);
    expect((await loadPendingInvitation(db, ACCOUNT))?.resolution).toBeUndefined();

    expect(
      await recordInvitationResolution(db, ACCOUNT, {
        token: TOKEN_A,
        status: 'valid',
        expiresAt: EXPIRES_IN_5_DAYS,
        inviter: { displayName: inviter.displayName, userIdText: inviter.userIdText },
        fetchedAt,
      }),
    ).toBe(true);
    const row = await loadPendingInvitation(db, ACCOUNT);
    expect(row?.resolution?.status).toBe('valid');
    expect(row?.resolution?.inviter.userIdText).toBe('aoi_07');
    expect(row?.resolution?.fetchedAt).toBe(fetchedAt);
  });

  it('clears a bucket and cycles the post-auth return target', async () => {
    const db = mockStorage!;
    await savePendingInvitation(db, {
      accountId: null,
      payload: { token: TOKEN_A, url: '', source: 'route' },
    });
    await clearPendingInvitation(db, null);
    expect(await loadPendingInvitation(db, null)).toBeNull();

    // Post-auth target: peek does not consume, take does.
    setPostAuthInvitation(TOKEN_A);
    expect(peekPostAuthInvitation()).toBe(TOKEN_A);
    expect(peekPostAuthInvitation()).toBe(TOKEN_A);
    expect(takePostAuthInvitation()).toBe(TOKEN_A);
    expect(takePostAuthInvitation()).toBeNull();
    setPostAuthInvitation(TOKEN_B);
    clearPostAuthInvitation();
    expect(peekPostAuthInvitation()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C. Scanner interpretation (pure) + the scanner component with a fake camera
// ---------------------------------------------------------------------------

describe('interpretScanResults', () => {
  it('classifies empty / invalid / multiple / token', () => {
    expect(interpretScanResults([])).toEqual({ kind: 'empty' });
    expect(interpretScanResults([{ data: 'nope' }])).toEqual({ kind: 'invalid' });
    expect(
      interpretScanResults([
        { data: `${INVITE_ORIGIN}/invitation/${TOKEN_A}` },
        { data: `${INVITE_ORIGIN}/invitation/${TOKEN_B}` },
      ]),
    ).toEqual({ kind: 'multiple' });
    // Duplicates of the SAME link count once.
    expect(
      interpretScanResults([
        { data: `${INVITE_ORIGIN}/invitation/${TOKEN_A}` },
        { data: `app://invitation/${TOKEN_A}` },
      ]),
    ).toEqual({ kind: 'token', token: TOKEN_A });
    expect(
      interpretScanResults([{ data: `${INVITE_ORIGIN}/invitation/${TOKEN_A}` }]),
    ).toEqual({ kind: 'token', token: TOKEN_A });
  });
});

describe('QRスキャナ部品', () => {
  function scannerTree(
    props: Partial<React.ComponentProps<typeof InvitationScanner>> = {},
  ) {
    return themed(
      <InvitationScanner testID="invitation-scanner" onToken={jest.fn()} {...props} />,
    );
  }

  it('explains an invalid camera code without emitting, then emits ONCE for a valid one', async () => {
    const onToken = jest.fn();
    mockCameraGranted = true;
    await render(scannerTree({ onToken }));

    const camera = await screen.findByTestId('scanner-camera');
    await fireEvent(camera, 'barcodeScanned', { data: 'garbage' });
    await screen.findByTestId('scanner-notice');
    expect(screen.getByText(/招待リンクとして読み取れませんでした/)).toBeTruthy();
    expect(onToken).not.toHaveBeenCalled();

    await fireEvent(camera, 'barcodeScanned', {
      data: `${INVITE_ORIGIN}/invitation/${TOKEN_A}`,
    });
    await waitFor(() => expect(onToken).toHaveBeenCalledTimes(1));
    expect(onToken).toHaveBeenCalledWith(TOKEN_A);
    // Latched: a lingering frame cannot fire a second time.
    await fireEvent(camera, 'barcodeScanned', {
      data: `${INVITE_ORIGIN}/invitation/${TOKEN_B}`,
    });
    expect(onToken).toHaveBeenCalledTimes(1);
  });

  it('stops the camera entirely while the screen is hidden (active=false)', async () => {
    mockCameraGranted = true;
    await render(scannerTree({ active: false }));
    expect(screen.queryByTestId('invitation-scanner')).toBeNull();
    expect(screen.queryByTestId('scanner-camera')).toBeNull();
  });

  it('explains a permission denial and keeps the image fallback usable', async () => {
    mockCameraGranted = false;
    const onToken = jest.fn();
    mockLaunchImageLibrary.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/qr.png' }],
    });
    mockScanFromURL.mockResolvedValue([
      { data: `${INVITE_ORIGIN}/invitation/${TOKEN_A}` },
    ]);
    await render(scannerTree({ onToken }));

    await screen.findByTestId('scanner-permission-denied');
    expect(screen.queryByTestId('scanner-camera')).toBeNull();

    await fireEvent.press(await screen.findByTestId('scanner-pick-image'));
    await waitFor(() => expect(onToken).toHaveBeenCalledWith(TOKEN_A));
    expect(mockScanFromURL).toHaveBeenCalledWith('file:///tmp/qr.png', ['qr']);
  });

  it('explains multiple codes, empty images and scan failures without an exception', async () => {
    mockCameraGranted = false;
    const onToken = jest.fn();
    mockLaunchImageLibrary.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/qr.png' }],
    });
    await render(scannerTree({ onToken }));
    const pick = await screen.findByTestId('scanner-pick-image');

    // 複数コード: explained, never navigates.
    mockScanFromURL.mockResolvedValue([
      { data: `${INVITE_ORIGIN}/invitation/${TOKEN_A}` },
      { data: `${INVITE_ORIGIN}/invitation/${TOKEN_B}` },
    ]);
    await fireEvent.press(pick);
    await waitFor(() =>
      expect(screen.getByText(/複数の招待リンクが見つかりました/)).toBeTruthy(),
    );
    expect(onToken).not.toHaveBeenCalled();

    // Not an invitation QR at all.
    mockScanFromURL.mockResolvedValue([{ data: 'https://example.com/x' }]);
    await fireEvent.press(pick);
    await waitFor(() =>
      expect(
        screen.getAllByText(/招待リンクとして読み取れませんでした/).length,
      ).toBeGreaterThan(0),
    );
    expect(onToken).not.toHaveBeenCalled();

    // No code in the image.
    mockScanFromURL.mockResolvedValue([]);
    await fireEvent.press(pick);
    await waitFor(() => expect(screen.getByText(/QRコードが見つかりませんでした/)).toBeTruthy());

    // Native scan failure → explained, no unhandled rejection.
    mockScanFromURL.mockRejectedValue(new Error('scan failed'));
    await fireEvent.press(pick);
    await waitFor(() => expect(screen.getByText(/画像を読み取れませんでした/)).toBeTruthy());

    // OS cancel keeps the previous notice unchanged (it is not a new error).
    mockLaunchImageLibrary.mockResolvedValue({ canceled: true });
    await fireEvent.press(pick);
    expect(screen.getAllByTestId('scanner-notice')).toHaveLength(1);
    expect(onToken).not.toHaveBeenCalled();
  });

  it('treats an OS cancel as silence (no notice, no emission, no scan)', async () => {
    mockCameraGranted = false;
    const onToken = jest.fn();
    mockLaunchImageLibrary.mockResolvedValue({ canceled: true });
    await render(scannerTree({ onToken }));
    await fireEvent.press(await screen.findByTestId('scanner-pick-image'));
    await waitFor(() => expect(mockLaunchImageLibrary).toHaveBeenCalled());
    expect(mockScanFromURL).not.toHaveBeenCalled();
    expect(screen.queryByTestId('scanner-notice')).toBeNull();
    expect(onToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D. Install hand-off: Android referrer + iOS explicit paste
// ---------------------------------------------------------------------------

describe('インストール引き継ぎ', () => {
  it('Android: reads the allowed invitation parameter from the referrer', async () => {
    const onInvitation = jest.fn();
    mockGetInstallReferrer.mockResolvedValue(
      `utm_source=google-play&utm_medium=organic&invitation=${TOKEN_A}`,
    );
    await render(
      themed(<InstallHandoff platform="android" onInvitation={onInvitation} testID="handoff" />),
    );
    await screen.findByTestId('install-found');
    await fireEvent.press(screen.getByTestId('install-open'));
    expect(onInvitation).toHaveBeenCalledWith(TOKEN_A);
    // Read exactly once per mount.
    expect(mockGetInstallReferrer).toHaveBeenCalledTimes(1);
  });

  it('Android: a plain install shows nothing, a referrer failure never blocks', async () => {
    mockGetInstallReferrer.mockResolvedValue('utm_source=google-play&utm_medium=organic');
    const first = await render(
      themed(<InstallHandoff platform="android" testID="handoff" />),
    );
    await waitFor(() => expect(mockGetInstallReferrer).toHaveBeenCalled());
    expect(screen.queryByTestId('install-found')).toBeNull();
    expect(screen.queryByTestId('install-invalid')).toBeNull();
    await first.unmount();

    // No Play Store / service unavailable: swallowed into silence.
    mockGetInstallReferrer.mockClear();
    mockGetInstallReferrer.mockRejectedValue(
      new Error('ERR_APPLICATION_INSTALL_REFERRER_UNAVAILABLE'),
    );
    await render(themed(<InstallHandoff platform="android" testID="handoff" />));
    await waitFor(() => expect(mockGetInstallReferrer).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('install-found')).toBeNull();
    expect(screen.queryByTestId('install-invalid')).toBeNull();
    expect(screen.getByTestId('handoff')).toBeTruthy(); // still mounted, no crash
  });

  it('Android: an unusable invitation value is explained, not thrown', async () => {
    mockGetInstallReferrer.mockResolvedValue('invitation=oops');
    await render(themed(<InstallHandoff platform="android" testID="handoff" />));
    await screen.findByTestId('install-invalid');
    expect(screen.getByText(/ログイン・登録はそのまま進められます/)).toBeTruthy();
  });

  it('iOS: the OS paste control is explicit-only, with a nearby hint and no auto-read', async () => {
    const onInvitation = jest.fn();
    await render(themed(<InstallHandoff onInvitation={onInvitation} testID="handoff" />));

    // The hint explains the purpose NEXT to the control (近接説明).
    await screen.findByTestId('install-paste-hint');
    expect(screen.getByText(/下のボタンで貼り付けて招待を確認できます/)).toBeTruthy();
    const pasteButton = screen.getByTestId('install-paste-button');
    // OS標準ラベルは書換えず — no children/label override on the control.
    expect(pasteButton.props.children).toBeUndefined();
    expect((pasteButton.props as Record<string, unknown>).title).toBeUndefined();

    // Explicit user action only: NOTHING read the clipboard automatically.
    expect(mockGetStringAsync).not.toHaveBeenCalled();

    // A valid pasted link → found → opens the confirmation target.
    await fireEvent.press(pasteButton, {
      type: 'text',
      text: `${INVITE_ORIGIN}/invitation/${TOKEN_B}`,
    });
    await screen.findByTestId('install-found');
    await fireEvent.press(screen.getByTestId('install-open'));
    expect(onInvitation).toHaveBeenCalledWith(TOKEN_B);
    expect(mockGetStringAsync).not.toHaveBeenCalled(); // still no auto-read
  });

  it('iOS: an unusable paste is explained and never blocks registration', async () => {
    const onInvitation = jest.fn();
    await render(themed(<InstallHandoff onInvitation={onInvitation} testID="handoff" />));
    const pasteButton = await screen.findByTestId('install-paste-button');
    await fireEvent.press(pasteButton, { type: 'text', text: 'hello world' });
    await screen.findByTestId('install-invalid');
    expect(onInvitation).not.toHaveBeenCalled();
    expect(screen.getByTestId('handoff')).toBeTruthy();
  });

  it('iOS: without the paste control (iOS < 16) nothing is rendered', async () => {
    await render(themed(<InstallHandoff pasteAvailable={false} testID="handoff" />));
    expect(screen.queryByTestId('handoff')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E. InvitePanel (inviter side): reuse / issue / reissue / offline QR
// ---------------------------------------------------------------------------

describe('招待パネル (自分の招待QR)', () => {
  function panelProps(
    overrides: Partial<React.ComponentProps<typeof InvitationPanel>> = {},
  ): React.ComponentProps<typeof InvitationPanel> {
    return {
      accountId: ACCOUNT,
      storage: mockStorage,
      ...overrides,
    };
  }

  async function renderPanel(
    overrides: Partial<React.ComponentProps<typeof InvitationPanel>> = {},
  ) {
    return render(themed(<InvitationPanel {...panelProps(overrides)} />));
  }

  it('reuses a valid link: URL + QR shown, NO command on mount (有効リンク再利用)', async () => {
    await renderPanel();
    await screen.findByTestId('invite-url');
    expect(screen.getByTestId('invite-url').props.children).toBe(
      `${INVITE_ORIGIN}/invitation/${TOKEN_A}`,
    );
    // QR rendered as SVG from the URL matrix.
    expect(screen.getByTestId('invite-qr')).toBeTruthy();
    expect(screen.getByTestId('invite-expiry')).toBeTruthy();
    // Reuse: no issue/reissue command may fire.
    expect(sentKinds()).toHaveLength(0);
    expect(mockGetInvitationStatus).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when the invite origin is not configured (no fabricated domain)', async () => {
    delete process.env.EXPO_PUBLIC_INVITE_ORIGIN;
    await renderPanel();
    await screen.findByTestId('invite-origin-error');
    expect(screen.getByText(/EXPO_PUBLIC_INVITE_ORIGIN/)).toBeTruthy();
    expect(screen.queryByTestId('invite-qr')).toBeNull();
    expect(screen.getByText(/招待URLを作成できません/)).toBeTruthy();
  });

  it('offers an explicit 発行 action when the account has no invitation yet', async () => {
    mockGetInvitationStatus.mockResolvedValue({
      status: 'none',
    } satisfies OwnInvitationStatus);
    await renderPanel();
    await screen.findByTestId('invite-none');

    await fireEvent.press(screen.getByTestId('invite-issue'));
    await screen.findByTestId('invite-url');
    expect(sentKinds()).toEqual(['get_or_create_invitation']);
    expect(screen.getByTestId('invite-url').props.children).toBe(
      `${INVITE_ORIGIN}/invitation/${TOKEN_C}`,
    );
  });

  it('auto-issues a new link for an expired one (期限切れ新規発行)', async () => {
    mockGetInvitationStatus.mockResolvedValue({
      status: 'expired',
      invitationToken: null,
      expiresAt: EXPIRES_IN_5_DAYS,
    } satisfies OwnInvitationStatus);
    await renderPanel();
    await screen.findByTestId('invite-url');
    expect(sentKinds()).toEqual(['get_or_create_invitation']);
    expect(screen.getByTestId('invite-url').props.children).toContain(TOKEN_C);
  });

  it('requires confirmation for 手動再発行 and never runs it twice on a race (再発行競合)', async () => {
    await renderPanel();
    await screen.findByTestId('invite-url');

    // Opening the confirmation does NOT send anything.
    await fireEvent.press(screen.getByTestId('invite-reissue'));
    await screen.findByTestId('invite-reissue-confirm');
    expect(screen.getByText(/再発行すると、いまの招待リンクは無効になります/)).toBeTruthy();
    expect(sentKinds()).toHaveLength(0);

    // Cancel: still nothing sent.
    await fireEvent.press(screen.getByTestId('invite-reissue-no'));
    await waitFor(() => expect(screen.queryByTestId('invite-reissue-confirm')).toBeNull());
    expect(sentKinds()).toHaveLength(0);

    // Confirm → the reissue runs, but hold it in flight to build the race.
    let resolveReissue!: (outcome: CommandOutcome) => void;
    mockSend.mockImplementation((envelope: CommandEnvelope) => {
      if (envelope.kind === 'reissue_invitation') {
        return new Promise<CommandOutcome>((resolve) => {
          resolveReissue = resolve;
        });
      }
      return defaultSend(envelope);
    });
    await fireEvent.press(screen.getByTestId('invite-reissue'));
    await fireEvent.press(screen.getByTestId('invite-reissue-yes'));
    await waitFor(() => expect(resolveReissue).toBeDefined());

    // While the first reissue is in flight, another confirm+yes cycle must
    // not start a second command (synchronous double-tap guard).
    await fireEvent.press(screen.getByTestId('invite-reissue'));
    await fireEvent.press(screen.getByTestId('invite-reissue-yes'));
    resolveReissue({
      status: 'ok',
      data: { result: { invitation_token: TOKEN_B, expires_at: EXPIRES_IN_5_DAYS } },
    });
    await waitFor(() =>
      expect(screen.getByTestId('invite-url').props.children).toBe(
        `${INVITE_ORIGIN}/invitation/${TOKEN_B}`,
      ),
    );
    expect(sentKinds()).toEqual(['reissue_invitation']);
    // The old link is gone once the new one landed.
    expect(screen.queryByText(
      `${INVITE_ORIGIN}/invitation/${TOKEN_A}`,
    )).toBeNull();
  });

  it('shows the cached link with 取得時点 while offline and disables 新規発行・再発行', async () => {
    const fetchedAt = new Date(2026, 8, 20, 10, 5).getTime();
    await writeCache(
      mockStorage!,
      ACCOUNT,
      INVITE_CACHE_KEY,
      { token: TOKEN_A, expiresAt: EXPIRES_IN_5_DAYS },
      fetchedAt,
    );
    mockGetInvitationStatus.mockRejectedValue(new TypeError('Network request failed'));

    await renderPanel();
    // Offline-capable view from the cache, then the fetch failure keeps it.
    await screen.findByTestId('invite-offline');
    expect(screen.getByTestId('invite-url').props.children).toBe(
      `${INVITE_ORIGIN}/invitation/${TOKEN_A}`,
    );
    expect(screen.getByTestId('invite-qr')).toBeTruthy();
    // 取得時点 display connected to the cache written by the API result.
    expect(screen.getByText(new RegExp(formatFetchedAt(fetchedAt)))).toBeTruthy();
    expect(screen.getByText(/新規発行・再発行はオンラインで実行できます/)).toBeTruthy();
    // No reissue action while offline.
    expect(screen.queryByTestId('invite-reissue')).toBeNull();
    expect(sentKinds()).toHaveLength(0);
  });

  it('caches the last successful result account-scoped for the offline view', async () => {
    await renderPanel();
    await screen.findByTestId('invite-url');
    // persistCache is fire-and-forget: poll the real SQL until it lands.
    await waitFor(async () => {
      const record = await readCache<{ token: string }>(
        mockStorage!,
        ACCOUNT,
        INVITE_CACHE_KEY,
      );
      expect(record?.payload.token).toBe(TOKEN_A);
      expect(typeof record?.fetchedAt).toBe('number');
    });
  });
});

// ---------------------------------------------------------------------------
// F. `/invitation/<token>` route (invitee side) through the real router
// ---------------------------------------------------------------------------

describe('招待確認画面', () => {
  beforeEach(() => {
    mockSession = fakeSession(ACCOUNT, 'a@example.com');
    mockProfileRow = {
      user_id_confirmed_at: '2026-09-26T00:00:00Z',
      onboarding_seen_at: null,
    };
  });

  it('valid: confirmation card + 申請 through the queue + 案内済み記録', async () => {
    const { app } = await renderApp(`/invitation/${TOKEN_A}`);
    await screen.findByTestId('invitation-inviter');
    expect(screen.getByTestId('invitation-inviter-name').props.children).toBe('あおい');
    expect(screen.getByTestId('invitation-inviter-userid').props.children).toBe('aoi_07');
    expect(screen.getByText(/有効期限/)).toBeTruthy();
    // 案内済み記録: a successful resolve marks the guide seen.
    await waitFor(() => expect(sentKinds()).toContain('mark_onboarding_seen'));
    expect(mockResolveInvitation).toHaveBeenCalledWith(TOKEN_A);

    // 本人が申請を送る: Task-4 request with the invitation token, via the queue.
    await fireEvent.press(screen.getByTestId('invitation-apply'));
    await screen.findByTestId('invitation-apply-sent');
    const requests = mockSend.mock.calls.filter(
      ([envelope]) => (envelope as CommandEnvelope).kind === 'request',
    );
    expect(requests).toHaveLength(1);
    const payload = (requests[0][0] as CommandEnvelope).payload;
    expect(payload).toMatchObject({
      target_user_id: INVITER_UUID,
      invitation_token: TOKEN_A,
    });
    expect(app.getPathname()).toBe(`/invitation/${TOKEN_A}`);
    // Settle the trailing 案内済み記録 commit FIRST, then assert that the
    // successful resolve was RECORDED on the pending row — this is what the
    // offline relaunch test later reads as 取得時点.
    await drainGuideMarks(1);
    await waitFor(async () => {
      const row = await loadPendingInvitation(mockStorage!, ACCOUNT);
      expect(row?.resolution?.status).toBe('valid');
      expect(row?.resolution?.inviter.userIdText).toBe('aoi_07');
      expect(typeof row?.resolution?.fetchedAt).toBe('number');
    });
  });

  it('invalidated: 失効表示 with no apply action', async () => {
    mockResolveInvitation.mockResolvedValue(validResolution('invalidated'));
    await renderApp(`/invitation/${TOKEN_A}`);
    await screen.findByTestId('invitation-invalidated');
    expect(screen.getByText(/この招待は無効になりました/)).toBeTruthy();
    expect(screen.queryByTestId('invitation-apply')).toBeNull();
    expect(screen.getByTestId('invitation-dead-search')).toBeTruthy();
    await drainGuideMarks(1); // the route still marks the guide seen
  });

  it('expired: 期限切れ表示 (7日間)', async () => {
    mockResolveInvitation.mockResolvedValue(validResolution('expired'));
    await renderApp(`/invitation/${TOKEN_A}`);
    await screen.findByTestId('invitation-expired');
    expect(screen.getByText(/有効期間\(7日間\)を過ぎています/)).toBeTruthy();
    expect(screen.queryByTestId('invitation-apply')).toBeNull();
    await drainGuideMarks(1);
  });

  it('404: the link is unknown without a crash (復元不能)', async () => {
    mockResolveInvitation.mockRejectedValue(new QueryError('invitation not found', 404));
    const { app } = await renderApp(`/invitation/${TOKEN_A}`);
    await screen.findByTestId('invitation-not-found');
    expect(screen.getByText(/見つかりませんでした/)).toBeTruthy();
    expect(screen.queryByTestId('invitation-apply')).toBeNull();
    expect(app.getPathname()).toBe(`/invitation/${TOKEN_A}`);
  });

  it('malformed token: explained locally, the network is never touched', async () => {
    const { app } = await renderApp('/invitation/not-a-real-token');
    await screen.findByTestId('invitation-invalid');
    expect(screen.getByText(/元の招待リンクを開き直してください/)).toBeTruthy();
    expect(mockResolveInvitation).not.toHaveBeenCalled();
    expect(app.getPathname()).toBe('/invitation/not-a-real-token');
  });

  it('offline relaunch: shows the recorded resolution with 取得時点 (再起動)', async () => {
    // Stage EXACTLY what the previous (online) session recorded on the
    // device: the pending row with its resolution. A fresh render IS the
    // relaunch — expo-router's global store does not fully reset on a
    // second renderRouter within one test, so the relaunch is one render.
    await savePendingInvitation(mockStorage!, {
      accountId: ACCOUNT,
      payload: {
        token: TOKEN_A,
        url: `${INVITE_ORIGIN}/invitation/${TOKEN_A}`,
        source: 'route',
        expiresAt: EXPIRES_IN_5_DAYS,
      },
    });
    expect(
      await recordInvitationResolution(mockStorage!, ACCOUNT, {
        token: TOKEN_A,
        status: 'valid',
        expiresAt: EXPIRES_IN_5_DAYS,
        inviter: { displayName: inviter.displayName, userIdText: inviter.userIdText },
        fetchedAt: Date.now() - 60_000,
      }),
    ).toBe(true);

    // Relaunched while the network is down.
    mockResolveInvitation.mockRejectedValue(new TypeError('Network request failed'));
    const second = await renderApp(`/invitation/${TOKEN_A}`);
    await screen.findByTestId('invitation-cached');
    expect(screen.getByText(/前回取得した内容を表示しています/)).toBeTruthy();
    expect(screen.getByText(/現在の有効性は未確認です/)).toBeTruthy();
    expect(screen.getByTestId('invitation-inviter-name').props.children).toBe('あおい');
    expect(screen.getByText(/取得時点/)).toBeTruthy();
    // Never presented as currently valid: no apply action offline.
    expect(screen.queryByTestId('invitation-apply')).toBeNull();
    expect(second.app.getPathname()).toBe(`/invitation/${TOKEN_A}`);
  });

  it('offline without a cache: explained + 再試行 recovers', async () => {
    mockResolveInvitation.mockRejectedValue(new TypeError('Network request failed'));
    const { app } = await renderApp(`/invitation/${TOKEN_B}`);
    await screen.findByTestId('invitation-network-error');
    expect(screen.queryByTestId('invitation-cached')).toBeNull();

    mockResolveInvitation.mockResolvedValue(validResolution());
    await fireEvent.press(screen.getByTestId('invitation-retry'));
    await screen.findByTestId('invitation-inviter');
    expect(app.getPathname()).toBe(`/invitation/${TOKEN_B}`);
    await drainGuideMarks(1);
  });
});

// ---------------------------------------------------------------------------
// G. 登録の前後をまたぐ復元: pre-login save → OAuth → confirmation
// ---------------------------------------------------------------------------

describe('ログイン・登録をまたぐ招待復元', () => {
  it('saves signed out, returns from OAuth to the confirmation (OAuth復帰)', async () => {
    // Open the invitation while signed out.
    const first = await renderApp(`/invitation/${TOKEN_A}`);
    await screen.findByTestId('invitation-need-login');
    // Stored in the PRE-LOGIN bucket before any account exists.
    expect((await loadPendingInvitation(mockStorage!, null))?.token).toBe(TOKEN_A);
    expect(peekPostAuthInvitation()).toBe(TOKEN_A);

    // Continue to login and complete the OAuth round trip (registered user).
    await fireEvent.press(screen.getByTestId('invitation-login'));
    await waitFor(() => expect(first.app.getPathname()).toBe('/login'));
    mockProfileRow = {
      user_id_confirmed_at: '2026-09-26T00:00:00Z',
      onboarding_seen_at: null,
    };
    mockOpenAuthSession.mockResolvedValue({
      type: 'success',
      url: 'app://auth/callback?code=abc',
    });
    await screen.findByTestId('login-apple');
    await fireEvent.press(screen.getByTestId('login-apple'));

    // 登録後に招待先確認へ直接戻る: back on the SAME confirmation.
    await waitFor(() => expect(first.app.getPathname()).toBe(`/invitation/${TOKEN_A}`));
    // findAll: the pushed login may leave the first instance in the stack.
    await waitFor(() =>
      expect(screen.getAllByTestId('invitation-inviter').length).toBeGreaterThan(0),
    );
    // The pre-login row was ATTACHED to the account and the bucket emptied.
    // Both in ONE wait: the route's own account-bucket save can land before
    // attach's delete commits (fire-and-forget effect).
    await waitFor(async () => {
      const rows = await listPendingInvitations(mockStorage!, ACCOUNT);
      expect(
        rows.map((row) => (row.payload as { token: string }).token),
      ).toEqual([TOKEN_A]);
      expect(await listPendingInvitations(mockStorage!, PRE_LOGIN_ACCOUNT_ID)).toHaveLength(0);
    });
    // Let the route's trailing 案内済み記録 chain finish before the test ends.
    await drainGuideMarks(1);
  });

  it('returns from an OAuth callback deep link to the pending confirmation', async () => {
    // Stage exactly what a signed-out open of the invitation leaves behind
    // (the route's own save + post-auth target), then "die" mid-OAuth: the
    // relaunched process is a FRESH router — one renderRouter per test,
    // because expo-router's global store does not fully reset within a test.
    await savePendingInvitation(mockStorage!, {
      accountId: null,
      payload: {
        token: TOKEN_A,
        url: `${INVITE_ORIGIN}/invitation/${TOKEN_A}`,
        source: 'route',
      },
    });
    setPostAuthInvitation(TOKEN_A);

    // Relaunched by the provider callback: the exchange completes the session.
    mockProfileRow = {
      user_id_confirmed_at: '2026-09-26T00:00:00Z',
      onboarding_seen_at: null,
    };
    mockExchangeCodeForSession.mockImplementation(async () => {
      mockSession = fakeSession(ACCOUNT, 'a@example.com');
      return { data: { session: mockSession }, error: null };
    });
    const { app } = await renderApp('/auth/callback?code=deep-code');
    // The callback routes to the pending invitation target, not /home.
    await waitFor(() => expect(app.getPathname()).toBe(`/invitation/${TOKEN_A}`));
    await screen.findByTestId('invitation-inviter');
    // Attach moved the pre-login row onto the account (OAuth復帰で失わない).
    await waitFor(async () => {
      expect(await listPendingInvitations(mockStorage!, PRE_LOGIN_ACCOUNT_ID)).toHaveLength(0);
      expect((await loadPendingInvitation(mockStorage!, ACCOUNT))?.token).toBe(TOKEN_A);
    });
    // Reaching the confirmation consumed the return target.
    expect(peekPostAuthInvitation()).toBeNull();
    await drainGuideMarks(1);
  });

  it('登録後: lands on the invitation confirmation instead of home (招待経則)', async () => {
    mockSession = fakeSession(ACCOUNT, 'a@example.com');
    mockProfileRow = { user_id_confirmed_at: null, onboarding_seen_at: null };

    const { app } = await renderApp(`/invitation/${TOKEN_A}`);
    await screen.findByTestId('invitation-need-register');
    expect(peekPostAuthInvitation()).toBe(TOKEN_A);
    // The row is stored for the signed-in, unregistered account.
    expect((await loadPendingInvitation(mockStorage!, ACCOUNT))?.token).toBe(TOKEN_A);

    await fireEvent.press(screen.getByTestId('invitation-register'));
    await waitFor(() => expect(app.getPathname()).toBe('/register'));
    await screen.findByTestId('register-user-id');
    await fireEvent.changeText(screen.getByTestId('register-user-id'), 'hanako');
    await fireEvent.changeText(screen.getByTestId('register-display-name'), '花子');
    await fireEvent.press(screen.getByTestId('register-review'));
    await screen.findByTestId('register-submit');
    mockSend.mockImplementation(async (envelope: CommandEnvelope) => {
      if (envelope.kind === 'register') {
        mockProfileRow = {
          user_id_confirmed_at: '2026-09-26T00:00:00Z',
          onboarding_seen_at: null,
        };
      }
      return defaultSend(envelope);
    });
    await fireEvent.press(screen.getByTestId('register-submit'));

    // 招待経則では登録後に招待先確認へ直接戻る — not /home.
    await waitFor(() => expect(app.getPathname()).toBe(`/invitation/${TOKEN_A}`));
    await waitFor(() =>
      expect(screen.getAllByTestId('invitation-inviter').length).toBeGreaterThan(0),
    );
    expect(sentKinds()).toContain('register');
    // submitRegistration marks the guide seen (invited account) and the
    // confirmation route marks again after its resolve — drain BOTH chains.
    await drainGuideMarks(2);
    // The target was consumed exactly once.
    expect(takePostAuthInvitation()).toBeNull();
  });

  it('keeps the normal /home destination when no invitation is pending', async () => {
    mockSession = fakeSession(ACCOUNT, 'a@example.com');
    mockProfileRow = { user_id_confirmed_at: null, onboarding_seen_at: null };
    const { app } = await renderApp('/register');
    await screen.findByTestId('register-user-id');
    await fireEvent.changeText(screen.getByTestId('register-user-id'), 'hanako');
    await fireEvent.changeText(screen.getByTestId('register-display-name'), '花子');
    await fireEvent.press(screen.getByTestId('register-review'));
    await screen.findByTestId('register-submit');
    await fireEvent.press(screen.getByTestId('register-submit'));
    await waitFor(() => expect(app.getPathname()).toBe('/home'));
    expect(peekPostAuthInvitation()).toBeNull();
    expect(sentKinds()).not.toContain('reissue_invitation');
  });
});

// ---------------------------------------------------------------------------
// H. 友達追加画面 wiring: toggles, panel, scanner → confirmation route
// ---------------------------------------------------------------------------

describe('友達追加画面の招待QR配線', () => {
  beforeEach(() => {
    mockSession = fakeSession(ACCOUNT, 'a@example.com');
    mockProfileRow = {
      user_id_confirmed_at: '2026-09-26T00:00:00Z',
      onboarding_seen_at: null,
    };
  });

  it('toggles the invite panel and the scanner, and opens a scanned invitation', async () => {
    const { app } = await renderApp('/friends/add');
    await screen.findByTestId('toggle-invite');
    expect(screen.queryByTestId('friends-invite-panel')).toBeNull();

    // 招待QR表示 → own link + QR.
    await fireEvent.press(screen.getByTestId('toggle-invite'));
    await screen.findByTestId('friends-invite-panel');
    await waitFor(() =>
      expect(screen.getByTestId('invite-url').props.children).toBe(
        `${INVITE_ORIGIN}/invitation/${TOKEN_A}`,
      ),
    );

    // QR読み取る → camera/image scanner (permission denied by default here).
    await fireEvent.press(screen.getByTestId('toggle-scanner'));
    await screen.findByTestId('friends-scanner');
    expect(screen.getByTestId('scanner-permission-denied')).toBeTruthy();

    // 画像から読み取る with ONE valid invitation → the confirmation route.
    mockLaunchImageLibrary.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/qr.png' }],
    });
    mockScanFromURL.mockResolvedValue([
      { data: `${INVITE_ORIGIN}/invitation/${TOKEN_B}` },
    ]);
    await fireEvent.press(screen.getByTestId('scanner-pick-image'));
    await waitFor(() => expect(app.getPathname()).toBe(`/invitation/${TOKEN_B}`));
    await screen.findByTestId('invitation-inviter');
    await drainGuideMarks(1);
  });

  it('keeps the camera mounted only while the screen is visible (focused)', async () => {
    mockCameraGranted = true;
    const store = memoryThemeStore();
    const tree = (focused: boolean) => (
      <ThemeProvider store={store} deviceScheme="light">
        <AdaptiveLayoutProvider>
          {/* Real AuthProvider with injected client + storage (the router's
              own AuthProvider has no seams; behaviour is identical). */}
          <AuthProvider client={mockAppClient as never} storage={mockStorage}>
            <AddArea focused={focused} />
          </AuthProvider>
        </AdaptiveLayoutProvider>
      </ThemeProvider>
    );

    const view = await render(tree(true));
    await fireEvent.press(await screen.findByTestId('toggle-scanner'));
    await screen.findByTestId('scanner-camera'); // visible → the camera runs

    await view.rerender(tree(false));
    // Hidden: the camera session is stopped (the scanner unmounts entirely).
    await waitFor(() => expect(screen.queryByTestId('scanner-camera')).toBeNull());
    expect(screen.queryByTestId('friends-scanner')).toBeNull();
    // The toggle itself survives, so the user can reopen it.
    expect(screen.getByTestId('toggle-scanner')).toBeTruthy();
  });
});
