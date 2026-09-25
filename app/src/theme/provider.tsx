import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, useColorScheme } from 'react-native';

import {
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_SCHEDULE,
  THEME_MODES,
  nextBoundaryAfter,
  resolveTheme,
  validateThemeSchedule,
  type ScheduleValidation,
  type ThemeMode,
  type ThemeSchedule,
} from './schedule';
import { tokensFor, type ThemeScheme, type ThemeTokens } from './tokens';
import { openAppDatabase, type Storage } from '../storage/database';
import { readDeviceSetting, writeDeviceSetting } from '../storage/settings';

/**
 * Theme context (4 modes + 時間帯スケジュール + resolved tokens).
 *
 * Ownership: the persisted device-scoped settings, the mode/schedule state,
 * resolution to a light/dark scheme, and re-evaluation on app resume.
 *
 * Persistence is the Task 8 `device_settings` table in DEVICE scope
 * (`account_id IS NULL` via src/storage/settings.ts), because:
 * - the spec requires the theme choice to be per-device and to SURVIVE
 *   logout/account removal (device scope is explicitly exempt from
 *   `deleteAccountData`);
 * - no other client-side store exists in the app (AsyncStorage is not a
 *   dependency), and in-memory only would lose the choice on process death.
 * The settings never carry the account id, so logout (Task 20) cannot clear
 * them as long as it keeps using `deleteAccountData`.
 *
 * Changing the theme only swaps style context — navigation state, the current
 * screen and any input live elsewhere and are untouched (テーマ変更で画面と
 * 入力を失わない).
 */

export const THEME_SETTING_KEYS = {
  mode: 'theme.mode',
  schedule: 'theme.schedule',
} as const;

/** Minimal key/value persistence used by the theme provider. */
export interface ThemeSettingsStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

/** Store backed by an already-open storage handle (tests / reuse). */
export function createStorageThemeStore(storage: Storage): ThemeSettingsStore {
  return {
    read: (key) => readDeviceSetting(storage, key),
    write: async (key, value) => {
      await writeDeviceSetting(storage, key, value);
    },
  };
}

/**
 * Default device store: opens the app database lazily and degrades to
 * "settings not persisted" (read → null, write → no-op) when storage is
 * unavailable. The UI never claims persistence it does not have.
 */
export function createDeviceThemeStore(): ThemeSettingsStore {
  let handle: Promise<Storage> | null = null;
  const storage = (): Promise<Storage> => {
    if (handle === null) handle = openAppDatabase();
    return handle;
  };
  return {
    read: async (key) => {
      try {
        return await readDeviceSetting(await storage(), key);
      } catch {
        return null;
      }
    },
    write: async (key, value) => {
      try {
        await writeDeviceSetting(await storage(), key, value);
      } catch {
        // Degrade silently: the in-memory choice stays active for this run
        // and the next successful write persists it again.
      }
    },
  };
}

export interface ThemeContextValue {
  /** Selected mode; initial default = 端末に合わせる. */
  mode: ThemeMode;
  schedule: ThemeSchedule;
  /** Resolved scheme that is actually rendered. */
  scheme: ThemeScheme;
  tokens: ThemeTokens;
  /** True once the device settings were read (or the read failed). */
  ready: boolean;
  /** Applies and persists a mode. */
  setMode(mode: ThemeMode): Promise<void>;
  /**
   * Validates + persists a schedule. Returns `{ok:false}` without touching
   * state or storage when the times are equal or malformed (同時刻は保存不可).
   */
  saveSchedule(next: ThemeSchedule): Promise<ScheduleValidation>;
  /** Re-evaluates with a fresh `now` (resume / timezone change / manual). */
  refresh(): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error('useTheme must be used inside <ThemeProvider>.');
  }
  return value;
}

/** Minimal AppState contract so tests can drive 復帰再評価. */
export interface AppStateLike {
  addEventListener(type: 'change', handler: (state: string) => void): { remove(): void };
}

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Injected store (tests); defaults to the device SQLite store. */
  store?: ThemeSettingsStore;
  /** Overrides the OS dark-mode setting (tests); default `useColorScheme()`. */
  deviceScheme?: ThemeScheme | null;
  /** Injected clock (tests); defaults to `() => new Date()`. */
  clock?: () => Date;
  /** Injected app-state source (tests); defaults to the RN AppState. */
  appState?: AppStateLike;
}

function parseSchedule(raw: string | null): ThemeSchedule {
  if (raw === null) return DEFAULT_THEME_SCHEDULE;
  try {
    const parsed = JSON.parse(raw) as Partial<ThemeSchedule>;
    const next: ThemeSchedule = {
      lightStart: String(parsed.lightStart ?? ''),
      darkStart: String(parsed.darkStart ?? ''),
    };
    // Persisted-but-invalid data (older build, manual edit) falls back to the
    // defaults instead of producing an unsavable UI.
    return validateThemeSchedule(next).ok ? next : DEFAULT_THEME_SCHEDULE;
  } catch {
    return DEFAULT_THEME_SCHEDULE;
  }
}

export function ThemeProvider({
  children,
  store: injectedStore,
  deviceScheme: injectedScheme,
  clock = () => new Date(),
  appState = AppState,
}: ThemeProviderProps) {
  // RN's color scheme can be 'unspecified' (iOS) — anything but an explicit
  // 'dark' resolves to the light scheme.
  const systemScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const store = useMemo<ThemeSettingsStore>(
    () => injectedStore ?? createDeviceThemeStore(),
    [injectedStore],
  );

  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_THEME_MODE);
  const [schedule, setScheduleState] = useState<ThemeSchedule>(DEFAULT_THEME_SCHEDULE);
  const [ready, setReady] = useState(false);
  // Bumped when time-dependent resolution must run again: app resume and
  // schedule-boundary timers (時間帯の境界到来・復帰時に再評価).
  const [timeTick, setTimeTick] = useState(0);

  // Hydrate device-scoped settings once. Runs for the signed-out screens
  // too — the choice belongs to the device, not the account.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [rawMode, rawSchedule] = await Promise.all([
        store.read(THEME_SETTING_KEYS.mode),
        store.read(THEME_SETTING_KEYS.schedule),
      ]);
      if (!alive) return;
      if (rawMode !== null && (THEME_MODES as readonly string[]).includes(rawMode)) {
        setModeState(rawMode as ThemeMode);
      }
      setScheduleState(parseSchedule(rawSchedule));
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [store]);

  // 復帰時 (and タイムゾーン変更後 — the resolution below reads the CURRENT
  // local time, so a timezone shift is picked up by the same re-run): when the
  // app returns to the foreground, re-evaluate with a fresh `now`. A boundary
  // crossed while the app was closed is applied then.
  useEffect(() => {
    const subscription = appState.addEventListener('change', (state) => {
      if (state === 'active') setTimeTick((tick) => tick + 1);
    });
    return () => subscription.remove();
  }, [appState]);

  // Foreground boundary switch: while the schedule mode is active, wake up at
  // the next 07:00/19:00-style boundary and re-resolve.
  useEffect(() => {
    if (mode !== 'schedule') return;
    const at = nextBoundaryAfter(schedule, clock());
    const delay = Math.max(0, at.getTime() - clock().getTime());
    const id = setTimeout(() => setTimeTick((tick) => tick + 1), delay);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, schedule, timeTick]);

  const scheme = useMemo(
    () =>
      resolveTheme({
        mode,
        schedule,
        deviceScheme: injectedScheme !== undefined ? injectedScheme : systemScheme,
        now: clock(),
      }),
    // timeTick is the "now changed" signal (resume / boundary); clock() itself
    // is intentionally not a dependency because it is a fresh closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, schedule, injectedScheme, systemScheme, timeTick],
  );

  const setMode = useCallback(
    async (next: ThemeMode): Promise<void> => {
      setModeState(next);
      await store.write(THEME_SETTING_KEYS.mode, next);
    },
    [store],
  );

  const saveSchedule = useCallback(
    async (next: ThemeSchedule): Promise<ScheduleValidation> => {
      const validation = validateThemeSchedule(next);
      if (!validation.ok) return validation; // reject before any state/write
      setScheduleState(next);
      await store.write(THEME_SETTING_KEYS.schedule, JSON.stringify(next));
      return validation;
    },
    [store],
  );

  const refresh = useCallback(() => setTimeTick((tick) => tick + 1), []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      schedule,
      scheme,
      tokens: tokensFor(scheme),
      ready,
      setMode,
      saveSchedule,
      refresh,
    }),
    [mode, schedule, scheme, ready, setMode, saveSchedule, refresh],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
