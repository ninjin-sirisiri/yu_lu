import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, type ScrollView } from 'react-native';

import { createDeviceLogoutPorts, performLogout, type UnsentSummary } from '../../../auth/logout';
import { useAuth } from '../../../auth/provider';
import { getOwnPublication, type ProfilePublication } from '../../../backend/profile';
import { defaultIsOnline } from '../../../discovery/searchController';
import { subscribeAppResume } from '../../../requests/friendsRepository';
import { listOperations } from '../../../storage/outbox';
import { scrollRefToTop, subscribeTabReselect } from '../../../navigation/tabReselect';
import { countUnfinishedOperations } from '../../../sync/SyncStatus';
import { getSharedSyncLifecycle } from '../../../sync/lifecycle';
import { useTheme } from '../../../theme/provider';
import { spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';
import { StatusNotice } from '../../../ui/StatusNotice';

// マイページ: the owner's PUBLISHED profile plus the entry points.
//
// - 公開内容 is read from the own-row (getOwnPublication): display name,
//   the immutable User ID, introduction and whether an image is published.
//   本人の変更予定 (unsent drafts / queued saves) is reported separately by
//   the pending notice below — published and pending are never blended.
// - 送信状況 (Task 13) counts the account's unfinished queue rows and
//   refreshes on mount and on app resume.
// - ログアウト (Task 21, spec line 28): the entry runs Task 20's
//   performLogout unchanged — this screen only injects the three UI gates:
//   confirmUnsent (the inline 未送信/送信中 confirmation below), stopWorker
//   and resumeWorker bound to the SHARED sync lifecycle (Task 20 report:
//   resumeWorker is required so the offline pending logout can finalize on
//   connectivity). Device ports (counting, marker, invalidation, session
//   discard, purge) all come from createDeviceLogoutPorts — the screen
//   never re-implements an ordered step. 'completed' relies on the client's
//   SIGNED_OUT event (provider refresh → tabs guard → /login) plus an
//   explicit refresh; 'pending' explains that connectivity finalizes it.
// - A failed profile read degrades to a retry notice; the entries stay
//   usable either way (読み込みだけが失敗した場合でも操作は続けられる).

type ProfileLoadState = 'loading' | 'ready' | 'error';

type LogoutNotice = {
  tone: 'error' | 'info';
  title: string;
  message: string;
  testID: string;
};

const UNFINISHED_PROFILE_STATES: readonly string[] = [
  'pending',
  'sending',
  'sent_unknown',
  'failed_permanent',
  'needs_confirmation',
];

export default function MypageScreen() {
  const router = useRouter();
  const auth = useAuth();
  const { tokens } = useTheme();
  const [unfinished, setUnfinished] = useState(0);
  const [profileState, setProfileState] = useState<ProfileLoadState>('loading');
  const [publication, setPublication] = useState<ProfilePublication | null>(null);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      const count = await countUnfinishedOperations(auth.storage, auth.accountId);
      if (alive) setUnfinished(count);
      // 未送信・未完了のプロフィール保存だけを数える (変更予定の案内用).
      let pending = 0;
      if (auth.storage !== null && auth.accountId !== null) {
        try {
          const rows = await listOperations(auth.storage, auth.accountId);
          pending = rows.filter(
            (row) =>
              row.kind === 'update_profile' && UNFINISHED_PROFILE_STATES.includes(row.state),
          ).length;
        } catch {
          pending = 0;
        }
      }
      if (alive) setPendingSaves(pending);
    };
    void load();
    return () => {
      alive = false;
    };
  }, [auth.storage, auth.accountId]);

  useEffect(() => {
    if (!defaultIsOnline()) {
      setProfileState('error');
      return;
    }
    let alive = true;
    setProfileState('loading');
    getOwnPublication()
      .then((value) => {
        if (!alive) return;
        setPublication(value);
        setProfileState('ready');
      })
      .catch(() => {
        if (alive) setProfileState('error');
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const refreshQueue = useCallback(async (): Promise<void> => {
    const count = await countUnfinishedOperations(auth.storage, auth.accountId);
    setUnfinished(count);
  }, [auth.storage, auth.accountId]);

  useEffect(() => subscribeAppResume(() => void refreshQueue()), [refreshQueue]);

  // Task 22 (spec line 32): 選択中タブの再選択でこの一覧を先頭へ戻す.
  const scrollRef = useRef<ScrollView>(null);
  useEffect(
    () => subscribeTabReselect('mypage', () => scrollRefToTop(scrollRef)),
    [scrollRef],
  );

  // -- ログアウト (Task 21) --------------------------------------------------
  //
  // performLogout OWNS the order (確認 → worker停止 → 失効 → 破棄 → 消去);
  // this screen only answers the confirmation and maps the result. The
  // confirmation promise is resolved by the inline buttons below — decline
  // happens BEFORE anything is stopped (step 1 gate).

  const [logoutSummary, setLogoutSummary] = useState<UnsentSummary | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutNotice, setLogoutNotice] = useState<LogoutNotice | null>(null);
  const confirmResolver = useRef<((confirmed: boolean) => void) | null>(null);

  const confirmUnsent = useCallback((summary: UnsentSummary): Promise<boolean> => {
    setLogoutSummary(summary);
    return new Promise<boolean>((resolve) => {
      confirmResolver.current = resolve;
    });
  }, []);

  const answerLogout = useCallback((confirmed: boolean): void => {
    const resolve = confirmResolver.current;
    confirmResolver.current = null;
    setLogoutSummary(null);
    resolve?.(confirmed);
  }, []);

  // A screen that goes away must never leave performLogout hanging on an
  // unanswered confirmation: declining is the safe default.
  useEffect(
    () => () => {
      const resolve = confirmResolver.current;
      confirmResolver.current = null;
      resolve?.(false);
    },
    [],
  );

  const startLogout = useCallback(async (): Promise<void> => {
    const accountId = auth.accountId;
    const storage = auth.storage;
    if (accountId === null || storage === null) return;
    setLogoutBusy(true);
    setLogoutNotice(null);
    try {
      const result = await performLogout({
        accountId,
        storage,
        ...createDeviceLogoutPorts({ accountId, storage }),
        confirmUnsent,
        // Task 20 report: the UI injects the shared lifecycle gates.
        // resumeWorker MUST come back — the offline ('pending') logout is
        // finalized by the connectivity drain, which only runs while the
        // lifecycle is alive.
        stopWorker: () => {
          getSharedSyncLifecycle().stop();
        },
        resumeWorker: () => {
          getSharedSyncLifecycle().start();
        },
      });
      switch (result.status) {
        case 'cancelled':
          // Step 1 declined: nothing was stopped or discarded.
          break;
        case 'completed':
          // The client's SIGNED_OUT event refreshes the provider (tabs
          // guard → /login); refresh() also covers a missed event.
          void auth.refresh();
          break;
        case 'pending':
          setLogoutNotice({
            tone: 'info',
            title: 'ログアウトを完了できませんでした',
            message:
              '通信できないため端末のログアウトを保留しています。接続が戻ると自動で完了します。',
            testID: 'mypage-logout-pending',
          });
          break;
        case 'failed':
          setLogoutNotice({
            tone: 'error',
            title: 'ログアウトを完了できませんでした',
            message: result.message,
            testID: 'mypage-logout-failed',
          });
          break;
      }
    } finally {
      setLogoutBusy(false);
    }
  }, [auth.accountId, auth.refresh, auth.storage, confirmUnsent]);

  return (
    <Screen scroll testID="mypage-screen" scrollViewRef={scrollRef}>
      <View style={styles.center}>
        <Text style={[styles.title, { color: tokens.text }]}>マイページ</Text>

        {profileState === 'loading' && (
          <Text style={[styles.placeholder, { color: tokens.muted }]} testID="mypage-profile-loading">
            プロフィールを読み込んでいます…
          </Text>
        )}

        {profileState === 'error' && (
          <>
            <StatusNotice
              tone="error"
              title="プロフィールを読み込めませんでした"
              message="通信を確認して、もう一度お試しください。"
              testID="mypage-profile-error"
            />
            <Button
              label="再試行"
              variant="secondary"
              testID="mypage-profile-retry"
              onPress={() => setAttempt((value) => value + 1)}
            />
          </>
        )}

        {profileState === 'ready' && publication !== null && (
          <View style={styles.profile} testID="mypage-profile">
            <Text style={[styles.name, { color: tokens.text }]} testID="mypage-profile-name" allowFontScaling>
              {publication.displayName}
            </Text>
            <Text style={[styles.userId, { color: tokens.muted }]} testID="mypage-profile-userid" allowFontScaling>
              {publication.userIdText ?? '—'}
            </Text>
            <Text style={[styles.body, { color: tokens.text }]} testID="mypage-profile-introduction" allowFontScaling>
              {publication.introduction !== null && publication.introduction !== ''
                ? publication.introduction
                : '自己紹介はありません'}
            </Text>
            <Text style={[styles.body, { color: tokens.muted }]} testID="mypage-profile-avatar" allowFontScaling>
              {publication.avatarPath !== null ? 'プロフィール画像: 設定済み' : 'プロフィール画像: 未設定'}
            </Text>
          </View>
        )}

        {pendingSaves > 0 && (
          <StatusNotice
            tone="info"
            title={`変更予定が送信待ちです（${String(pendingSaves)}件）`}
            message="公開中の内容はまだ変わりません。編集画面で内容と送信状態を確認できます。"
            testID="mypage-pending-notice"
          />
        )}

        <Button
          label="プロフィールを編集"
          testID="mypage-edit-entry"
          accessibilityHint="表示名・自己紹介・プロフィール画像を編集します"
          onPress={() => router.push('/mypage/edit')}
          style={styles.entry}
        />
        <Button
          label={unfinished > 0 ? `送信状況（未完了 ${String(unfinished)}件）` : '送信状況'}
          variant="secondary"
          testID="mypage-sync-entry"
          accessibilityHint="送信待ち・結果確認中の操作を確認します"
          onPress={() => router.push('/mypage/sync')}
          style={styles.entry}
        />
        <Button
          label="テーマ"
          variant="secondary"
          testID="mypage-theme-entry"
          accessibilityHint="テーマ設定を開きます"
          onPress={() => router.push('/mypage/theme')}
          style={styles.entry}
        />
        <Button
          label={logoutBusy ? 'ログアウト中…' : 'ログアウト'}
          variant="secondary"
          testID="mypage-logout"
          accessibilityHint="アカウントからログアウトします。送信中の操作と未送信の操作を確認してから実行します"
          busy={logoutBusy}
          disabled={logoutBusy}
          onPress={() => void startLogout()}
          style={styles.entry}
        />

        {logoutSummary !== null && (
          <View style={styles.confirm} testID="mypage-logout-confirm">
            <StatusNotice
              tone="info"
              title="ログアウトしますか？"
              message={logoutSummaryMessage(logoutSummary)}
              testID="mypage-logout-confirm-message"
            />
            <Button
              label="ログアウトする"
              testID="mypage-logout-confirm-yes"
              accessibilityHint="確認してログアウトを実行します"
              onPress={() => answerLogout(true)}
              style={styles.entry}
            />
            <Button
              label="キャンセル"
              variant="secondary"
              testID="mypage-logout-confirm-no"
              accessibilityHint="ログアウトを中止します"
              onPress={() => answerLogout(false)}
              style={styles.entry}
            />
          </View>
        )}

        {logoutNotice !== null && (
          <StatusNotice
            tone={logoutNotice.tone}
            title={logoutNotice.title}
            message={logoutNotice.message}
            testID={logoutNotice.testID}
          />
        )}
      </View>
    </Screen>
  );
}

/**
 * spec 106: explain 未送信 and 送信中・結果確認中 SEPARATELY before the
 * confirmation — 送信中 may already be established on the server.
 */
function logoutSummaryMessage(summary: UnsentSummary): string {
  const lines: string[] = [];
  lines.push(
    summary.unsent > 0
      ? `送信待ち ${String(summary.unsent)}件はこの端末で破棄されます。`
      : '送信待ちの操作はありません。',
  );
  if (summary.inFlight > 0) {
    lines.push(
      `送信中・結果確認中 ${String(summary.inFlight)}件は成立済みの可能性があります。`,
    );
  }
  lines.push(
    'ログアウトするとこの端末のアカウントデータは削除され、次回ログインでサーバーの最新状態を取得します。',
  );
  return lines.join(' ');
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.s3,
    paddingVertical: spacing.s5,
  },
  title: {
    fontSize: typography.sizes.title,
    fontWeight: typography.weights.semibold,
  },
  profile: {
    alignItems: 'center',
    gap: spacing.s1,
    paddingHorizontal: spacing.s4,
  },
  name: {
    fontSize: typography.sizes.bodyLarge,
    fontWeight: typography.weights.semibold,
  },
  userId: {
    fontSize: typography.sizes.small,
  },
  body: {
    fontSize: typography.sizes.body,
    textAlign: 'center',
    lineHeight: typography.sizes.body * typography.lineHeightRatio,
  },
  placeholder: {
    fontSize: typography.sizes.bodyLarge,
  },
  entry: {
    minWidth: 200,
    marginTop: spacing.s2,
  },
  confirm: {
    alignItems: 'center',
    gap: spacing.s2,
    paddingHorizontal: spacing.s4,
  },
});
