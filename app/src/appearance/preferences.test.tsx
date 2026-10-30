import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Text } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';

import { calculateAppearance } from './calculate';
import {
  AppearancePreferencesProvider,
  DEFAULT_APPEARANCE_PREFERENCES,
  createStorageAppearancePreferencesStore,
  useAppearancePreferences,
  type AppearancePreferencesContextValue,
  type AppearancePreferencesStore,
} from './preferences';
import type { ReduceMotionAppState, ReduceMotionPort } from './motion';
import { deleteAccountData, openAppDatabase, type AppStorage } from '../storage/database';
import { readAppearancePreferences, type AppearancePreferences } from '../storage/appearance';
import { NodeSqliteDriver } from '../storage/testSupport/nodePorts';
import { tokensFor } from '../theme/tokens';

/**
 * Task 9: 派手さ・種類別停止 device preferences and their provider.
 *
 * Persistence/device-scope assertions run against the real SQLite schema and
 * the real `device_settings` SQL; provider failure/race assertions inject a
 * small in-memory store so timing is deterministic.
 */

interface Harness {
  root: string;
  dbPath: string;
  open(): Promise<AppStorage>;
  cleanup(): Promise<void>;
}

function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-preferences-'));
  const dbPath = path.join(root, 'app.db');
  const handles: AppStorage[] = [];
  return {
    root,
    dbPath,
    async open() {
      const db = await openAppDatabase({ driver: new NodeSqliteDriver(dbPath) });
      handles.push(db);
      return db;
    },
    async cleanup() {
      for (const db of handles) {
        try {
          await db.close();
        } catch {
          // Already closed by a test.
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface ProbeHolder {
  current: AppearancePreferencesContextValue | null;
}

interface ProbeSnapshot {
  vibrancy: string;
  chatEnabled: boolean;
  streakEnabled: boolean;
  chatResumeGeneration: number;
  streakResumeGeneration: number;
  status: string;
  playbackEnabled: boolean;
  motionEnabled: boolean;
  reducedMotion: boolean;
  chatMode: string;
  streakMode: string;
}

function createProbe(): { holder: ProbeHolder; Probe: () => React.ReactElement } {
  const holder: ProbeHolder = { current: null };
  function Probe() {
    const value = useAppearancePreferences();
    holder.current = value;
    const snapshot: ProbeSnapshot = {
      vibrancy: value.preferences.vibrancy,
      chatEnabled: value.preferences.chatEnabled,
      streakEnabled: value.preferences.streakEnabled,
      chatResumeGeneration: value.preferences.chatResumeGeneration,
      streakResumeGeneration: value.preferences.streakResumeGeneration,
      status: value.status,
      playbackEnabled: value.playbackEnabled,
      motionEnabled: value.motionEnabled,
      reducedMotion: value.reducedMotion,
      chatMode: value.celebrationMode('chat'),
      streakMode: value.celebrationMode('streak'),
    };
    return <Text testID="appearance-probe">{JSON.stringify(snapshot)}</Text>;
  }
  return { holder, Probe };
}

function probeSnapshot(): ProbeSnapshot {
  return JSON.parse(screen.getByTestId('appearance-probe').props.children as string) as ProbeSnapshot;
}

function fakeMotionPort(initial = false): {
  port: ReduceMotionPort;
  emit(value: boolean): void;
} {
  let value = initial;
  const listeners = new Set<(next: boolean) => void>();
  return {
    port: {
      read: async () => value,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(next) {
      value = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

function fakeAppState(): {
  appState: ReduceMotionAppState;
  emitActive(): void;
} {
  const listeners = new Set<(state: string) => void>();
  return {
    appState: {
      addEventListener: (_type, handler) => {
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

function applyPatch(
  current: AppearancePreferences,
  patch: Parameters<AppearancePreferencesStore['update']>[0],
  bumpResume: readonly ('chat' | 'streak')[] = [],
): AppearancePreferences {
  const next: AppearancePreferences = { ...current };
  if (patch.vibrancy !== undefined) next.vibrancy = patch.vibrancy;
  if (patch.chatEnabled !== undefined) next.chatEnabled = patch.chatEnabled;
  if (patch.streakEnabled !== undefined) next.streakEnabled = patch.streakEnabled;
  for (const kind of bumpResume) {
    if (kind === 'chat') next.chatResumeGeneration += 1;
    else next.streakResumeGeneration += 1;
  }
  return next;
}

interface MemoryStore {
  store: AppearancePreferencesStore;
  writeAttempts: AppearancePreferences[];
  writeSuccesses: AppearancePreferences[];
  current(): AppearancePreferences;
}

function memoryStore(
  initial: Partial<AppearancePreferences> = {},
  options: { failReads?: number; failWrites?: number } = {},
): MemoryStore {
  let value: AppearancePreferences = { ...DEFAULT_APPEARANCE_PREFERENCES, ...initial };
  let failReads = options.failReads ?? 0;
  let failWrites = options.failWrites ?? 0;
  const writeAttempts: AppearancePreferences[] = [];
  const writeSuccesses: AppearancePreferences[] = [];
  return {
    store: {
      read: async () => {
        if (failReads > 0) {
          failReads -= 1;
          throw new Error('read failed');
        }
        return { ...value };
      },
      update: async (patch, updateOptions = {}) => {
        value = applyPatch(value, patch, updateOptions.bumpResume);
        writeSuccesses.push({ ...value });
        return { ...value };
      },
      write: async (next) => {
        writeAttempts.push({ ...next });
        if (failWrites > 0) {
          failWrites -= 1;
          throw new Error('write failed');
        }
        value = { ...next };
        writeSuccesses.push({ ...value });
        return { ...value };
      },
    },
    writeAttempts,
    writeSuccesses,
    current: () => ({ ...value }),
  };
}

interface DeferredStore {
  store: AppearancePreferencesStore;
  resolveRead(value: AppearancePreferences): void;
  rejectRead(error: Error): void;
  writeCalls: AppearancePreferences[];
  current(): AppearancePreferences;
}

function deferredStore(initial: Partial<AppearancePreferences> = {}): DeferredStore {
  let value: AppearancePreferences = { ...DEFAULT_APPEARANCE_PREFERENCES, ...initial };
  let resolveRead!: (next: AppearancePreferences) => void;
  let rejectRead!: (error: Error) => void;
  const readPromise = new Promise<AppearancePreferences>((resolve, reject) => {
    resolveRead = resolve;
    rejectRead = reject;
  });
  const writeCalls: AppearancePreferences[] = [];
  return {
    store: {
      read: () => readPromise,
      update: async (patch, updateOptions = {}) => {
        value = applyPatch(value, patch, updateOptions.bumpResume);
        return { ...value };
      },
      write: async (next) => {
        value = { ...next };
        writeCalls.push({ ...value });
        return { ...value };
      },
    },
    resolveRead: (next) => resolveRead(next),
    rejectRead: (error) => rejectRead(error),
    writeCalls,
    current: () => ({ ...value }),
  };
}

async function renderProvider(input: {
  store: AppearancePreferencesStore;
  port?: ReduceMotionPort;
  appState?: ReduceMotionAppState;
}): Promise<{ holder: ProbeHolder }> {
  const { holder, Probe } = createProbe();
  await render(
    <AppearancePreferencesProvider
      store={input.store}
      reduceMotionPort={input.port}
      appState={input.appState}
    >
      <Probe />
    </AppearancePreferencesProvider>,
  );
  return { holder };
}

async function waitForStatus(holder: ProbeHolder, status: string): Promise<void> {
  await waitFor(() => expect(holder.current?.status).toBe(status));
}

// ---------------------------------------------------------------------------
// Defaults, persistence, device scope, resume generations
// ---------------------------------------------------------------------------

describe('device-scoped appearance preferences', () => {
  it('defaults to flashy with both celebrations enabled and starts playback once known', async () => {
    const db = await harness.open();
    const { port } = fakeMotionPort(false);
    const { holder } = await renderProvider({
      store: createStorageAppearancePreferencesStore(db),
      port,
    });
    await waitForStatus(holder, 'ready');

    expect(holder.current?.preferences).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    expect(DEFAULT_APPEARANCE_PREFERENCES).toMatchObject({
      vibrancy: 'flashy',
      chatEnabled: true,
      streakEnabled: true,
      chatResumeGeneration: 0,
      streakResumeGeneration: 0,
    });
    expect(probeSnapshot()).toMatchObject({
      status: 'ready',
      playbackEnabled: true,
      motionEnabled: true,
      chatMode: 'animated',
      streakMode: 'animated',
    });
    // The default is a code default, not a written row.
    expect(await db.getFirstAsync('SELECT 1 AS present FROM device_settings')).toBeNull();
  });

  it('survives a provider restart and is shared by every account on the device', async () => {
    const db = await harness.open();
    const store = createStorageAppearancePreferencesStore(db);
    const first = await renderProvider({ store, port: fakeMotionPort(false).port });
    await waitForStatus(first.holder, 'ready');

    await act(async () => {
      await first.holder.current?.setVibrancy('subtle');
      await first.holder.current?.setKindEnabled('chat', false);
    });
    expect(await readAppearancePreferences(db)).toMatchObject({
      vibrancy: 'subtle',
      chatEnabled: false,
      streakEnabled: true,
    });

    // Logout / account removal (Task 20 uses the same function) must not touch
    // the device-scoped row. The provider itself has no account concept.
    await deleteAccountData(db, 'account-a');

    const restarted = await renderProvider({ store, port: fakeMotionPort(false).port });
    await waitForStatus(restarted.holder, 'ready');
    expect(restarted.holder.current?.preferences).toMatchObject({
      vibrancy: 'subtle',
      chatEnabled: false,
      chatResumeGeneration: 0,
      streakResumeGeneration: 0,
    });
    expect(probeSnapshot()).toMatchObject({
      playbackEnabled: false,
      motionEnabled: false,
      chatMode: 'none',
      streakMode: 'none',
    });
  });

  it('bumps only the re-enabled kind once, and never on restart or foreground', async () => {
    const db = await harness.open();
    const store = createStorageAppearancePreferencesStore(db);
    const { appState, emitActive } = fakeAppState();
    const first = await renderProvider({
      store,
      port: fakeMotionPort(false).port,
      appState,
    });
    await waitForStatus(first.holder, 'ready');

    // Enabling an already-enabled kind is not a transition.
    await act(async () => {
      await first.holder.current?.setKindEnabled('chat', true);
    });
    expect(first.holder.current?.preferences.chatResumeGeneration).toBe(0);

    await act(async () => {
      await first.holder.current?.setKindEnabled('chat', false);
    });
    expect(first.holder.current?.preferences.chatResumeGeneration).toBe(0);

    await act(async () => {
      await first.holder.current?.setKindEnabled('chat', true);
    });
    expect(first.holder.current?.preferences).toMatchObject({
      chatEnabled: true,
      chatResumeGeneration: 1,
      streakResumeGeneration: 0,
    });

    await act(async () => {
      await first.holder.current?.setKindEnabled('streak', true);
    });
    expect(first.holder.current?.preferences.streakResumeGeneration).toBe(0);
    await act(async () => {
      await first.holder.current?.setKindEnabled('streak', false);
      await first.holder.current?.setKindEnabled('streak', true);
    });
    expect(first.holder.current?.preferences).toMatchObject({
      chatResumeGeneration: 1,
      streakResumeGeneration: 1,
    });

    // Restart: the persisted generations are read back unchanged.
    const restarted = await renderProvider({
      store,
      port: fakeMotionPort(false).port,
      appState,
    });
    await waitForStatus(restarted.holder, 'ready');
    expect(restarted.holder.current?.preferences).toMatchObject({
      chatResumeGeneration: 1,
      streakResumeGeneration: 1,
    });

    // A normal foreground return is not a re-enable either.
    await act(async () => {
      emitActive();
    });
    expect(restarted.holder.current?.preferences).toMatchObject({
      chatResumeGeneration: 1,
      streakResumeGeneration: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Loading, unavailable and failed saves
// ---------------------------------------------------------------------------

describe('loading, unavailable and save failures', () => {
  it('never enables playback while loading or unavailable', async () => {
    const deferred = deferredStore();
    const { holder } = await renderProvider({
      store: deferred.store,
      port: fakeMotionPort(false).port,
    });

    expect(holder.current?.status).toBe('loading');
    expect(holder.current?.playbackEnabled).toBe(false);
    expect(holder.current?.celebrationMode('chat')).toBe('none');
    expect(holder.current?.celebrationMode('streak')).toBe('none');

    await act(async () => {
      deferred.rejectRead(new Error('storage unavailable'));
    });
    await waitForStatus(holder, 'unavailable');
    expect(holder.current?.playbackEnabled).toBe(false);
    expect(holder.current?.celebrationMode('chat')).toBe('none');
  });

  it('applies a failed save in memory, shows the error and retries the latest state once', async () => {
    const memory = memoryStore({}, { failWrites: 2 });
    const { holder } = await renderProvider({
      store: memory.store,
      port: fakeMotionPort(false).port,
    });
    await waitForStatus(holder, 'ready');

    await act(async () => {
      await holder.current?.setVibrancy('subtle');
    });
    // The change is active immediately even though persistence failed.
    expect(holder.current?.preferences.vibrancy).toBe('subtle');
    expect(holder.current?.saveError).not.toBeNull();
    expect(holder.current?.playbackEnabled).toBe(false);
    expect(memory.writeAttempts).toHaveLength(1);

    await act(async () => {
      await holder.current?.setKindEnabled('chat', false);
    });
    expect(holder.current?.preferences.chatEnabled).toBe(false);
    expect(memory.writeAttempts).toHaveLength(2);

    await act(async () => {
      await holder.current?.retrySave();
    });

    expect(holder.current?.saveError).toBeNull();
    // The retry writes the latest desired state exactly once.
    expect(memory.writeAttempts).toHaveLength(3);
    expect(memory.writeAttempts[2]).toEqual({
      vibrancy: 'subtle',
      chatEnabled: false,
      streakEnabled: true,
      chatResumeGeneration: 0,
      streakResumeGeneration: 0,
    });
    expect(memory.current()).toEqual(memory.writeAttempts[2]);
  });

  it('keeps playback enabled from the in-memory setting after a failed save', async () => {
    const memory = memoryStore({}, { failWrites: 1 });
    const { holder } = await renderProvider({
      store: memory.store,
      port: fakeMotionPort(false).port,
    });
    await waitForStatus(holder, 'ready');
    expect(holder.current?.playbackEnabled).toBe(true);

    await act(async () => {
      await holder.current?.setKindEnabled('chat', false);
    });

    expect(holder.current?.saveError).not.toBeNull();
    // The disabled kind stops, but the still-enabled streak celebration and
    // the flashy setting remain active for this run even though saving failed.
    expect(probeSnapshot()).toMatchObject({
      playbackEnabled: true,
      chatMode: 'none',
      streakMode: 'animated',
    });
  });

  it('does not double-bump resume generations when a failed re-enable is retried', async () => {
    const memory = memoryStore({}, { failWrites: 2 });
    const { holder } = await renderProvider({
      store: memory.store,
      port: fakeMotionPort(false).port,
    });
    await waitForStatus(holder, 'ready');

    await act(async () => {
      await holder.current?.setKindEnabled('chat', false);
    });
    await act(async () => {
      await holder.current?.setKindEnabled('chat', true);
    });
    expect(holder.current?.preferences.chatResumeGeneration).toBe(1);

    await act(async () => {
      await holder.current?.retrySave();
    });
    expect(memory.current().chatResumeGeneration).toBe(1);
    expect(holder.current?.preferences.chatResumeGeneration).toBe(1);

    // Retrying again writes the same value and still does not bump.
    await act(async () => {
      await holder.current?.retrySave();
    });
    expect(memory.current().chatResumeGeneration).toBe(1);
  });

  it('ignores a stale hydration response after a user change during loading', async () => {
    const deferred = deferredStore({
      vibrancy: 'subtle',
      chatEnabled: true,
      streakEnabled: true,
    });
    const { holder } = await renderProvider({
      store: deferred.store,
      port: fakeMotionPort(false).port,
    });
    expect(holder.current?.status).toBe('loading');

    await act(async () => {
      await holder.current?.setKindEnabled('chat', false);
    });
    expect(holder.current?.preferences.chatEnabled).toBe(false);

    // The old read lands late with the pre-change value.
    await act(async () => {
      deferred.resolveRead({
        vibrancy: 'subtle',
        chatEnabled: true,
        streakEnabled: true,
        chatResumeGeneration: 0,
        streakResumeGeneration: 0,
      });
    });
    await waitForStatus(holder, 'ready');
    expect(holder.current?.preferences.chatEnabled).toBe(false);
    expect(deferred.current().chatEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Derived presentation values
// ---------------------------------------------------------------------------

describe('derived appearance behaviour', () => {
  it('stops motion and both celebrations for subtle while keeping colour', async () => {
    const memory = memoryStore();
    const { holder } = await renderProvider({
      store: memory.store,
      port: fakeMotionPort(false).port,
    });
    await waitForStatus(holder, 'ready');

    await act(async () => {
      await holder.current?.setVibrancy('subtle');
    });

    const snapshot = probeSnapshot();
    expect(snapshot).toMatchObject({
      motionEnabled: false,
      chatMode: 'none',
      streakMode: 'none',
    });

    for (const scheme of ['light', 'dark'] as const) {
      const visual = calculateAppearance({
        subject: 'chat',
        days: 100,
        presetId: 'b-pop',
        scheme,
        vibrancy: holder.current!.preferences.vibrancy,
      });
      expect(visual.monochrome).toBe(false);
      expect(visual.decoration.motion).toBe(0);
      expect(visual.decoration.animatedLayers).toBe(0);
      expect(visual.background).not.toBe(tokensFor(scheme).surface);
    }
  });

  it('turns off into a scheme-appropriate monochrome visual for light and dark', async () => {
    const memory = memoryStore();
    const { holder } = await renderProvider({
      store: memory.store,
      port: fakeMotionPort(false).port,
    });
    await waitForStatus(holder, 'ready');

    await act(async () => {
      await holder.current?.setVibrancy('off');
    });
    expect(probeSnapshot()).toMatchObject({
      motionEnabled: false,
      chatMode: 'none',
      streakMode: 'none',
    });

    for (const scheme of ['light', 'dark'] as const) {
      const visual = calculateAppearance({
        subject: 'streak',
        days: 100,
        presetId: 'b-soda',
        scheme,
        vibrancy: holder.current!.preferences.vibrancy,
      });
      expect(visual.monochrome).toBe(true);
      expect(visual.background).toBe(tokensFor(scheme).surface);
      expect(visual.decoration).toMatchObject({
        patternId: null,
        staticStickers: [],
        animatedLayers: 0,
        motion: 0,
      });
    }
  });

  it('replaces flashy celebrations with a static display under OS reduce-motion, never restoring subtle/off', async () => {
    const memory = memoryStore();
    const { port, emit } = fakeMotionPort(false);
    const { holder } = await renderProvider({ store: memory.store, port });
    await waitForStatus(holder, 'ready');
    expect(probeSnapshot()).toMatchObject({
      reducedMotion: false,
      motionEnabled: true,
      chatMode: 'animated',
      streakMode: 'animated',
    });

    await act(async () => {
      emit(true);
    });
    await waitFor(() => expect(holder.current?.reducedMotion).toBe(true));
    expect(probeSnapshot()).toMatchObject({
      motionEnabled: false,
      playbackEnabled: true,
      chatMode: 'static',
      streakMode: 'static',
    });

    await act(async () => {
      await holder.current?.setVibrancy('subtle');
    });
    expect(probeSnapshot()).toMatchObject({
      reducedMotion: true,
      motionEnabled: false,
      chatMode: 'none',
      streakMode: 'none',
    });

    await act(async () => {
      await holder.current?.setVibrancy('off');
    });
    expect(probeSnapshot()).toMatchObject({
      reducedMotion: true,
      motionEnabled: false,
      chatMode: 'none',
      streakMode: 'none',
    });
  });
});
