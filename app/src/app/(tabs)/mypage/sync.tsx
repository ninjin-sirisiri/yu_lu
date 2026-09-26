import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../../auth/provider';
import { defaultIsOnline } from '../../../discovery/searchController';
import { subscribeAppResume } from '../../../requests/friendsRepository';
import { listOperations, type OutboxRecord } from '../../../storage/outbox';
import { createCommandApi, type CommandApi } from '../../../sync/api';
import { createSyncQueue } from '../../../sync/queue';
import {
  SyncErrorNotice,
  SyncStatus,
  unfinishedOperations,
} from '../../../sync/SyncStatus';
import { createSyncWorker } from '../../../sync/worker';
import { useTheme } from '../../../theme/provider';
import { spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';
import { StatusNotice, type StatusTone } from '../../../ui/StatusNotice';

// Task 13: 送信状況 screen (マイページ → 送信状況, also reachable from the
// 申請 screen).
//
// Ownership: reading the account's outbox, reconciling it before every read
// (sweeping overdue 送信待ち to 確認が必要 and recovering dropped claims to
// 結果確認中), and resolving SyncStatus's two actions against the REAL
// queue:
//
// - 送信待ち取消 → `queue.cancelUnsent` (guarded UPDATE; a lost race with
//   an ongoing send is reported instead of hidden),
// - 24時間超過 / 不成立の再送 → confirm inline, then `queue.retryAsNew`,
//   which supersedes the old row and inserts a NEW operation with a NEW
//   operation id and the SAME stored payload — the request_id of the old
//   request is never swapped for a newer one. The worker then runs the
//   fresh operation (a failure simply stays 送信待ち / needs its own
//   confirmation, never silently re-sent).

interface ScreenNotice {
  tone: StatusTone;
  title: string;
  message?: string;
  testID: string;
}

export default function SyncScreen() {
  const auth = useAuth();
  const { tokens } = useTheme();

  const api = useMemo<CommandApi>(() => createCommandApi(), []);
  const bindings = useMemo(() => {
    if (auth.accountId === null || auth.storage === null) return null;
    const queue = createSyncQueue({
      store: auth.storage,
      clock: { now: () => Date.now() },
      random: Math.random,
    });
    const worker = createSyncWorker({ queue, api, accountId: auth.accountId });
    return { queue, worker };
  }, [auth.accountId, auth.storage, api]);

  const [operations, setOperations] = useState<OutboxRecord[] | null>(null);
  const [loadError, setLoadError] = useState<'offline' | 'network' | null>(null);
  const [busyIds, setBusyIdsState] = useState<string[]>([]);
  const [notice, setNotice] = useState<ScreenNotice | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef<Set<string>>(new Set());

  const setBusy = useCallback(() => {
    setBusyIdsState([...busyRef.current]);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const { accountId, storage } = auth;
    if (accountId === null || storage === null || bindings === null) {
      setOperations([]);
      return;
    }
    // Reconcile first: a 24-hour overdue 送信待ち row becomes 確認が必要
    // (never auto-executed) and a dropped claim becomes 結果確認中 before
    // anything on screen can act on stale states.
    try {
      await bindings.queue.reconcile(accountId);
    } catch {
      // The listing below still reports the stored truth.
    }
    try {
      const rows = await listOperations(storage, accountId);
      if (!mountedRef.current) return;
      setOperations(unfinishedOperations(rows));
      setLoadError(null);
    } catch {
      if (!mountedRef.current) return;
      setLoadError(defaultIsOnline() ? 'network' : 'offline');
    }
  }, [auth, bindings]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // 接続復帰・アプリ復帰で再読み込み (the queue's own retries run in the
  // worker; this screen only re-renders the stored truth).
  useEffect(() => subscribeAppResume(() => void refresh()), [refresh]);

  const onCancelUnsent = useCallback(
    async (operation: OutboxRecord): Promise<void> => {
      const { accountId } = auth;
      if (accountId === null || bindings === null) return;
      if (busyRef.current.has(operation.operationId)) return;
      busyRef.current.add(operation.operationId);
      setBusy();
      try {
        const cancelled = await bindings.queue.cancelUnsent(accountId, operation.operationId);
        setNotice(
          cancelled
            ? { tone: 'info', title: '送信待ちの操作を取り消しました', testID: 'sync-cancelled' }
            : {
                tone: 'warning',
                title: 'この操作はすでに送信を開始しています',
                message: '送信開始後の操作は取り消せません。',
                testID: 'sync-cancel-race',
              },
        );
        await refresh();
      } finally {
        busyRef.current.delete(operation.operationId);
        setBusy();
      }
    },
    [auth, bindings, refresh, setBusy],
  );

  const onRetryAsNew = useCallback(
    async (operation: OutboxRecord): Promise<void> => {
      const { accountId } = auth;
      if (accountId === null || bindings === null) return;
      if (busyRef.current.has(operation.operationId)) return;
      busyRef.current.add(operation.operationId);
      setBusy();
      try {
        // NEW operation id, SAME stored payload — the old request_id is
        // never replaced with a newer one (確認してからの再送).
        await bindings.queue.retryAsNew({
          accountId,
          operationId: operation.operationId,
        });
        setNotice({
          tone: 'info',
          title: '新しい操作として送り直しました',
          message: '以前の操作は履歴に残っています。',
          testID: 'sync-retried',
        });
        await refresh();
        try {
          await bindings.worker.runUntilIdle();
        } catch {
          // Transport failure: the fresh operation stays 送信待ち.
        }
        await refresh();
      } catch (cause) {
        setNotice({
          tone: 'error',
          title: '送り直せませんでした',
          message: cause instanceof Error ? cause.message : String(cause),
          testID: 'sync-retry-failed',
        });
        await refresh();
      } finally {
        busyRef.current.delete(operation.operationId);
        setBusy();
      }
    },
    [auth, bindings, refresh, setBusy],
  );

  const busyKeySet = useMemo(() => new Set(busyIds), [busyIds]);
  const firstLoadPending = operations === null && loadError === null;

  return (
    <Screen testID="sync-screen">
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={[styles.subtitle, { color: tokens.muted }]} allowFontScaling>
            送信中・結果確認中の操作を確認できます
          </Text>
          <Button
            label="再読み込み"
            variant="secondary"
            testID="sync-refresh"
            onPress={() => void refresh()}
          />
        </View>

        {notice !== null && (
          <StatusNotice
            tone={notice.tone}
            title={notice.title}
            message={notice.message}
            testID={notice.testID}
          />
        )}

        {loadError !== null && (
          <View style={styles.errorBlock}>
            <SyncErrorNotice error={loadError} testID="sync-error" />
            <Button
              label="再試行"
              variant="secondary"
              testID="sync-retry-read"
              onPress={() => void refresh()}
            />
          </View>
        )}

        {firstLoadPending && (
          <Text style={[styles.state, { color: tokens.muted }]} testID="sync-loading">
            読み込み中…
          </Text>
        )}

        {operations !== null && (
          <SyncStatus
            operations={operations}
            busyIds={busyKeySet}
            onCancelUnsent={(operation) => void onCancelUnsent(operation)}
            onRetryAsNew={(operation) => void onRetryAsNew(operation)}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: {
    gap: spacing.s3,
    paddingTop: spacing.s3,
    paddingBottom: spacing.s6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.s2,
  },
  subtitle: {
    flex: 1,
    fontSize: typography.sizes.small,
    lineHeight: typography.sizes.small * typography.lineHeightRatio,
  },
  errorBlock: {
    gap: spacing.s2,
  },
  state: {
    fontSize: typography.sizes.bodyLarge,
    textAlign: 'center',
    paddingVertical: spacing.s5,
  },
});
