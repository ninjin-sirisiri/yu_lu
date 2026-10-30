import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../auth/provider';
import type { Storage } from '../storage/database';
import {
  baselineCelebration,
  consumeCelebrationBatch,
  readCelebration,
} from '../storage/appearance';
import { useChat } from '../messages/provider';
import { useTheme } from '../theme/provider';
import { spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import {
  createCelebrationCoordinator,
  type CelebrationClock,
  type CelebrationCoordinator,
  type CelebrationKind,
  type CelebrationLedgerRow,
  type CelebrationMode,
  type CelebrationPersistence,
  type CelebrationSettings,
  type CelebrationSnapshot,
} from './celebrations';
import type { AppearanceObservation } from './observations';
import { useAppearancePreferences } from './preferences';
import { ProtectedSurface } from './ProtectedSurface';
import {
  useCelebrationRouteKey,
  useCelebrationVisibility,
  useCelebrationVisibilityPort,
} from './visibility';

/**
 * Task 14: the single non-modal 演出 host.
 *
 * Mounted exactly once by the root layout (inside VisibilityProvider and
 * AppearanceProvider). It owns one coordinator per authenticated chat
 * lifetime/account, adapts the real SQLite ledger/device settings/visibility
 * ports, and renders only a small opaque card. The overlay root is
 * `pointerEvents="box-none"`: the composer, send button, scroll views and the
 * existing dialogs keep every touch. No Modal, sound, vibration or flashing is
 * added.
 */

const IDLE: CelebrationSnapshot = {
  status: 'idle',
  current: null,
  batch: [],
  error: null,
  choice: null,
};

const HostPresenceContext = createContext(false);

export interface CelebrationHostProps {
  children?: React.ReactNode;
  /** Test injection; production must not pass this. */
  coordinator?: CelebrationCoordinator;
  /** Test injection for the ~2s item timer; production uses the system clock. */
  clock?: CelebrationClock;
}

function persistenceFor(storage: Storage, accountId: string): CelebrationPersistence {
  const toRow = (row: { baselineDays: number; consumedMilestone: CelebrationLedgerRow['consumedMilestone'] }): CelebrationLedgerRow => ({
    baselineDays: row.baselineDays,
    consumedMilestone: row.consumedMilestone,
  });

  return {
    async read(kind, subjectId) {
      const row = await readCelebration(storage, { accountId, kind, subjectId });
      return row === null ? null : toRow(row);
    },
    async baseline(input) {
      const row = await baselineCelebration(storage, {
        accountId,
        kind: input.kind,
        subjectId: input.subjectId,
        days: input.days,
        lifetime: input.lifetime,
      });
      return toRow(row);
    },
    async consume(records, lifetime) {
      const rows = await consumeCelebrationBatch(storage, {
        accountId,
        records,
        lifetime,
      });
      return rows.map(toRow);
    },
  };
}

function CelebrationVisual({
  snapshot,
  onSkip,
  onChoose,
}: {
  snapshot: CelebrationSnapshot;
  onSkip(): void;
  onChoose(choice: 'once' | 'stop'): void;
}) {
  const { tokens } = useTheme();
  const item = snapshot.current;
  const choice = snapshot.choice;

  if (snapshot.status === 'choice' && choice !== null) {
    return (
      <ProtectedSurface testID="celebration-choice" style={styles.card}>
        <Text allowFontScaling style={[styles.title, { color: tokens.text }]}>
          演出をスキップしますか？
        </Text>
        <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>
          {choice.kind === 'chat' ? '会話の節目' : '継続の節目'}は今回だけ飛ばせます。
          今後の同種類を止めても、別の種類は表示されます。
        </Text>
        <View style={styles.actions}>
          <Button
            label="今回だけスキップ"
            testID="celebration-choice-once"
            onPress={() => onChoose('once')}
            style={styles.action}
          />
          <Button
            label="今後の同種類を停止"
            variant="secondary"
            testID="celebration-choice-stop"
            onPress={() => onChoose('stop')}
            style={styles.action}
          />
        </View>
      </ProtectedSurface>
    );
  }

  if (snapshot.status !== 'playing' || item === null) return null;

  const animated = item.mode === 'animated';
  const kindLabel = item.kind === 'chat' ? '会話の節目' : '継続の節目';
  const daysLabel = item.kind === 'chat' ? `累計${item.days}日` : `現在${item.days}日`;

  return (
    <View
      testID={animated ? 'celebration-animated' : 'celebration-static'}
      pointerEvents="auto"
    >
      <ProtectedSurface testID="celebration-card" style={styles.card}>
        <Text allowFontScaling style={[styles.title, { color: tokens.text }]} testID="celebration-kind">
          {kindLabel}
        </Text>
        <Text allowFontScaling style={[styles.body, { color: tokens.text }]} testID="celebration-milestone">
          {`${item.milestone}日`}
        </Text>
        <Text allowFontScaling style={[styles.body, { color: tokens.muted }]} testID="celebration-days">
          {daysLabel}
        </Text>
        <View style={styles.actions}>
          <Button label="スキップ" variant="ghost" testID="celebration-skip" onPress={onSkip} />
        </View>
      </ProtectedSurface>
    </View>
  );
}

function HostInner({ children, coordinator: injected, clock }: CelebrationHostProps) {
  const auth = useAuth();
  const chat = useChat();
  const preferences = useAppearancePreferences();
  const visibility = useCelebrationVisibility();
  const routeKey = useCelebrationRouteKey();
  const { tokens } = useTheme();

  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  const settings = useMemo<CelebrationSettings>(() => ({
    ready: () => preferencesRef.current.status === 'ready',
    mode: (kind: CelebrationKind): CelebrationMode =>
      preferencesRef.current.celebrationMode(kind),
    enabled: (kind: CelebrationKind): boolean => {
      const values = preferencesRef.current.preferences;
      return kind === 'chat' ? values.chatEnabled : values.streakEnabled;
    },
    resumeGeneration: (kind: CelebrationKind): number => {
      const values = preferencesRef.current.preferences;
      return kind === 'chat' ? values.chatResumeGeneration : values.streakResumeGeneration;
    },
    stopKind: (kind: CelebrationKind) =>
      preferencesRef.current.setKindEnabled(kind, false),
  }), []);

  const getVisibility = useCelebrationVisibilityPort();

  const accountId = auth.accountId;
  const storage = auth.storage;
  const session = chat?.session ?? null;
  const chatStopped = chat?.stopped ?? false;

  const persistence = useMemo(
    () => (storage && accountId ? persistenceFor(storage, accountId) : null),
    [storage, accountId],
  );

  const owned = useMemo<CelebrationCoordinator | null>(() => {
    if (injected) return null;
    if (!session || chatStopped || !persistence) return null;
    if (auth.status !== 'ready' || auth.registration !== 'registered') return null;
    return createCelebrationCoordinator({
      persistence,
      settings,
      visibility: getVisibility,
      clock,
    });
  }, [
    injected,
    chatStopped,
    persistence,
    session,
    auth.status,
    auth.registration,
    settings,
    getVisibility,
    clock,
  ]);

  const coordinator = injected ?? owned;

  useEffect(() => {
    if (!owned) return;
    return () => {
      owned.stop();
    };
  }, [owned]);

  const [snapshot, setSnapshot] = useState<CelebrationSnapshot>(
    () => coordinator?.getSnapshot() ?? IDLE,
  );

  useEffect(() => {
    if (!coordinator) {
      setSnapshot(IDLE);
      return;
    }
    setSnapshot(coordinator.getSnapshot());
    return coordinator.subscribe(setSnapshot);
  }, [coordinator]);

  // A canonical observation change (accept/clear) must re-run sync even when
  // the chat state object happened not to change in the same publication.
  const observations = chat?.appearanceObservations ?? null;
  const [observationVersion, setObservationVersion] = useState(0);
  useEffect(() => {
    if (!observations) return;
    return observations.subscribe(() => setObservationVersion(value => value + 1));
  }, [observations]);

  const home: AppearanceObservation | null = observations?.latest('home') ?? null;
  const peerId = visibility.activePeerId;
  const conversation: AppearanceObservation | null =
    peerId && observations
      ? observations.latest(`conversation:${peerId}`)
      : null;

  const lifetime = useCallback(
    () => (session ? session.active() : Promise.resolve(false)),
    [session],
  );

  const lastContext = useRef<{
    routeKey: string | null;
    peerId: string | null;
    visible: boolean;
    foreground: boolean;
    authCurrent: boolean;
    importantConfirmation: boolean;
  } | null>(null);
  const leftByHost = useRef(false);

  const values = preferences.preferences;
  const modeKey = `${values.vibrancy}:${values.chatEnabled ? 1 : 0}:${values.streakEnabled ? 1 : 0}:${values.chatResumeGeneration}:${values.streakResumeGeneration}:${preferences.reducedMotion ? 1 : 0}`;

  useEffect(() => {
    if (!coordinator) {
      lastContext.current = null;
      return;
    }

    const context = {
      routeKey,
      peerId,
      visible: visibility.visible,
      foreground: visibility.foreground,
      authCurrent: visibility.authCurrent,
      importantConfirmation: visibility.importantConfirmation,
    };
    const previous = lastContext.current;
    if (previous !== null && (
      previous.routeKey !== context.routeKey ||
      previous.peerId !== context.peerId ||
      previous.visible !== context.visible ||
      previous.foreground !== context.foreground ||
      previous.authCurrent !== context.authCurrent ||
      previous.importantConfirmation !== context.importantConfirmation
    )) {
      // Pathname/peer/background/logout/confirmation changes end the current
      // item and every remaining item. A discarded batch is already consumed
      // by the coordinator's single save and is never re-shown.
      leftByHost.current = true;
      coordinator.leave();
    }
    lastContext.current = context;

    if (
      visibility.visible &&
      visibility.foreground &&
      visibility.authCurrent &&
      !visibility.importantConfirmation &&
      preferences.status === 'ready'
    ) {
      void coordinator.sync({
        home,
        conversation,
        activePeerId: peerId,
        lifetime,
      });
    }
    // modeKey deliberately covers every device setting that can change the
    // presentation or resume generation while a batch is playing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    coordinator,
    routeKey,
    peerId,
    visibility.visible,
    visibility.foreground,
    visibility.authCurrent,
    visibility.importantConfirmation,
    preferences.status,
    modeKey,
    home,
    conversation,
    lifetime,
    observationVersion,
  ]);

  useEffect(() => {
    if (snapshot.status !== 'ended') leftByHost.current = false;
  }, [snapshot.status]);

  // Playing ended naturally (the coordinator owns the ~2s timer). Re-evaluate
  // exactly once from the latest canonical values; further progress waits for
  // the next observation/sync, so this never becomes an unbounded queue.
  useEffect(() => {
    if (!coordinator || snapshot.status !== 'ended') return;
    if (leftByHost.current) {
      leftByHost.current = false;
      return;
    }
    if (
      !visibility.visible ||
      !visibility.foreground ||
      !visibility.authCurrent ||
      visibility.importantConfirmation
    ) {
      return;
    }
    void coordinator.sync({
      home,
      conversation,
      activePeerId: peerId,
      lifetime,
    });
  }, [
    coordinator,
    snapshot.status,
    visibility.visible,
    visibility.foreground,
    visibility.authCurrent,
    visibility.importantConfirmation,
    home,
    conversation,
    peerId,
    lifetime,
  ]);

  const showCard =
    (snapshot.status === 'playing' && snapshot.current !== null) ||
    (snapshot.status === 'choice' && snapshot.choice !== null);
  const canPresent =
    showCard &&
    visibility.visible &&
    visibility.foreground &&
    visibility.authCurrent &&
    !visibility.importantConfirmation;
  const hasNotice =
    visibility.visible &&
    visibility.authCurrent &&
    (snapshot.error !== null || preferences.saveError !== null);

  if (!canPresent && !hasNotice) return <>{children}</>;

  return (
    <>
      <View
        testID="celebration-overlay"
        pointerEvents="box-none"
        style={styles.overlay}
      >
        <View pointerEvents="box-none" style={styles.stack}>
          {canPresent && coordinator ? (
            <CelebrationVisual
              snapshot={snapshot}
              onSkip={() => coordinator.skip()}
              onChoose={(choice) => void coordinator.choose(choice)}
            />
          ) : null}

          {snapshot.error !== null ? (
            <ProtectedSurface tone="error" testID="celebration-error" style={styles.notice}>
              <Text allowFontScaling style={[styles.body, { color: tokens.text }]}>
                {snapshot.error}
              </Text>
            </ProtectedSurface>
          ) : null}

          {preferences.saveError !== null ? (
            <ProtectedSurface tone="error" testID="celebration-save-error" style={styles.notice}>
              <Text allowFontScaling style={[styles.body, { color: tokens.text }]}>
                {preferences.saveError}
              </Text>
              <Button
                label="再試行"
                variant="secondary"
                testID="celebration-retry"
                onPress={() => void preferences.retrySave()}
              />
            </ProtectedSurface>
          ) : null}
        </View>
      </View>
      {children}
    </>
  );
}

/**
 * Singleton guard: a host rendered inside another host is a duplicate provider
 * and renders null. The root layout mounts exactly one.
 */
export function CelebrationHost(props: CelebrationHostProps) {
  const nested = useContext(HostPresenceContext);
  if (nested) return null;
  return (
    <HostPresenceContext.Provider value>
      <HostInner {...props} />
    </HostPresenceContext.Provider>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    alignItems: 'center',
    paddingTop: spacing.s6,
    paddingHorizontal: spacing.s4,
  },
  stack: {
    width: '100%',
    maxWidth: 420,
    gap: spacing.s2,
  },
  card: {
    padding: spacing.s3,
    gap: spacing.s1,
  },
  title: {
    fontSize: typography.sizes.bodyLarge,
    fontWeight: typography.weights.semibold,
  },
  body: {
    fontSize: typography.sizes.body,
    lineHeight: typography.sizes.body * typography.lineHeightRatio,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.s2,
    marginTop: spacing.s1,
  },
  action: { flexGrow: 1 },
  notice: {
    padding: spacing.s3,
    gap: spacing.s2,
  },
});
