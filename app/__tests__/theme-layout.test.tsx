import { useEffect, useState } from 'react';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Dimensions, Text, View } from 'react-native';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_SCHEDULE,
  SAME_TIME_MESSAGE,
  TIME_FORMAT_MESSAGE,
  THEME_MODE_LABELS,
  evaluateThemeSchedule,
  formatTimeOfDay,
  nextBoundaryAfter,
  parseTimeOfDay,
  resolveTheme,
  validateThemeSchedule,
  type ThemeSchedule,
} from '../src/theme/schedule';
import {
  ThemeProvider,
  createStorageThemeStore,
  useTheme,
} from '../src/theme/provider';
import { darkTokens, focusRing, lightTokens, spacing } from '../src/theme/tokens';
import {
  AdaptiveLayout,
  AdaptiveLayoutProvider,
  SPLIT_MIN_LOGICAL_WIDTH,
  resolveLayoutMode,
  useAdaptiveLayoutState,
} from '../src/navigation/AdaptiveLayout';
import { Button } from '../src/ui/Button';
import { Field } from '../src/ui/Field';
import { Screen } from '../src/ui/Screen';
import { StatusNotice } from '../src/ui/StatusNotice';
import { clearRememberedDestination } from '../src/navigation/entry';

// Task 11: モノトーンUI・テーマ・可変レイアウト.
//
// MOCKED-LAYER: the route tests inject a signed-in auth context (same as
// navigation-shell.test.tsx) and the device DB driver is Node SQLite behind
// the production SQL (same as registration-flow / storage.integration), so
// persistence assertions run against the REAL device_settings table.
// On-device verification status is recorded separately in
// docs/testing/app-foundation-friends-ui.md.

// ---------------------------------------------------------------------------
// Module mocks (hoisted by jest; factories only read mock* bindings lazily)
// ---------------------------------------------------------------------------

let mockStorage: import('../src/storage/database').AppStorage | null = null;

jest.mock('../src/auth/provider', () => {
  const React = require('react');
  const value = {
    status: 'ready',
    error: null,
    accountId: 'account-theme',
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
    classifyCompletedLogin: () => ({ kind: 'returning', accountId: 'account-theme' }),
  };
});

jest.mock('../src/storage/database', () => {
  const actual = jest.requireActual('../src/storage/database');
  return {
    ...actual,
    openAppDatabase: async () => {
      if (!mockStorage) throw new Error('theme-layout test: storage not installed');
      return mockStorage;
    },
  };
});

// Task 17: マイページ reads the published profile; mock the own-row read so
// the route tests never reach the network.
jest.mock('../src/backend/profile', () => {
  const actual = jest.requireActual('../src/backend/profile');
  return {
    ...actual,
    getOwnPublication: jest.fn(async () => ({
      userIdText: 'theme_user',
      displayName: 'テーマ太郎',
      introduction: null,
      avatarPath: null,
      profileVersion: 1,
    })),
    profileImageUrl: jest.fn(async () => null),
  };
});

const actualDatabase = jest.requireActual('../src/storage/database') as typeof import('../src/storage/database');
const { NodeSqliteDriver } = jest.requireActual('../src/storage/testSupport/nodePorts') as typeof import('../src/storage/testSupport/nodePorts');
const { readDeviceSetting, writeDeviceSetting, writeAccountSetting } = jest.requireActual('../src/storage/settings') as typeof import('../src/storage/settings');
const { deleteAccountData } = actualDatabase;

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

interface MemoryStore {
  store: import('../src/theme/provider').ThemeSettingsStore;
  data: Map<string, string>;
  writes: Array<{ key: string; value: string }>;
}

function memoryStore(seed: Record<string, string> = {}): MemoryStore {
  const data = new Map(Object.entries(seed));
  const writes: Array<{ key: string; value: string }> = [];
  return {
    store: {
      read: async (key) => data.get(key) ?? null,
      write: async (key, value) => {
        writes.push({ key, value });
        data.set(key, value);
      },
    },
    data,
    writes,
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
    emitActive: () => {
      for (const handler of [...listeners]) handler('active');
    },
  };
}

/** Dumps the context into JSON for assertions. */
function ThemeProbe({ testID = 'theme-probe' }: { testID?: string }) {
  const { mode, scheme, schedule, ready } = useTheme();
  return (
    <Text testID={testID}>
      {JSON.stringify({ mode, scheme, schedule, ready })}
    </Text>
  );
}

function readProbe(testID = 'theme-probe') {
  return JSON.parse(screen.getByTestId(testID).props.children as string) as {
    mode: string;
    scheme: string;
    schedule: ThemeSchedule;
    ready: boolean;
  };
}

async function renderApp(initialUrl: string) {
  const app = await renderRouter('./src/app', { initialUrl });
  return { app };
}

/** Fresh real-SQLite storage per test (production schema + driver SQL). */
let openedStorage: import('../src/storage/database').AppStorage | null = null;

async function installStorage(prefix: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tmpDirs.push(dir);
  const driver = new NodeSqliteDriver(path.join(dir, 'app.db'));
  openedStorage = await actualDatabase.openAppDatabase({ driver });
  mockStorage = openedStorage;
}

const tmpDirs: string[] = [];

// Close the per-test SQLite handle so Jest's run exits cleanly (an open
// connection is an open handle; registration-flow.test.tsx does the same).
afterEach(async () => {
  await openedStorage?.close();
  openedStorage = null;
  mockStorage = null;
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort — temp files never block the suite.
    }
  }
});

// ---------------------------------------------------------------------------
// A. 承認済み試作A → semantic tokens
// ---------------------------------------------------------------------------

describe('tokens from the approved monochrome prototype (承認済み試作A)', () => {
  it('keeps the light phone palette verbatim', () => {
    expect(lightTokens.scheme).toBe('light');
    expect(lightTokens.surface).toBe('#ffffff');
    expect(lightTokens.text).toBe('#272a2e');
    expect(lightTokens.muted).toBe('#62666d');
    expect(lightTokens.line).toBe('#e5e6e8');
    expect(lightTokens.soft).toBe('#f3f4f5');
    expect(lightTokens.accent).toBe('#30343a');
    expect(lightTokens.onAccent).toBe('#ffffff');
    expect(lightTokens.accentSoft).toBe('#e9ebee');
    expect(lightTokens.avatar).toBe('#e8e9e7');
    expect(lightTokens.avatarInk).toBe('#5c6260');
  });

  it('keeps the dark phone palette verbatim', () => {
    expect(darkTokens.scheme).toBe('dark');
    expect(darkTokens.surface).toBe('#202225');
    expect(darkTokens.text).toBe('#f0f1f3');
    expect(darkTokens.muted).toBe('#b3b7c0');
    expect(darkTokens.line).toBe('#3c4047');
    expect(darkTokens.soft).toBe('#2b2e33');
    expect(darkTokens.accent).toBe('#e1e4e9');
    expect(darkTokens.onAccent).toBe('#262a30');
    expect(darkTokens.accentSoft).toBe('#383c43');
    expect(darkTokens.avatar).toBe('#383e3c');
    expect(darkTokens.avatarInk).toBe('#c5cfca');
    // Board (screen chrome) in dark.
    expect(darkTokens.board).toBe('#15171a');
    expect(darkTokens.boardText).toBe('#f0f1f3');
    expect(darkTokens.boardMuted).toBe('#b1b5be');
    expect(darkTokens.boardLine).toBe('#515660');
    expect(darkTokens.boardControl).toBe('#272b31');
  });

  it('uses the monochrome baseline, not the blue variant', () => {
    // The approved variant is モノトーン — none of the .blue accent values.
    expect(lightTokens.accent).not.toBe('#345f91');
    expect(lightTokens.soft).not.toBe('#f0f4f9');
    expect(darkTokens.accent).not.toBe('#a6c9f5');
    expect(lightTokens.board).toBe('#efefec');
  });

  it('carries the spacing scale, focus ring and controls metrics', () => {
    expect(spacing).toEqual({ s1: 4, s2: 8, s3: 12, s4: 16, s5: 24, s6: 32, s7: 48 });
    expect(focusRing).toEqual({ color: '#5b88c3', width: 3, offset: 4 });
  });
});

// ---------------------------------------------------------------------------
// B. schedule: defaults, boundaries, day rollover, same-time rejection, TZ
// ---------------------------------------------------------------------------

describe('時間帯 schedule (local time 07:00 / 19:00)', () => {
  it('defaults to ライト07:00 / ダーク19:00 and 端末に合わせる', () => {
    expect(DEFAULT_THEME_SCHEDULE).toEqual({ lightStart: '07:00', darkStart: '19:00' });
    expect(DEFAULT_THEME_MODE).toBe('system');
    expect(THEME_MODE_LABELS.system).toBe('端末に合わせる');
    expect(THEME_MODE_LABELS.schedule).toBe('時間帯で切り替える');
  });

  it('parses and formats local times', () => {
    expect(parseTimeOfDay('07:00')).toBe(420);
    expect(parseTimeOfDay('7:30')).toBe(450);
    expect(parseTimeOfDay('23:59')).toBe(1439);
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('07:60')).toBeNull();
    expect(parseTimeOfDay('七時')).toBeNull();
    expect(formatTimeOfDay(420)).toBe('07:00');
    expect(formatTimeOfDay(1439)).toBe('23:59');
  });

  it('switches exactly at the 07:00 / 19:00 boundaries', () => {
    const schedule = DEFAULT_THEME_SCHEDULE;
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 26, 6, 59))).toBe('dark');
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 26, 7, 0))).toBe('light');
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 26, 18, 59))).toBe('light');
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 26, 19, 0))).toBe('dark');
  });

  it('keeps the dark window across midnight (日跨ぎ)', () => {
    const schedule = DEFAULT_THEME_SCHEDULE;
    // 19:00 starts the dark arc; it survives until 07:00 the NEXT day.
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 26, 23, 30))).toBe('dark');
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 27, 0, 0))).toBe('dark');
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 27, 4, 0))).toBe('dark');
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 27, 6, 59))).toBe('dark');
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 27, 7, 0))).toBe('light');
  });

  it('supports a custom schedule whose light window crosses midnight', () => {
    const schedule: ThemeSchedule = { lightStart: '22:00', darkStart: '06:00' };
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 26, 23, 0))).toBe('light');
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 27, 1, 0))).toBe('light');
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 27, 6, 0))).toBe('dark');
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 27, 12, 0))).toBe('dark');
    expect(evaluateThemeSchedule(schedule, new Date(2026, 8, 27, 22, 0))).toBe('light');
  });

  it('uses the DEVICE local wall time, not UTC (timezone changes apply on re-evaluation)', () => {
    // Note: mutating process.env.TZ is inert under Jest's runtime (verified:
    // the env string changes but `getHours()` keeps the old zone), so the
    // contract is asserted structurally instead: evaluation must read the
    // LOCAL wall-clock fields. A timezone change while the app is closed is
    // then picked up by the resume re-evaluation below (it re-reads the
    // current local time), and real cross-zone behaviour is exercised on
    // device via 端末設定 → docs/testing/app-foundation-friends-ui.md.
    const instant = new Date(Date.UTC(2026, 8, 26, 6, 0));
    const localMinutes = instant.getHours() * 60 + instant.getMinutes();
    const localExpected = localMinutes >= 420 && localMinutes < 1140 ? 'light' : 'dark';
    expect(evaluateThemeSchedule(DEFAULT_THEME_SCHEDULE, instant)).toBe(localExpected);
    // The instant's UTC reading (06:00) is dark — on any machine whose zone
    // differs from UTC in a way that flips the window, local must win.
    const utcExpected = 6 * 60 >= 420 && 6 * 60 < 1140 ? 'light' : 'dark';
    if (localExpected !== utcExpected) {
      expect(evaluateThemeSchedule(DEFAULT_THEME_SCHEDULE, instant)).not.toBe(utcExpected);
    }
  });

  it('rejects identical times and malformed input', () => {
    expect(validateThemeSchedule({ lightStart: '07:00', darkStart: '07:00' })).toEqual({
      ok: false,
      message: SAME_TIME_MESSAGE,
    });
    expect(validateThemeSchedule({ lightStart: '07:00', darkStart: '19:00' })).toEqual({ ok: true });
    expect(validateThemeSchedule({ lightStart: 'nope', darkStart: '19:00' })).toEqual({
      ok: false,
      message: TIME_FORMAT_MESSAGE,
    });
  });

  it('computes the next foreground boundary for wake-up', () => {
    const now = new Date(2026, 8, 26, 12, 0);
    const next = nextBoundaryAfter(DEFAULT_THEME_SCHEDULE, now);
    expect(next.getHours()).toBe(19);
    expect(next.getMinutes()).toBe(0);
    // Already past today's boundaries → tomorrow 07:00.
    const late = new Date(2026, 8, 26, 20, 0);
    const after = nextBoundaryAfter(DEFAULT_THEME_SCHEDULE, late);
    expect(after.getDate()).toBe(27);
    expect(after.getHours()).toBe(7);
  });

  it('resolves the 4 modes', () => {
    const now = new Date(2026, 8, 26, 12, 0);
    const base = { schedule: DEFAULT_THEME_SCHEDULE, now };
    expect(resolveTheme({ ...base, mode: 'light', deviceScheme: 'dark' })).toBe('light');
    expect(resolveTheme({ ...base, mode: 'dark', deviceScheme: 'light' })).toBe('dark');
    expect(resolveTheme({ ...base, mode: 'system', deviceScheme: 'dark' })).toBe('dark');
    expect(resolveTheme({ ...base, mode: 'system', deviceScheme: 'light' })).toBe('light');
    expect(resolveTheme({ ...base, mode: 'system', deviceScheme: null })).toBe('light');
    expect(resolveTheme({ ...base, mode: 'schedule', deviceScheme: 'dark' })).toBe('light');
    expect(
      resolveTheme({
        mode: 'schedule',
        schedule: DEFAULT_THEME_SCHEDULE,
        deviceScheme: 'light',
        now: new Date(2026, 8, 26, 20, 0),
      }),
    ).toBe('dark');
  });
});

// ---------------------------------------------------------------------------
// C. 899/900 + font-scale boundary, split vs single rendering
// ---------------------------------------------------------------------------

describe('adaptive layout boundary', () => {
  it('switches at the inclusive 900 logical-pixel boundary', () => {
    expect(SPLIT_MIN_LOGICAL_WIDTH).toBe(900);
    expect(resolveLayoutMode(899, 1)).toBe('single');
    expect(resolveLayoutMode(900, 1)).toBe('split');
    expect(resolveLayoutMode(1024, 1)).toBe('split');
  });

  it('falls back to single column when text scaling no longer fits', () => {
    expect(resolveLayoutMode(900, 1.3)).toBe('split');
    expect(resolveLayoutMode(900, 1.5)).toBe('single');
    expect(resolveLayoutMode(1200, 2)).toBe('single');
  });

  function ListPane() {
    const { selectPeer } = useAdaptiveLayoutState();
    return (
      <View>
        <Text>一覧</Text>
        <Button label="あおい" testID="pick-aoi" onPress={() => selectPeer('aoi_07')} />
      </View>
    );
  }

  function DetailPane() {
    const { selectedPeerId, draft, setDraft, selectPeer } = useAdaptiveLayoutState();
    return (
      <View>
        <Text testID="detail-peer">{selectedPeerId ?? '未選択'}</Text>
        <Field label="メッセージ" testID="composer" value={draft} onChangeText={setDraft} />
        <Button label="一覧に戻る" testID="back-to-list" onPress={() => selectPeer(null)} />
      </View>
    );
  }

  function Harness({ width }: { width: number }) {
    return (
      <ThemeProvider store={memoryStore().store} deviceScheme="light">
        <AdaptiveLayoutProvider>
          <AdaptiveLayout
            metrics={{ width, fontScale: 1 }}
            list={<ListPane />}
            detail={<DetailPane />}
            emptyDetail={<Text testID="empty-detail">相手を選択してください</Text>}
          />
        </AdaptiveLayoutProvider>
      </ThemeProvider>
    );
  }

  it('renders list+detail at 900 and single column at 899', async () => {
    const wide = await render(<Harness width={900} />);
    expect(screen.getByTestId('adaptive-layout-list')).toBeTruthy();
    expect(screen.getByTestId('adaptive-layout-detail')).toBeTruthy();
    expect(screen.getByTestId('empty-detail')).toBeTruthy();
    await wide.unmount();

    await render(<Harness width={899} />);
    expect(screen.getByTestId('adaptive-layout-list')).toBeTruthy();
    expect(screen.queryByTestId('adaptive-layout-detail')).toBeNull();
  });

  it('keeps the selected peer and the draft across the switch (same state, both modes)', async () => {
    const view = await render(<Harness width={900} />);
    expect(screen.getByTestId('adaptive-layout-detail')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('pick-aoi'));
    expect(screen.getByTestId('detail-peer').props.children).toBe('aoi_07');
    await fireEvent.changeText(screen.getByTestId('composer'), 'おはよう');
    expect(screen.queryByTestId('empty-detail')).toBeNull();

    // 900 → 899: same component, same lifted state, one pane.
    await view.rerender(<Harness width={899} />);
    expect(screen.queryByTestId('adaptive-layout-list')).toBeNull();
    expect(screen.getByTestId('adaptive-layout-detail')).toBeTruthy();
    expect(screen.getByTestId('detail-peer').props.children).toBe('aoi_07');
    expect(screen.getByTestId('composer').props.value).toBe('おはよう');

    // And back to the wide layout without losing either.
    await view.rerender(<Harness width={1024} />);
    expect(screen.getByTestId('adaptive-layout-list')).toBeTruthy();
    expect(screen.getByTestId('detail-peer').props.children).toBe('aoi_07');
    expect(screen.getByTestId('composer').props.value).toBe('おはよう');
  });
});

// ---------------------------------------------------------------------------
// D. theme provider: default mode, device scheme change, resume re-evaluation
// ---------------------------------------------------------------------------

describe('theme provider', () => {
  it('defaults to 端末に合わせる and follows the device scheme change', async () => {
    const store = memoryStore();
    const holder: {
      setMode?: (mode: 'light' | 'dark' | 'system' | 'schedule') => Promise<void>;
    } = {};
    function Setter() {
      const theme = useTheme();
      holder.setMode = theme.setMode;
      return null;
    }
    const ui = (scheme: 'light' | 'dark') => (
      <ThemeProvider store={store.store} deviceScheme={scheme}>
        <Setter />
        <ThemeProbe />
      </ThemeProvider>
    );

    const { rerender } = await render(ui('light'));
    await waitFor(() => expect(readProbe().ready).toBe(true));
    expect(readProbe().mode).toBe('system');
    expect(readProbe().scheme).toBe('light');

    // 端末のテーマ変更 (light → dark) flips the rendered scheme live.
    await rerender(ui('dark'));
    await waitFor(() => expect(readProbe().scheme).toBe('dark'));

    // ...but an explicit ライト choice overrides the device setting.
    await act(async () => {
      await holder.setMode?.('light');
    });
    expect(readProbe().mode).toBe('light');
    await rerender(ui('dark'));
    expect(readProbe().scheme).toBe('light');
  });

  it('applies a fixed mode regardless of the device scheme and persists it', async () => {
    const store = memoryStore();
    const holder: {
      setMode?: (mode: 'light' | 'dark' | 'system' | 'schedule') => Promise<void>;
    } = {};
    function Setter() {
      const theme = useTheme();
      holder.setMode = theme.setMode;
      return null;
    }
    await render(
      <ThemeProvider store={store.store} deviceScheme="dark">
        <Setter />
        <ThemeProbe />
      </ThemeProvider>,
    );
    await waitFor(() => expect(readProbe().ready).toBe(true));

    await act(async () => {
      await holder.setMode?.('light');
    });
    expect(readProbe().mode).toBe('light');
    expect(readProbe().scheme).toBe('light');
    expect(store.data.get('theme.mode')).toBe('light');
  });

  it('re-evaluates on resume when a boundary passed while closed (日跨ぎ→復帰)', async () => {
    let now = new Date(2026, 8, 26, 18, 0); // 18:00 → light
    const store = memoryStore({ 'theme.mode': 'schedule' });
    const { appState, emitActive } = fakeAppState();

    await render(
      <ThemeProvider
        store={store.store}
        deviceScheme="light"
        clock={() => now}
        appState={appState}
      >
        <ThemeProbe />
      </ThemeProvider>,
    );
    await waitFor(() => expect(readProbe().ready).toBe(true));
    expect(readProbe().mode).toBe('schedule');
    expect(readProbe().scheme).toBe('light');

    // App closed across midnight/07:00: on resume the NEW local time wins.
    now = new Date(2026, 8, 27, 6, 30); // 06:30 next day → still dark
    await act(async () => {
      emitActive();
    });
    await waitFor(() => expect(readProbe().scheme).toBe('dark'));

    now = new Date(2026, 8, 27, 7, 30); // past 07:00 → light
    await act(async () => {
      emitActive();
    });
    await waitFor(() => expect(readProbe().scheme).toBe('light'));
  });

  it('rejects an identical schedule without touching state or storage', async () => {
    const store = memoryStore();
    const holder: {
      save?: (next: ThemeSchedule) => Promise<{ ok: boolean; message?: string }>;
    } = {};
    function Saver() {
      const theme = useTheme();
      holder.save = theme.saveSchedule;
      return null;
    }
    await render(
      <ThemeProvider store={store.store} deviceScheme="light">
        <Saver />
        <ThemeProbe />
      </ThemeProvider>,
    );
    await waitFor(() => expect(readProbe().ready).toBe(true));

    let rejected: { ok: boolean; message?: string } | undefined;
    await act(async () => {
      rejected = await holder.save?.({ lightStart: '07:00', darkStart: '07:00' });
    });
    expect(rejected).toEqual({ ok: false, message: SAME_TIME_MESSAGE });
    expect(readProbe().schedule).toEqual({ lightStart: '07:00', darkStart: '19:00' });
    expect(store.writes.filter((w) => w.key === 'theme.schedule')).toHaveLength(0);
    expect(store.data.has('theme.schedule')).toBe(false);

    let accepted: { ok: boolean; message?: string } | undefined;
    await act(async () => {
      accepted = await holder.save?.({ lightStart: '07:00', darkStart: '21:00' });
    });
    expect(accepted?.ok).toBe(true);
    await waitFor(() =>
      expect(readProbe().schedule).toEqual({ lightStart: '07:00', darkStart: '21:00' }),
    );
    expect(JSON.parse(store.data.get('theme.schedule') ?? '{}')).toEqual({
      lightStart: '07:00',
      darkStart: '21:00',
    });
  });

  it('keeps the current screen instance and its input when the theme changes', async () => {
    let mounts = 0;
    function ScreenProbe() {
      const { setMode, tokens } = useTheme();
      const [text, setText] = useState('');
      useEffect(() => {
        mounts += 1;
      }, []);
      return (
        <View testID="probe-screen" style={{ backgroundColor: tokens.surface }}>
          <Field label="下書き" testID="probe-input" value={text} onChangeText={setText} />
          <Button label="ダークにする" testID="probe-dark" onPress={() => void setMode('dark')} />
        </View>
      );
    }
    const store = memoryStore();
    await render(
      <ThemeProvider store={store.store} deviceScheme="light">
        <ScreenProbe />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe-input')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('probe-input'), '消さない入力');
    await fireEvent.press(screen.getByTestId('probe-dark'));
    await waitFor(() => expect(store.data.get('theme.mode')).toBe('dark'));

    // Same mount, same input, new colours — the theme swap is style-only.
    expect(mounts).toBe(1);
    expect(screen.getByTestId('probe-input').props.value).toBe('消さない入力');
    await waitFor(() =>
      expect(screen.getByTestId('probe-screen').props.style).toEqual(
        expect.objectContaining({ backgroundColor: '#202225' }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// E. device settings survive account removal (ログアウト後も残る)
// ---------------------------------------------------------------------------

describe('device-scoped theme persistence', () => {
  it('keeps the theme settings after account data is deleted (logout semantics)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-logout-'));
    tmpDirs.push(dir);
    const driver = new NodeSqliteDriver(path.join(dir, 'app.db'));
    const db = await actualDatabase.openAppDatabase({ driver });
    try {
      const store = createStorageThemeStore(db);
      await store.write('theme.mode', 'dark');
      await store.write('theme.schedule', JSON.stringify({ lightStart: '07:00', darkStart: '21:00' }));
      await writeAccountSetting(db, 'account-theme', 'account-only-setting', 'gone');

      // Logout/account removal (Task 20 calls the same function).
      await deleteAccountData(db, 'account-theme');

      expect(await store.read('theme.mode')).toBe('dark');
      expect(await store.read('theme.schedule')).toContain('21:00');
      // Sanity: the account-scoped row really was removed.
      const leftover = await db.getFirstAsync(
        'SELECT value FROM device_settings WHERE account_id = ? AND key = ?',
        ['account-theme', 'account-only-setting'],
      );
      expect(leftover).toBeNull();
      expect(await readDeviceSetting(db, 'theme.mode')).toBe('dark');
    } finally {
      await db.close().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// F. UI components: labels, roles, focus, pressed, non-colour state
// ---------------------------------------------------------------------------

describe('shared UI components', () => {
  it('Button exposes role, state, pressed feedback and a selected marker', async () => {
    await render(
      <ThemeProvider store={memoryStore().store} deviceScheme="light">
        <Button label="保存" testID="btn" onPress={() => {}} />
        <Button label="ダーク" testID="btn-selected" selected onPress={() => {}} />
        <Button label="無効" testID="btn-disabled" disabled onPress={() => {}} />
      </ThemeProvider>,
    );

    const button = screen.getByLabelText('保存');
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityState).toMatchObject({ disabled: false });

    expect(screen.getByTestId('btn-selected').props.accessibilityState).toMatchObject({
      selected: true,
    });
    // Non-colour selected marker (✓) + a11y state.
    expect(screen.getByText('✓')).toBeTruthy();

    expect(screen.getByTestId('btn-disabled').props.accessibilityState).toMatchObject({
      disabled: true,
    });

    // Pressed feedback: the resolved style drops to the spike's 0.75 opacity.
    await fireEvent(screen.getByTestId('btn'), 'pressIn');
    await waitFor(() => {
      const style = screen.getByTestId('btn').props.style;
      const flat = JSON.stringify(Array.isArray(style) ? style : [style]);
      expect(flat).toContain('0.75');
    });
  });

  it('Field labels the input for screen readers and announces errors as text', async () => {
    await render(
      <ThemeProvider store={memoryStore().store} deviceScheme="light">
        <Field label="User ID" testID="field" value="" onChangeText={() => {}} hint="2〜20文字" />
        <Field label="時刻" testID="field-error" value="x" onChangeText={() => {}} error={TIME_FORMAT_MESSAGE} />
      </ThemeProvider>,
    );

    const input = screen.getByLabelText('User ID');
    expect(input.props.accessibilityHint).toBe('2〜20文字');

    // Visible label text, associated value, focus is wired on the input.
    expect(screen.getByText('User ID')).toBeTruthy();
    expect(typeof input.props.onFocus).toBe('function');
    expect(typeof input.props.onBlur).toBe('function');

    // Error is TEXT (never colour alone) and announced.
    const errorText = screen.getByText(`エラー: ${TIME_FORMAT_MESSAGE}`);
    expect(errorText.props.accessibilityRole).toBe('alert');
    expect(errorText.props.accessibilityLiveRegion).toBe('polite');
  });

  it('StatusNotice distinguishes state with a visible badge, not colour', async () => {
    await render(
      <ThemeProvider store={memoryStore().store} deviceScheme="light">
        <StatusNotice tone="error" title="保存できませんでした" testID="notice-error" />
        <StatusNotice tone="success" title="保存しました" testID="notice-success" />
      </ThemeProvider>,
    );
    expect(screen.getByText('エラー')).toBeTruthy();
    expect(screen.getByText('完了')).toBeTruthy();
    // The error title is announced as an alert (role lives on the text node).
    expect(screen.getByText('保存できませんでした').props.accessibilityRole).toBe('alert');
    // Titles differ by words, so tone never depends on hue alone.
    expect(screen.getByText('保存しました')).toBeTruthy();
  });

  it('Screen applies safe-area insets and a header role', async () => {
    await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 400, height: 800 },
          insets: { top: 47, right: 0, bottom: 34, left: 0 },
        }}
      >
        <ThemeProvider store={memoryStore().store} deviceScheme="light">
          <Screen title="テーマ" testID="screen">
            <Text>中身</Text>
          </Screen>
        </ThemeProvider>
      </SafeAreaProvider>,
    );

    expect(screen.getByRole('header', { name: 'テーマ' })).toBeTruthy();
    const style = JSON.stringify(screen.getByTestId('screen').props.style);
    expect(style).toContain('47'); // top inset
    expect(style).toContain('34'); // bottom inset
    expect(style).toContain('#ffffff'); // themed surface
  });
});

// ---------------------------------------------------------------------------
// G. route level: マイページ → テーマ設定 (real device_settings SQLite)
// ---------------------------------------------------------------------------
// G. route level: マイページ → テーマ設定 (real device_settings SQLite).
//    One renderRouter session per describe: the shared renderer + async
//    navigation make repeated boots inside one file flaky, so the flow is
//    asserted step-by-step on a single router (same style as
//    navigation-shell.test.tsx, which also keeps one flow per shell).
// ---------------------------------------------------------------------------

describe('theme settings screen', () => {
  beforeEach(async () => {
    await installStorage('theme-ui');
    // Deterministic cold start: no remembered destination from earlier tests.
    clearRememberedDestination();
  });

  afterEach(() => {
    mockStorage = null;
  });

  /**
   * Act-free device-settings barrier. `waitFor` (RNTL) wraps every retry in
   * `act`; retrying around the provider's async writes made act scopes
   * overlap in this shared renderer and stalled later updates, so persistence
   * is polled with plain timers instead — the read never touches React.
   */
  const expectDeviceSetting = async (key: string, expected: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = await readDeviceSetting(mockStorage!, key);
      if (value === expected) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`device setting ${key} never became ${expected}`);
  };

  /** Applies a mode; the selection state is committed inside the press act. */
  const pressMode = async (mode: string): Promise<void> => {
    await fireEvent.press(screen.getByTestId(`theme-mode-${mode}`));
    expect(screen.getByTestId(`theme-mode-${mode}`).props.accessibilityState).toMatchObject({
      selected: true,
    });
    await expectDeviceSetting('theme.mode', mode);
  };

  it('reaches the screen from マイページ with the 端末に合わせる default', async () => {
    const { app } = await renderApp('/mypage');
    await waitFor(() => expect(app.getPathname()).toBe('/mypage'));
    // Task 17: the placeholder became the published profile + its entries.
    await waitFor(() => expect(screen.getByTestId('mypage-edit-entry')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('mypage-theme-entry'));
    await waitFor(() => expect(app.getPathname()).toBe('/mypage/theme'));
    expect(screen.getByTestId('theme-settings-screen')).toBeTruthy();
    expect(
      screen.getByTestId('theme-mode-system').props.accessibilityState,
    ).toMatchObject({ selected: true });
    expect(screen.getByText(/ログアウトしても残ります/)).toBeTruthy();
    // Nothing was written for the default — it is a code default, not a store
    // entry, until the user actually changes something.
    expect(await readDeviceSetting(mockStorage!, 'theme.mode')).toBeNull();
  });

  it('applies and persists a mode choice to the device settings table', async () => {
    const { app } = await renderApp('/mypage/theme');
    await waitFor(() => expect(app.getPathname()).toBe('/mypage/theme'));

    await pressMode('dark');
    await pressMode('light');
    expect(screen.getByTestId('theme-mode-light').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('edits the schedule, rejects identical times and persists a valid one', async () => {
    // Enter 時間帯 directly through a device-seeded mode (no mode press here:
    // this test is about the schedule editor, and seeding exercises the
    // hydration path at the same time).
    await writeDeviceSetting(mockStorage!, 'theme.mode', 'schedule');
    const { app } = await renderApp('/mypage/theme');
    await waitFor(() => expect(app.getPathname()).toBe('/mypage/theme'));

    const lightField = await screen.findByTestId('theme-light-start');
    expect(lightField.props.value).toBe('07:00');
    expect(screen.getByTestId('theme-dark-start').props.value).toBe('19:00');

    // 同じ時刻 → rejected: message shown, input kept, nothing persisted.
    await fireEvent.changeText(screen.getByTestId('theme-dark-start'), '07:00');
    await fireEvent.press(screen.getByTestId('theme-schedule-save'));
    expect(await screen.findByTestId('theme-schedule-error')).toBeTruthy();
    expect(screen.getByText(SAME_TIME_MESSAGE)).toBeTruthy();
    expect(await readDeviceSetting(mockStorage!, 'theme.schedule')).toBeNull();
    expect(screen.getByTestId('theme-dark-start').props.value).toBe('07:00');

    // A valid time persists device-locally.
    await fireEvent.changeText(screen.getByTestId('theme-dark-start'), '21:00');
    await fireEvent.press(screen.getByTestId('theme-schedule-save'));
    await expectDeviceSetting('theme.schedule', JSON.stringify({ lightStart: '07:00', darkStart: '21:00' }));
    await screen.findByTestId('theme-schedule-saved');

    // Malformed input: field-level error, not persisted, previous value kept.
    await fireEvent.changeText(screen.getByTestId('theme-light-start'), '7時');
    await fireEvent.press(screen.getByTestId('theme-schedule-save'));
    expect(await screen.findByText(`エラー: ${TIME_FORMAT_MESSAGE}`)).toBeTruthy();
    expect(screen.getByTestId('theme-schedule-error')).toBeTruthy();
    expect(
      await readDeviceSetting(mockStorage!, 'theme.schedule'),
    ).toBe(JSON.stringify({ lightStart: '07:00', darkStart: '21:00' }));
  });
});

// ---------------------------------------------------------------------------
// H. shell: wide → left navigation (no iOS SplitView), narrow → bottom tabs
// ---------------------------------------------------------------------------

describe('adaptive tab shell', () => {
  beforeEach(async () => {
    await installStorage('theme-shell');
    clearRememberedDestination();
  });

  afterEach(() => {
    mockStorage = null;
    jest.restoreAllMocks();
  });

  it('uses the left navigation at ≥900 and keeps all four routes reachable', async () => {
    const spy = jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 1024, height: 768, scale: 2, fontScale: 1 });
    try {
      const { app } = await renderApp('/home');
      await waitFor(() => expect(app.getPathname()).toBe('/home'));

      expect(screen.getByTestId('left-nav')).toBeTruthy();
      expect(screen.getByTestId('leftnav-home').props.accessibilityState).toMatchObject({
        selected: true,
      });
      expect(screen.getByTestId('leftnav-chat').props.accessibilityState).toMatchObject({
        selected: false,
      });
      // The bottom bar is suppressed in split mode (hidden elements are not
      // matched by default queries).
      expect(screen.queryByTestId('tab-home')).toBeNull();

      // Same four routes: the rail navigates without changing destinations.
      // (Unawaited press + pathname wait — awaiting act on router navigation
      // deadlocks in this renderer.)
      await fireEvent.press(screen.getByTestId('leftnav-mypage'));
      await waitFor(() => expect(app.getPathname()).toBe('/mypage'));
      expect(screen.getByTestId('leftnav-mypage').props.accessibilityState).toMatchObject({
        selected: true,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the bottom four tabs on a narrow window', async () => {
    const { app } = await renderApp('/home');
    await waitFor(() => expect(app.getPathname()).toBe('/home'));
    for (const id of ['tab-home', 'tab-chat', 'tab-friends', 'tab-mypage']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.queryByTestId('left-nav')).toBeNull();
  });
});
