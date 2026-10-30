import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';

import {
  readAppearancePreferences,
  updateAppearancePreferences,
  writeAppearancePreferences,
  type AppearanceCelebrationKind,
  type AppearancePreferences,
  type AppearancePreferencesPatch,
  type AppearanceResumeKind,
  type UpdateAppearancePreferencesOptions,
  type WriteAppearancePreferencesOptions,
} from '../storage/appearance';
import { openAppDatabase, type Storage } from '../storage/database';
import type { AppearanceVibrancy } from './catalog';
import {
  createReduceMotionController,
  nativeReduceMotionPort,
  type ReduceMotionAppState,
  type ReduceMotionPort,
} from './motion';

/**
 * Task 9: 派手さ・種類別停止 device preferences provider.
 *
 * This provider owns ONLY the persisted appearance setting and the live OS
 * reduce-motion flag. It is deliberately independent of ThemeProvider (light /
 * dark / schedule); the root layout composes ThemeProvider first and this
 * provider inside it. Decoration is applied later (Task 12) from the derived
 * values exposed here.
 *
 * Persistence is the device-scoped `device_settings` row written by Task 8
 * (`account_id IS NULL`). It survives logout/account removal, applies to every
 * account on the same device and is never sent to the server. The provider
 * itself has no account concept.
 *
 * Loading or an unreadable store leaves playback disabled: celebrations must
 * not start before the device setting is known. A failed save keeps the chosen
 * value active in memory (with `saveError` + `retrySave`) so the UI never
 * claims a persistence it does not have.
 */

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  vibrancy: 'flashy',
  chatEnabled: true,
  streakEnabled: true,
  chatResumeGeneration: 0,
  streakResumeGeneration: 0,
};

export type AppearancePreferencesStatus = 'loading' | 'ready' | 'unavailable';
export type AppearanceCelebrationMode = 'animated' | 'static' | 'none';

/** Persistence boundary; the device implementation below is the default. */
export interface AppearancePreferencesStore {
  read(): Promise<AppearancePreferences>;
  update(
    patch: AppearancePreferencesPatch,
    options?: UpdateAppearancePreferencesOptions,
  ): Promise<AppearancePreferences>;
  write(
    value: AppearancePreferences,
    options?: WriteAppearancePreferencesOptions,
  ): Promise<AppearancePreferences>;
}

/** Store backed by an already-open storage handle (tests / reuse). */
export function createStorageAppearancePreferencesStore(
  storage: Storage,
): AppearancePreferencesStore {
  return {
    read: () => readAppearancePreferences(storage),
    update: (patch, options = {}) => updateAppearancePreferences(storage, patch, options),
    write: (value, options = {}) => writeAppearancePreferences(storage, value, options),
  };
}

/**
 * Default device store. The database is opened lazily, exactly once per
 * provider lifetime. Open/read failures are NOT swallowed here: the provider
 * turns them into the explicit `unavailable` state so playback stays disabled.
 */
export function createDeviceAppearancePreferencesStore(): AppearancePreferencesStore {
  let handle: Promise<Storage> | null = null;
  const database = (): Promise<Storage> => {
    if (handle === null) {
      handle = openAppDatabase().catch((error: unknown) => {
        // Allow a later attempt to reopen instead of caching the rejection.
        handle = null;
        throw error;
      });
    }
    return handle;
  };
  return {
    read: async () => readAppearancePreferences(await database()),
    update: async (patch, options = {}) =>
      updateAppearancePreferences(await database(), patch, options),
    write: async (value, options = {}) =>
      writeAppearancePreferences(await database(), value, options),
  };
}

export interface AppearancePreferencesContextValue {
  preferences: AppearancePreferences;
  status: AppearancePreferencesStatus;
  /** True only when settings are known and at least one celebration may play. */
  playbackEnabled: boolean;
  saveError: string | null;
  reducedMotion: boolean;
  /** Flashy motion allowed by the device setting and the OS reduce-motion flag. */
  motionEnabled: boolean;
  celebrationMode(kind: AppearanceCelebrationKind): AppearanceCelebrationMode;
  setVibrancy(vibrancy: AppearanceVibrancy): Promise<void>;
  /**
   * Enables/disables one celebration kind. A false→true transition bumps that
   * kind's resume generation exactly once, inside the same atomic write.
   */
  setKindEnabled(kind: AppearanceCelebrationKind, enabled: boolean): Promise<void>;
  /** Rewrites the latest desired state after a failed save. */
  retrySave(): Promise<void>;
}

const AppearancePreferencesContext = createContext<AppearancePreferencesContextValue | null>(null);

export function useAppearancePreferences(): AppearancePreferencesContextValue {
  const value = useContext(AppearancePreferencesContext);
  if (value === null) {
    throw new Error('useAppearancePreferences must be used inside <AppearancePreferencesProvider>.');
  }
  return value;
}

export interface AppearancePreferencesProviderProps {
  children: React.ReactNode;
  /** Injected store (tests); defaults to the device SQLite store. */
  store?: AppearancePreferencesStore;
  /** Injected reduce-motion port (tests); defaults to AccessibilityInfo. */
  reduceMotionPort?: ReduceMotionPort;
  /** Injected app-state source (tests); defaults to the RN AppState. */
  appState?: ReduceMotionAppState;
}

function nextGeneration(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? value : value + 1;
}

function saveErrorMessage(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : '見た目設定を保存できませんでした。';
}

export function AppearancePreferencesProvider({
  children,
  store: injectedStore,
  reduceMotionPort,
  appState = AppState,
}: AppearancePreferencesProviderProps) {
  const store = useMemo<AppearancePreferencesStore>(
    () => injectedStore ?? createDeviceAppearancePreferencesStore(),
    [injectedStore],
  );
  const motionPort = reduceMotionPort ?? nativeReduceMotionPort;
  const controller = useMemo(
    () => createReduceMotionController(motionPort, { appState }),
    [motionPort, appState],
  );

  const [preferences, setPreferencesState] = useState<AppearancePreferences>(
    DEFAULT_APPEARANCE_PREFERENCES,
  );
  const [status, setStatus] = useState<AppearancePreferencesStatus>('loading');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  const preferencesRef = useRef(preferences);
  const mountedRef = useRef(true);
  // Incremented by every user change; a hydration response that started
  // before the newest change is stale and must not overwrite it.
  const userVersionRef = useRef(0);
  const needsSaveRef = useRef(false);
  const saveLoopRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Hydrate the device-scoped setting once per store. The theme choice is
  // independent and is never read or written here.
  useEffect(() => {
    let alive = true;
    const version = userVersionRef.current;
    void (async () => {
      try {
        const loaded = await store.read();
        if (!alive) return;
        if (userVersionRef.current === version) {
          preferencesRef.current = loaded;
          setPreferencesState(loaded);
        }
        setStatus('ready');
      } catch {
        if (!alive) return;
        setStatus('unavailable');
      }
    })();
    return () => {
      alive = false;
    };
  }, [store]);

  // OS reduce-motion: read at start, follow changes, re-read on foreground.
  useEffect(() => {
    const unsubscribe = controller.subscribe(setReducedMotion);
    controller.start();
    setReducedMotion(controller.get());
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [controller]);

  /**
   * Serialized save queue. Each iteration writes the CURRENT desired state in
   * one transaction, so the latest setting wins and generation bumps are never
   * replayed twice. A failure keeps the in-memory state, reports `saveError`
   * and waits for `retrySave` (or the next user change).
   */
  const runSave = useCallback((): Promise<void> => {
    needsSaveRef.current = true;
    if (saveLoopRef.current !== null) return saveLoopRef.current;

    const loop = (async () => {
      try {
        while (needsSaveRef.current) {
          needsSaveRef.current = false;
          const desired = preferencesRef.current;
          try {
            await store.write(desired);
          } catch (error) {
            if (mountedRef.current) setSaveError(saveErrorMessage(error));
            // A newer change arrived while this write was in flight: give the
            // latest state its own attempt. Otherwise wait for retrySave.
            if (!needsSaveRef.current) return;
            continue;
          }
          if (mountedRef.current) setSaveError(null);
        }
      } finally {
        saveLoopRef.current = null;
      }
    })();

    saveLoopRef.current = loop;
    return loop;
  }, [store]);

  const commit = useCallback(
    (next: AppearancePreferences): Promise<void> => {
      userVersionRef.current += 1;
      preferencesRef.current = next;
      setPreferencesState(next);
      return runSave();
    },
    [runSave],
  );

  const setVibrancy = useCallback(
    (vibrancy: AppearanceVibrancy): Promise<void> => {
      const current = preferencesRef.current;
      if (current.vibrancy === vibrancy) return Promise.resolve();
      return commit({ ...current, vibrancy });
    },
    [commit],
  );

  const setKindEnabled = useCallback(
    (kind: AppearanceCelebrationKind, enabled: boolean): Promise<void> => {
      const current = preferencesRef.current;
      if (kind === 'chat') {
        if (current.chatEnabled === enabled) return Promise.resolve();
        const next: AppearancePreferences = { ...current, chatEnabled: enabled };
        if (enabled) next.chatResumeGeneration = nextGeneration(next.chatResumeGeneration);
        return commit(next);
      }
      if (current.streakEnabled === enabled) return Promise.resolve();
      const next: AppearancePreferences = { ...current, streakEnabled: enabled };
      if (enabled) next.streakResumeGeneration = nextGeneration(next.streakResumeGeneration);
      return commit(next);
    },
    [commit],
  );

  const retrySave = useCallback((): Promise<void> => runSave(), [runSave]);

  const value = useMemo<AppearancePreferencesContextValue>(() => {
    const playbackEnabled =
      status === 'ready' &&
      preferences.vibrancy === 'flashy' &&
      (preferences.chatEnabled || preferences.streakEnabled);

    const celebrationMode = (kind: AppearanceCelebrationKind): AppearanceCelebrationMode => {
      if (status !== 'ready' || preferences.vibrancy !== 'flashy') return 'none';
      const enabled = kind === 'chat' ? preferences.chatEnabled : preferences.streakEnabled;
      if (!enabled) return 'none';
      return reducedMotion ? 'static' : 'animated';
    };

    return {
      preferences,
      status,
      playbackEnabled,
      saveError,
      reducedMotion,
      // Never animate before the device setting is known. Loading/unavailable
      // must behave like a stopped surface, not the default flashy value.
      motionEnabled: status === 'ready' && preferences.vibrancy === 'flashy' && !reducedMotion,
      celebrationMode,
      setVibrancy,
      setKindEnabled,
      retrySave,
    };
  }, [
    preferences,
    status,
    saveError,
    reducedMotion,
    setVibrancy,
    setKindEnabled,
    retrySave,
  ]);

  return (
    <AppearancePreferencesContext.Provider value={value}>
      {children}
    </AppearancePreferencesContext.Provider>
  );
}
