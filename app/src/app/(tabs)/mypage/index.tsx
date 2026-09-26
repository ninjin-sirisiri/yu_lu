import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../../auth/provider';
import { getOwnPublication, type ProfilePublication } from '../../../backend/profile';
import { defaultIsOnline } from '../../../discovery/searchController';
import { subscribeAppResume } from '../../../requests/friendsRepository';
import { listOperations } from '../../../storage/outbox';
import { countUnfinishedOperations } from '../../../sync/SyncStatus';
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
// - ログアウト arrives with Task 20 (auth/logout.ts) and is intentionally
//   NOT linked here yet — an entry that cannot work is not shown.
// - A failed profile read degrades to a retry notice; the entries stay
//   usable either way (読み込みだけが失敗した場合でも操作は続けられる).

type ProfileLoadState = 'loading' | 'ready' | 'error';

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

  return (
    <Screen scroll testID="mypage-screen">
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
      </View>
    </Screen>
  );
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
});
