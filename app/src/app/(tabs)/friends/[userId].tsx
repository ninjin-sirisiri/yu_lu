import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../../auth/provider';
import { conversationEntry } from '../../../navigation/conversationEntry';
import { QueryError, getProfile, type ProfileDetail } from '../../../backend/queries';
import { RELATIONSHIP_LABELS, defaultIsOnline } from '../../../discovery/searchController';
import { enqueueFriendRequest } from '../../../requests/sendRequest';
import { getOperation } from '../../../storage/outbox';
import { createDeviceSyncApi } from '../../../sync/deviceApi';
import { createSyncQueue } from '../../../sync/queue';
import { createSyncWorker } from '../../../sync/worker';
import { useTheme } from '../../../theme/provider';
import { radius, spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';
import { StatusNotice, type StatusTone } from '../../../ui/StatusNotice';

// Task 12: 確認プロフィール.
//
// The route param is the INTERNAL user uuid (Task 5 ruling) — get_profile
// keys on it — while the rendered profile keeps the visible User ID
// (userIdText) the person registered. One panel serves the [userId] route,
// the friends list detail pane and the search-candidate confirmation pane.
//
// The four failure look-alikes stay distinct: 初回読込 (loading),
// 通信失敗 (retryable), オフライン (no connection) and ブロック等による消失
// (the server answers 404 "Target user not found." for hidden profiles).
// Streak is hidden until friendship — the server omits the key for
// non-friends AND this panel refuses to render one for them regardless.
//
// Task 21 gap (spec lines 52–53): the panel is where a candidate confirms
// the profile and THEN applies (申請), and the actions follow the current
// relationship:
//   none             → 申請 through the queue (送信待ち until the server
//                      accepts; one open operation per target, shared with
//                      the requests screen's re-request via
//                      requests/sendRequest.ts)
//   request_outgoing → 申請中 state text (the cancel path stays on the
//                      requests screen — no second cancel implementation)
//   request_incoming → a shortcut into the 受信 list; 承認・拒否 live there
//                      (Global Constraint: 受信一覧に承認・拒否を置き)
//   friend / self    → no request action at all
// After the queue reports success the panel re-reads get_profile, so the
// badge flips to 申請中 without a manual reload.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProfileViewKind = 'loading' | 'ready' | 'offline' | 'network' | 'gone';

export interface ProfilePanelProps {
  /** Internal user uuid (route param / DTO `userId`). */
  userId: string;
  /** Shows 一覧に戻る when provided (adaptive detail panes). */
  onBack?: () => void;
  testID?: string;
}

interface PanelNotice {
  tone: StatusTone;
  title: string;
  message?: string;
  testID: string;
}

/** 'queued' from the moment the outbox row exists until the server answers. */
type SendState = 'idle' | 'queued';

export function ProfilePanel({ userId, onBack, testID = 'profile-panel' }: ProfilePanelProps) {
  const router = useRouter();
  const auth = useAuth();
  const { tokens } = useTheme();
  const [kind, setKind] = useState<ProfileViewKind>('loading');
  const [profile, setProfile] = useState<ProfileDetail | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sendState, setSendState] = useState<SendState>('idle');
  const [sendNotice, setSendNotice] = useState<PanelNotice | null>(null);
  // One in-flight read wins: a target change or a retry supersedes whatever
  // getProfile is still carrying (same guard the old per-effect `alive` had,
  // but the post-send refresh shares it too).
  const loadSeqRef = useRef(0);
  const mountedRef = useRef(true);
  // Synchronous double-tap guard — written BEFORE any await, so two taps in
  // the same frame can never start two enqueue attempts.
  const sendBusyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchProfile = useCallback(
    async (mode: 'screen' | 'refresh'): Promise<void> => {
      const seq = loadSeqRef.current + 1;
      loadSeqRef.current = seq;
      const current = (): boolean => mountedRef.current && loadSeqRef.current === seq;
      if (!UUID_RE.test(userId)) {
        setKind('gone');
        setProfile(null);
        return;
      }
      if (!defaultIsOnline()) {
        // オフライン: the screen read explains itself; a refresh (e.g. after a
        // send) keeps the already-loaded profile on screen instead of
        // regressing to the offline state.
        if (mode === 'screen') {
          setKind('offline');
          setProfile(null);
        }
        return;
      }
      if (mode === 'screen') setKind('loading');
      try {
        const detail = await getProfile(userId);
        if (!current()) return;
        setProfile(detail);
        setKind('ready');
      } catch (error) {
        if (!current()) return;
        // A failed silent refresh keeps the view we already have — the data
        // on screen is still valid, and its send state must not be lost.
        if (mode === 'refresh') return;
        setProfile(null);
        if (error instanceof QueryError && error.status === 404) {
          // Hidden by the server: block either direction or no longer
          // public. This is NOT a network failure.
          setKind('gone');
          return;
        }
        setKind(defaultIsOnline() ? 'network' : 'offline');
      }
    },
    [userId],
  );

  // 初回読込 / 再試行. A screen read starts from a clean send state: a
  // different target (detail panes reuse this component) must never inherit
  // the previous target's 送信待ち.
  useEffect(() => {
    setSendState('idle');
    setSendNotice(null);
    void fetchProfile('screen');
  }, [fetchProfile, attempt]);

  // 申請: enqueue through the SAME queue + guard as the requests screen's
  // re-request, then attempt a foreground send. The button flips to 送信待ち
  // the moment the operation exists — success is only claimed by the server
  // answer, which is then reflected through a profile re-read.
  const sendRequest = useCallback(async (): Promise<void> => {
    if (sendBusyRef.current) return;
    const { accountId, storage } = auth;
    const target = profile === null ? null : profile.userId;
    if (accountId === null || storage === null || target === null) {
      setSendNotice({
        tone: 'error',
        title: '申請を送信できません',
        message: '保存領域が利用できないため送信待ちに追加できませんでした。',
        testID: 'profile-request-error',
      });
      return;
    }
    sendBusyRef.current = true;
    setSendNotice(null);
    try {
      // Built per press: queue/worker/api are stateless factories over the
      // account storage, and this panel can outlive an account switch.
      const queue = createSyncQueue({
        store: storage,
        clock: { now: () => Date.now() },
        random: Math.random,
      });
      const worker = createSyncWorker({ queue, api: createDeviceSyncApi(storage), accountId });
      const outcome = await enqueueFriendRequest({ queue, storage, accountId, target });
      setSendState('queued');
      try {
        await worker.runUntilIdle();
      } catch {
        // A failed attempt simply stays 送信待ち (offline-capable); the queue
        // keeps the operation and retries with backoff.
      }
      const operationId = outcome.enqueued
        ? outcome.operation.operationId
        : outcome.existing.operationId;
      const row = await getOperation(storage, accountId, operationId).catch(() => null);
      if (!mountedRef.current) return;
      if (row !== null && row.state === 'succeeded') {
        // サーバー受付確定 → re-read through the existing read path so the
        // badge flips to 申請中 without a manual reload.
        await fetchProfile('refresh');
        return;
      }
      if (row !== null && row.state === 'failed_permanent') {
        // Terminal: the server will answer the same way. Release the button
        // so the conditions can be checked and a NEW attempt made.
        setSendState('idle');
        setSendNotice({
          tone: 'error',
          title: '申請を送信できませんでした',
          message: 'サーバーがこの申請を受け付けませんでした。条件を確認してもう一度申請できます。',
          testID: 'profile-request-failed',
        });
      }
      // pending / sending / sent_unknown: stays 送信待ち — never claims success.
    } catch (cause) {
      if (!mountedRef.current) return;
      setSendState('idle');
      setSendNotice({
        tone: 'error',
        title: '申請を送信できません',
        message: cause instanceof Error ? cause.message : String(cause),
        testID: 'profile-request-error',
      });
    } finally {
      sendBusyRef.current = false;
    }
  }, [auth, fetchProfile, profile]);

  if (kind === 'loading') {
    return (
      <View style={styles.root} testID={testID}>
        <Text style={[styles.state, { color: tokens.muted }]} testID="profile-loading">
          読み込み中…
        </Text>
      </View>
    );
  }

  if (kind === 'offline') {
    return (
      <View style={styles.root} testID={testID}>
        <StatusNotice
          tone="warning"
          title="オフラインのためプロフィールを取得できません"
          message="接続後に再試行してください。"
          testID="profile-offline"
        />
        <Button
          label="再試行"
          variant="secondary"
          testID="profile-retry"
          onPress={() => setAttempt((value) => value + 1)}
        />
      </View>
    );
  }

  if (kind === 'network') {
    return (
      <View style={styles.root} testID={testID}>
        <StatusNotice
          tone="error"
          title="プロフィールを読み込めませんでした"
          testID="profile-network"
        />
        <Button
          label="再試行"
          variant="secondary"
          testID="profile-retry"
          onPress={() => setAttempt((value) => value + 1)}
        />
      </View>
    );
  }

  if (kind === 'gone' || profile === null) {
    return (
      <View style={styles.root} testID={testID}>
        <StatusNotice
          tone="warning"
          title="この相手は表示できなくなりました"
          message="ブロックされるなどして、公開プロフィールを取得できませんでした。"
          testID="profile-gone"
        />
      </View>
    );
  }

  // Streak only for friendships (and yourself) — server + client gate.
  const showStreak =
    (profile.relationship === 'friend' || profile.relationship === 'self') &&
    typeof profile.streak === 'number';

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.headerRow}>
        <View
          style={[styles.avatar, { backgroundColor: tokens.avatar }]}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          <Text style={[styles.avatarText, { color: tokens.avatarInk }]} allowFontScaling>
            {profile.displayName.slice(0, 1)}
          </Text>
        </View>
        <View style={styles.identity}>
          <Text
            style={[styles.name, { color: tokens.text }]}
            testID="profile-name"
            allowFontScaling
          >
            {profile.displayName}
          </Text>
          <Text style={[styles.userId, { color: tokens.muted }]} testID="profile-userid" allowFontScaling>
            {profile.userIdText}
          </Text>
        </View>
      </View>

      <View style={[styles.badge, { backgroundColor: tokens.accentSoft }]}>
        <Text
          style={[styles.badgeText, { color: tokens.accent }]}
          testID="profile-relationship"
          allowFontScaling
        >
          {RELATIONSHIP_LABELS[profile.relationship]}
        </Text>
      </View>

      {showStreak && (
        <Text
          style={[styles.streak, { color: tokens.text }]}
          testID="profile-streak"
          accessibilityLabel={`${String(profile.streak)}日継続`}
          allowFontScaling
        >
          {`${String(profile.streak)} 日 継続`}
        </Text>
      )}

      {profile.introduction !== null && profile.introduction !== '' && (
        <View style={[styles.introduction, { borderColor: tokens.line, backgroundColor: tokens.soft }]}>
          <Text style={[styles.introductionText, { color: tokens.text }]} testID="profile-introduction" allowFontScaling>
            {profile.introduction}
          </Text>
        </View>
      )}

      {/* 関係に合わせた操作 (spec line 53): 申請 / 送信待ち / 申請中 /
          受信一覧への入口。friend・self には申請操作を出さない。 */}
      {profile.relationship === 'none' && sendState === 'idle' && (
        <Button
          label="申請"
          testID="profile-request"
          accessibilityHint="この相手に友達申請を送信します"
          onPress={() => void sendRequest()}
        />
      )}
      {profile.relationship === 'none' && sendState === 'queued' && (
        <Button
          label="送信待ち"
          variant="secondary"
          disabled
          testID="profile-request-queued"
          accessibilityHint="接続が戻ると自動で送信されます"
          onPress={() => undefined}
        />
      )}
      {profile.relationship === 'request_outgoing' && (
        <Button
          label="申請中"
          variant="secondary"
          disabled
          testID="profile-request-outgoing"
          accessibilityHint="相手の承認を待っています"
          onPress={() => undefined}
        />
      )}
      {profile.relationship === 'request_incoming' && (
        <Button
          label="受信した申請を見る"
          variant="secondary"
          testID="profile-incoming-requests"
          accessibilityHint="承認と拒否は受信した申請の一覧で行います"
          onPress={() => router.push('/friends/requests?tab=incoming')}
        />
      )}

      {profile.relationship === 'friend' && (
        <Button label="メッセージ" testID="profile-message"
          accessibilityHint="この友達との会話を開きます"
          onPress={() => router.push(conversationEntry(profile.userId, 'profile'))} />
      )}

      {sendNotice !== null && (
        <StatusNotice
          tone={sendNotice.tone}
          title={sendNotice.title}
          message={sendNotice.message}
          testID={sendNotice.testID}
        />
      )}

      {onBack !== undefined && (
        <Button label="一覧に戻る" variant="secondary" testID="profile-back" onPress={onBack} />
      )}
    </View>
  );
}

export default function ProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const id = Array.isArray(userId) ? (userId[0] ?? '') : (userId ?? '');
  return (
    <Screen testID="profile-screen">
      <ProfilePanel userId={id} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.s4,
    paddingVertical: spacing.s4,
  },
  state: {
    fontSize: typography.sizes.bodyLarge,
    textAlign: 'center',
    paddingVertical: spacing.s5,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s4,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: typography.sizes.title,
    fontWeight: typography.weights.semibold,
  },
  identity: {
    flex: 1,
    gap: spacing.s1,
  },
  name: {
    fontSize: typography.sizes.title,
    fontWeight: typography.weights.semibold,
    lineHeight: typography.sizes.title * typography.lineHeightRatio,
  },
  userId: {
    fontSize: typography.sizes.small,
    lineHeight: typography.sizes.small * typography.lineHeightRatio,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s1,
  },
  badgeText: {
    fontSize: typography.sizes.caption,
    fontWeight: typography.weights.semibold,
  },
  streak: {
    fontSize: typography.sizes.bodyLarge,
    fontVariant: ['tabular-nums'],
  },
  introduction: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.s3,
  },
  introductionText: {
    fontSize: typography.sizes.body,
    lineHeight: typography.sizes.body * typography.lineHeightRatio,
  },
});
