import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../../auth/provider';
import {
  listRequests,
  type ProfileSummary,
  type RequestDirection,
  type RequestEntry,
} from '../../../backend/queries';
import { defaultIsOnline } from '../../../discovery/searchController';
import {
  AdaptiveLayout,
  useAdaptiveLayoutState,
} from '../../../navigation/AdaptiveLayout';
import { rejectionDisplay } from '../../../requests/inbox';
import {
  RequestList,
  type QueuedRequestRow,
  type RequestActionKind,
  type RequestTab,
} from '../../../requests/RequestList';
import {
  notifyFriendsChanged,
  subscribeAppResume,
  subscribeFriendsChanged,
} from '../../../requests/friendsRepository';
import { randomId } from '../../../storage/database';
import { listOperations, type OutboxRecord } from '../../../storage/outbox';
import { createCommandApi, type CommandApi, type CommandOutcome } from '../../../sync/api';
import { createSyncQueue } from '../../../sync/queue';
import { countUnfinishedOperations } from '../../../sync/SyncStatus';
import { createSyncWorker } from '../../../sync/worker';
import { useTheme } from '../../../theme/provider';
import { spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';
import { StatusNotice, type StatusTone } from '../../../ui/StatusNotice';
import { ProfilePanel } from './[userId]';

// Task 13: 受信・送信申請 screen.
//
// Ownership: the tab switch (受信 / 送信), the read refresh triggers, the
// per-action wiring from RequestList's callbacks to the command boundary,
// and the two sender-side transitions the masking design produces (the
// neutral 今回は成立しませんでした when a pending row comes back as `ended`,
// and the 次回抽選 guidance when a friendship gets established).
//
// Command routing (decided here, per action):
// - approve / reject / cancel go DIRECTLY through `createCommandApi` with a
//   persistent operation id: the inbox decision must answer immediately,
//   and the operation-id path makes a lost response safe to replay — the
//   same id + same payload returns the stored server result. The id is
//   created once per (kind, request id) and kept until a terminal answer,
//   so a retry never becomes a second server-side operation.
// - re-request (申請の再送) goes through the QUEUE (app-command via
//   queue + worker): a new outbound request must survive offline, retry
//   with backoff and show up as 送信待ち. Enqueueing is guarded by "one
//   open `request` operation per target", so a double-tap or a repeated
//   tap while 送信待ち can never create a second operation.
//
// Refresh: the list re-reads the SERVER on mount, on tab switch, on app
// 復帰 and on 友達成立 (subscribeAppResume / subscribeFriendsChanged from
// friendsRepository). There is no requests cache — cache-only display must
// never hide a counterparty change.

type DecisionKind = 'approve' | 'reject' | 'cancel';

interface ScreenNotice {
  tone: StatusTone;
  title: string;
  message?: string;
  testID: string;
}

/** Queue states in which a `request` operation still owns its target. */
const OPEN_REQUEST_STATES: readonly string[] = [
  'pending',
  'sending',
  'sent_unknown',
  'needs_confirmation',
];

/**
 * Overlay display states — OPEN_REQUEST_STATES plus `succeeded` (the server
 * accepted the send but the fresh listing row has not arrived yet).
 */
const OVERLAY_STATES: readonly string[] = [...OPEN_REQUEST_STATES, 'succeeded'];

function queuedStateOf(state: string): QueuedRequestRow['state'] | null {
  return (OVERLAY_STATES as readonly string[]).includes(state)
    ? (state as QueuedRequestRow['state'])
    : null;
}

/**
 * A server row retires the local overlay only when it plausibly belongs to
 * THIS send: a pending/approved row for the target, or any row for the
 * target created around the enqueue time. Older history rows (a previous
 * ended request still inside its 7-day window) never hide a 送信待ち send.
 */
const SERVER_ROW_FRESH_MS = 2 * 60 * 1000;

function requestTargetOf(operation: OutboxRecord): unknown {
  const payload = operation.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  return (payload as Record<string, unknown>)['target_user_id'];
}

export function RequestsArea() {
  const router = useRouter();
  const auth = useAuth();
  const { tokens } = useTheme();
  const { selectedPeerId, selectPeer } = useAdaptiveLayoutState();

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

  const [tab, setTab] = useState<RequestTab>('incoming');
  const [data, setData] = useState<{
    incoming: RequestEntry[] | null;
    outgoing: RequestEntry[] | null;
  }>({ incoming: null, outgoing: null });
  const [loadError, setLoadError] = useState<'offline' | 'network' | null>(null);
  const [queued, setQueuedState] = useState<QueuedRequestRow[]>([]);
  const [busyKeys, setBusyKeysState] = useState<string[]>([]);
  const [notice, setNotice] = useState<ScreenNotice | null>(null);
  const [established, setEstablished] = useState<ProfileSummary | null>(null);
  const [unfinished, setUnfinished] = useState(0);

  const tabRef = useRef<RequestTab>('incoming');
  const mountedRef = useRef(true);
  const queuedRef = useRef<QueuedRequestRow[]>([]);
  const busyRef = useRef<Set<string>>(new Set());
  // Direct-decision operation ids: one per (kind, request id), reused until
  // the server answers terminally (replays stay idempotent).
  const decisionOpsRef = useRef<Map<string, string>>(new Map());
  // Outgoing pending rows seen on the last read, for transition detection.
  const prevPendingRef = useRef<Map<string, ProfileSummary>>(new Map());

  const setQueuedRows = useCallback((rows: QueuedRequestRow[]) => {
    queuedRef.current = rows;
    setQueuedState(rows);
  }, []);

  const setBusyKeys = useCallback(() => {
    setBusyKeysState([...busyRef.current]);
  }, []);

  // -- read -----------------------------------------------------------------

  const detectOutgoingTransitions = useCallback((items: RequestEntry[]) => {
    const previous = prevPendingRef.current;
    const next = new Map<string, ProfileSummary>();
    for (const item of items) {
      if (item.status === 'pending') {
        next.set(item.requestId, item.counterpart);
        continue;
      }
      const wasPending = previous.get(item.requestId);
      if (wasPending === undefined) continue;
      if (item.status === 'ended') {
        // 拒否後は送信側へ今回は成立しませんでしたと即座に表示する (the
        // rejection itself stays masked — this is all the sender gets).
        setNotice({
          tone: 'neutral',
          title: rejectionDisplay(),
          message: `${wasPending.displayName}さんの申請は終了しました。`,
          testID: 'requests-rejected-sender',
        });
      } else if (item.status === 'approved') {
        setEstablished(wasPending);
      }
    }
    prevPendingRef.current = next;
  }, []);

  const pruneQueued = useCallback(
    async (serverOutgoing: RequestEntry[]): Promise<void> => {
      const current = queuedRef.current;
      if (current.length === 0) return;
      const { accountId, storage } = auth;
      let rows: OutboxRecord[] | null = null;
      if (accountId !== null && storage !== null) {
        try {
          rows = await listOperations(storage, accountId);
        } catch {
          rows = null; // Unreadable queue: keep the overlay, only server rows prune.
        }
      }
      if (!mountedRef.current) return;
      const kept: QueuedRequestRow[] = [];
      for (const row of current) {
        if (rows === null) {
          kept.push(row);
          continue;
        }
        const operation = rows.find((item) => item.operationId === row.operationId);
        if (operation === undefined) continue;
        if (operation.state === 'failed_permanent') {
          setNotice({
            tone: 'error',
            title: '申請を送信できませんでした',
            message: 'サーバーがこの申請を受け付けませんでした。条件を確認してもう一度申請できます。',
            testID: 'requests-send-failed',
          });
          continue;
        }
        if (operation.state === 'cancelled' || operation.state === 'superseded') continue;
        const next = queuedStateOf(operation.state);
        if (next === null) continue;
        // The server listing is authoritative once it shows a row that
        // belongs to THIS send (pending/approved, or created around the
        // enqueue time); older ended history for the same target is not it.
        const fresh = serverOutgoing.some((item) => {
          if (item.counterpart.userId !== row.counterpart.userId) return false;
          if (item.status === 'pending' || item.status === 'approved') return true;
          const created = Date.parse(item.createdAt);
          return !Number.isNaN(created) && created >= operation.createdAt - SERVER_ROW_FRESH_MS;
        });
        if (fresh) continue;
        kept.push({ ...row, state: next });
      }
      setQueuedRows(kept);
    },
    [auth, setQueuedRows],
  );

  const refreshDirection = useCallback(
    async (direction: RequestTab): Promise<void> => {
      try {
        const page = await listRequests(direction, null);
        if (!mountedRef.current) return;
        setData((prev) =>
          direction === 'incoming'
            ? { ...prev, incoming: page.items }
            : { ...prev, outgoing: page.items },
        );
        setLoadError(null);
        if (direction === 'outgoing') detectOutgoingTransitions(page.items);
        await pruneQueued(page.items);
      } catch {
        if (!mountedRef.current) return;
        setLoadError(defaultIsOnline() ? 'network' : 'offline');
      }
    },
    [detectOutgoingTransitions, pruneQueued],
  );

  const refreshUnfinished = useCallback(async (): Promise<void> => {
    const count = await countUnfinishedOperations(auth.storage, auth.accountId);
    if (mountedRef.current) setUnfinished(count);
  }, [auth.storage, auth.accountId]);

  // 初回読込 / 復帰 / 成立 で必ずサーバーを読み直す.
  useEffect(() => {
    mountedRef.current = true;
    void refreshDirection(tabRef.current);
    void refreshUnfinished();
    return () => {
      mountedRef.current = false;
    };
  }, [refreshDirection, refreshUnfinished]);

  useEffect(
    () =>
      subscribeAppResume(() => {
        void refreshDirection(tabRef.current);
        void refreshUnfinished();
      }),
    [refreshDirection, refreshUnfinished],
  );

  useEffect(
    () =>
      subscribeFriendsChanged(() => {
        void refreshDirection(tabRef.current);
        void refreshUnfinished();
      }),
    [refreshDirection, refreshUnfinished],
  );

  // -- actions --------------------------------------------------------------

  const decide = useCallback(
    async (kind: DecisionKind, entry: RequestEntry): Promise<void> => {
      const accountId = auth.accountId;
      if (accountId === null) return;
      const key = `${kind}:${entry.requestId}`;
      // Synchronous double-tap guard — the ref is written BEFORE any await,
      // so two taps in the same frame cannot start two operations.
      if (busyRef.current.has(key)) return;
      busyRef.current.add(key);
      setBusyKeys();
      try {
        let operationId = decisionOpsRef.current.get(key);
        if (operationId === undefined) {
          operationId = randomId();
          decisionOpsRef.current.set(key, operationId);
        }
        let outcome: CommandOutcome;
        try {
          outcome = await api.send({
            accountId,
            operationId,
            kind,
            payload: { request_id: entry.requestId },
          });
        } catch (cause) {
          outcome = {
            status: 'transient',
            message: cause instanceof Error ? cause.message : String(cause),
          };
        }
        switch (outcome.status) {
          case 'ok': {
            decisionOpsRef.current.delete(key);
            setNotice(null);
            if (kind === 'approve') {
              setEstablished(entry.counterpart);
              // 成立 → the friends list refreshes too.
              notifyFriendsChanged();
            }
            await refreshDirection(tabRef.current);
            void refreshUnfinished();
            break;
          }
          case 'conflict':
          case 'rejected': {
            // Terminal: the server will answer the same way for this id.
            decisionOpsRef.current.delete(key);
            setNotice({
              tone: 'error',
              title: '操作を完了できませんでした',
              message: outcome.message,
              testID: 'requests-decision-error',
            });
            await refreshDirection(tabRef.current);
            break;
          }
          case 'transient':
          case 'unknown': {
            // The operation id is KEPT: a retry replays the same id and can
            // never become a second server-side operation.
            setNotice({
              tone: 'warning',
              title: '送信できませんでした',
              message:
                '接続を確認して、もう一度同じ操作を実行してください。同じ操作IDで送るため二重には成立しません。',
              testID: 'requests-decision-retry',
            });
            break;
          }
        }
      } finally {
        busyRef.current.delete(key);
        setBusyKeys();
      }
    },
    [api, auth.accountId, refreshDirection, refreshUnfinished, setBusyKeys],
  );

  const reRequest = useCallback(
    async (entry: RequestEntry): Promise<void> => {
      const { accountId, storage } = auth;
      if (accountId === null || storage === null || bindings === null) {
        setNotice({
          tone: 'error',
          title: '申請を送信できません',
          message: '保存領域が利用できないため送信待ちに追加できませんでした。',
          testID: 'requests-send-failed',
        });
        return;
      }
      const target = entry.counterpart.userId;
      const key = `request:${target}`;
      // Double-tap guard for the queued path (the open-operation check
      // below is the second line of defence once the ref is released).
      if (busyRef.current.has(key)) return;
      busyRef.current.add(key);
      setBusyKeys();
      try {
        const rows = await listOperations(storage, accountId);
        const open = rows.find(
          (row) =>
            row.kind === 'request' &&
            OPEN_REQUEST_STATES.includes(row.state) &&
            requestTargetOf(row) === target,
        );
        if (open === undefined) {
          const { operation } = await bindings.queue.enqueue({
            accountId,
            kind: 'request',
            payload: { target_user_id: target },
          });
          setQueuedRows([
            ...queuedRef.current,
            { operationId: operation.operationId, counterpart: entry.counterpart, state: 'pending' },
          ]);
          setNotice({
            tone: 'info',
            title: '申請を送信待ちに追加しました',
            message: '接続が戻ると自動で送信されます。状況は「送信状況」で確認できます。',
            testID: 'requests-queued',
          });
          await refreshUnfinished();
          // Foreground attempt; a failure simply stays 送信待ち (offline-capable).
          void (async () => {
            try {
              await bindings.worker.runUntilIdle();
            } catch {
              // The queue keeps the operation; nothing to undo here.
            }
            await refreshDirection('outgoing');
            void refreshUnfinished();
          })();
        } else {
          const state = queuedStateOf(open.state);
          if (
            state !== null &&
            !queuedRef.current.some((row) => row.operationId === open.operationId)
          ) {
            // Already queued (remount or repeated tap): surface the EXISTING
            // operation instead of creating another one.
            setQueuedRows([
              ...queuedRef.current,
              { operationId: open.operationId, counterpart: entry.counterpart, state },
            ]);
          }
        }
      } catch (cause) {
        setNotice({
          tone: 'error',
          title: '申請を送信できません',
          message: cause instanceof Error ? cause.message : String(cause),
          testID: 'requests-send-failed',
        });
      } finally {
        busyRef.current.delete(key);
        setBusyKeys();
      }
    },
    [auth, bindings, refreshDirection, refreshUnfinished, setBusyKeys, setQueuedRows],
  );

  const handleAction = useCallback(
    (action: RequestActionKind, entry: RequestEntry): void => {
      switch (action) {
        case 'approve':
          void decide('approve', entry);
          break;
        case 'reject':
          void decide('reject', entry);
          break;
        case 'cancel':
          void decide('cancel', entry);
          break;
        case 'reRequest':
          void reRequest(entry);
          break;
      }
    },
    [decide, reRequest],
  );

  const switchTab = useCallback(
    (next: RequestTab): void => {
      tabRef.current = next;
      setTab(next);
      void refreshDirection(next);
    },
    [refreshDirection],
  );

  const retryRead = useCallback((): void => {
    void refreshDirection(tabRef.current);
    void refreshUnfinished();
  }, [refreshDirection, refreshUnfinished]);

  // -- render ---------------------------------------------------------------

  const entries = tab === 'incoming' ? data.incoming : data.outgoing;
  const busyKeySet = useMemo(() => new Set(busyKeys), [busyKeys]);
  const firstLoadPending = entries === null && loadError === null;

  const listContent = (
    <View style={styles.listRoot} testID="requests-list">
      <View style={styles.tabs}>
        <Button
          label="受信"
          selected={tab === 'incoming'}
          testID="requests-tab-incoming"
          accessibilityLabel="受信した申請"
          onPress={() => switchTab('incoming')}
          style={styles.tab}
        />
        <Button
          label="送信"
          selected={tab === 'outgoing'}
          testID="requests-tab-outgoing"
          accessibilityLabel="送信した申請"
          onPress={() => switchTab('outgoing')}
          style={styles.tab}
        />
      </View>

      {established !== null && (
        <StatusNotice
          tone="success"
          title={`${established.displayName}さんと友達になりました`}
          message="次回の抽選はホームタブで確認できます"
          testID="requests-established"
        />
      )}

      {notice !== null && (
        <StatusNotice
          tone={notice.tone}
          title={notice.title}
          message={notice.message}
          testID={notice.testID}
        />
      )}

      {loadError === 'offline' && (
        <StatusNotice
          tone="warning"
          title="オフラインのため申請一覧を取得できません"
          message="接続後に更新します。送信中の操作は「送信状況」で確認できます。"
          testID="requests-offline"
        />
      )}

      {loadError === 'network' && (
        <View style={styles.errorBlock}>
          <StatusNotice tone="error" title="申請一覧を読み込めませんでした" testID="requests-error" />
          <Button label="再試行" variant="secondary" testID="requests-retry" onPress={retryRead} />
        </View>
      )}

      {firstLoadPending && (
        <Text style={[styles.state, { color: tokens.text }]} testID="requests-loading">
          読み込み中…
        </Text>
      )}

      {entries !== null && (
        <RequestList
          direction={tab}
          entries={entries}
          queued={tab === 'outgoing' ? queued : []}
          busyKeys={busyKeySet}
          onAction={handleAction}
          onOpenProfile={(entry) => selectPeer(entry.counterpart.userId)}
        />
      )}
    </View>
  );

  return (
    <Screen
      testID="requests-screen"
      headerAccessory={
        <Button
          label={unfinished > 0 ? `送信状況 ${String(unfinished)}件` : '送信状況'}
          variant="secondary"
          testID="requests-sync-entry"
          accessibilityHint="未送信の操作と結果確認中の操作を確認できます"
          onPress={() => router.push('/mypage/sync')}
        />
      }
    >
      <AdaptiveLayout
        testID="requests-layout"
        list={
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            {listContent}
          </ScrollView>
        }
        detail={
          selectedPeerId === null ? null : (
            <ProfilePanel userId={selectedPeerId} onBack={() => selectPeer(null)} />
          )
        }
        emptyDetail={
          <Text style={[styles.emptyDetail, { color: tokens.muted }]} testID="requests-empty-detail">
            申請を選ぶとプロフィールを確認できます
          </Text>
        }
      />
    </Screen>
  );
}

export default function RequestsScreen() {
  return <RequestsArea />;
}

const styles = StyleSheet.create({
  listRoot: {
    gap: spacing.s3,
    paddingTop: spacing.s3,
  },
  tabs: {
    flexDirection: 'row',
    gap: spacing.s2,
  },
  tab: {
    flex: 1,
  },
  errorBlock: {
    gap: spacing.s2,
  },
  state: {
    fontSize: typography.sizes.bodyLarge,
    textAlign: 'center',
    paddingVertical: spacing.s5,
  },
  scroll: {
    paddingBottom: spacing.s6,
  },
  emptyDetail: {
    fontSize: typography.sizes.body,
    textAlign: 'center',
    padding: spacing.s5,
  },
});
