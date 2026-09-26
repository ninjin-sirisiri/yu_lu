import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../../auth/provider';
import {
  createFriendsRepository,
  formatLastUpdated,
  subscribeAppResume,
  subscribeFriendsChanged,
  type FriendsSnapshot,
} from '../../../requests/friendsRepository';
import { zeroFriendGuidance } from '../../../requests/zeroFriends';
import { useTheme } from '../../../theme/provider';
import { controls, radius, spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';
import { StatusNotice } from '../../../ui/StatusNotice';
import {
  AdaptiveLayout,
  useAdaptiveLayoutState,
  type LayoutMetricsInput,
} from '../../../navigation/AdaptiveLayout';
import { ProfilePanel } from './[userId]';

// Task 12: 友達一覧.
//
// The list reads through requests/friendsRepository (account-scoped cache
// + 最終更新 + keyset pages) and refreshes on app resume (復帰) and when a
// friendship is established (成立 — subscribeFriendsChanged, fired by the
// request screens). Empty / first-load / network-failure / offline stay
// distinct states; a pending request can never appear here because only
// the server's `list_friends` rows are rendered. The zero-friend guidance
// comes from the existing requests/zeroFriends module with its あとで
// action (hides the guidance for this visit; the 友達追加 entries stay).

export interface FriendsAreaProps {
  /** Window metrics override (tests); defaults to the real window. */
  metrics?: LayoutMetricsInput;
}

export function FriendsArea({ metrics }: FriendsAreaProps) {
  const { tokens } = useTheme();
  const router = useRouter();
  const auth = useAuth();
  const { selectedPeerId, selectPeer } = useAdaptiveLayoutState();

  const repository = useMemo(
    () =>
      auth.accountId === null
        ? null
        : createFriendsRepository({ storage: auth.storage, accountId: auth.accountId }),
    [auth.accountId, auth.storage],
  );

  const [snapshot, setSnapshot] = useState<FriendsSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [guidanceDismissed, setGuidanceDismissed] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (repository === null) return;
    const fresh = await repository.refresh();
    setSnapshot(fresh);
    setLoaded(true);
  }, [repository]);

  // Initial read: cached data first (最終更新付きで即表示), then the network.
  useEffect(() => {
    if (repository === null) {
      setLoaded(true);
      return;
    }
    let alive = true;
    (async () => {
      const cached = await repository.peek();
      if (!alive) return;
      if (cached !== null) setSnapshot(cached);
      const fresh = await repository.refresh();
      if (!alive) return;
      setSnapshot(fresh);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [repository, reloadKey]);

  // 復帰 (app resume) と 成立 (friendship established) で更新する.
  useEffect(() => subscribeAppResume(() => void refresh()), [refresh]);
  useEffect(() => subscribeFriendsChanged(() => void refresh()), [refresh]);

  const onLoadMore = useCallback(async (): Promise<void> => {
    if (repository === null) return;
    const next = await repository.loadMore();
    setSnapshot(next);
  }, [repository]);

  const friends = snapshot === null ? null : snapshot.friends;
  const error = snapshot === null ? null : snapshot.error;
  const firstLoadPending = !loaded && snapshot === null;
  const showZeroGuidance =
    loaded &&
    error === null &&
    friends !== null &&
    friends.length === 0 &&
    !guidanceDismissed;
  const guidance = zeroFriendGuidance();

  const list = (
    <View style={styles.listRoot} testID="friends-list">
      <View style={styles.listHeader}>
        {guidance.showAddEntries && (
          <Button
            label="友達を追加"
            testID="friends-add-entry"
            onPress={() => router.push('/friends/add')}
          />
        )}
        <Button
          label="申請を確認"
          variant="secondary"
          testID="friends-requests-entry"
          accessibilityHint="受信した申請と送信した申請を確認します"
          onPress={() => router.push('/friends/requests')}
        />
        {snapshot !== null && snapshot.fetchedAt !== null && (
          <Text
            style={[styles.updated, { color: tokens.muted }]}
            testID="friends-last-updated"
            allowFontScaling
          >
            {formatLastUpdated(snapshot.fetchedAt)}
          </Text>
        )}
      </View>

      <Text style={[styles.subtitle, { color: tokens.muted }]} allowFontScaling>
        つながっている友達を確認できます
      </Text>

      {error === 'offline' && (
        <StatusNotice
          tone="warning"
          title="オフラインのため最新情報を取得できません"
          message={
            snapshot !== null && snapshot.fetchedAt !== null
              ? '最終更新の内容を表示しています。'
              : '接続後に再試行してください。'
          }
          testID="friends-offline"
        />
      )}

      {error === 'network' && (
        <View style={styles.errorBlock}>
          <StatusNotice
            tone="error"
            title="友達一覧を読み込めませんでした"
            testID="friends-error"
          />
          <Button
            label="再試行"
            variant="secondary"
            testID="friends-retry"
            onPress={() => setReloadKey((value) => value + 1)}
          />
        </View>
      )}

      {firstLoadPending && (
        <Text style={[styles.state, { color: tokens.muted }]} testID="friends-loading">
          読み込み中…
        </Text>
      )}

      {friends !== null && friends.length > 0 && (
        <ScrollView contentContainerStyle={styles.listContent}>
          {friends.map((friend) => (
            <Pressable
              key={friend.userId}
              testID={`friend-row-${friend.userIdText}`}
              accessibilityRole="button"
              accessibilityLabel={`${friend.displayName} ${friend.userIdText}`}
              onPress={() => selectPeer(friend.userId)}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: pressed ? tokens.soft : 'transparent',
                  borderColor: tokens.line,
                },
              ]}
            >
              <View style={[styles.rowAvatar, { backgroundColor: tokens.avatar }]}>
                <Text style={[styles.rowAvatarText, { color: tokens.avatarInk }]} allowFontScaling>
                  {friend.displayName.slice(0, 1)}
                </Text>
              </View>
              <View style={styles.rowName}>
                <Text style={[styles.rowTitle, { color: tokens.text }]} allowFontScaling>
                  {friend.displayName}
                </Text>
                <Text style={[styles.rowMeta, { color: tokens.muted }]} allowFontScaling>
                  {friend.userIdText}
                </Text>
              </View>
              {friend.relationship === 'friend' && typeof friend.streak === 'number' && (
                <Text
                  style={[styles.streak, { color: tokens.text }]}
                  testID={`friend-streak-${friend.userIdText}`}
                  accessibilityLabel={`${String(friend.streak)}日継続`}
                  allowFontScaling
                >
                  {`${String(friend.streak)} 日`}
                </Text>
              )}
            </Pressable>
          ))}

          {snapshot !== null && snapshot.nextCursor !== null && (
            <Button
              label="もっと見る"
              variant="secondary"
              testID="friends-load-more"
              onPress={() => void onLoadMore()}
            />
          )}
        </ScrollView>
      )}

      {showZeroGuidance && (
        <View style={styles.zeroBlock}>
          <StatusNotice
            tone="info"
            title="友達が0人です"
            message={guidance.message}
            testID="friends-zero"
          />
          <Button
            label="あとで"
            variant="secondary"
            testID="friends-zero-later"
            onPress={() => setGuidanceDismissed(true)}
          />
        </View>
      )}
    </View>
  );

  return (
    <Screen testID="friends-screen">
      <AdaptiveLayout
        metrics={metrics}
        testID="friends-layout"
        list={list}
        detail={
          selectedPeerId === null ? null : (
            <ProfilePanel userId={selectedPeerId} onBack={() => selectPeer(null)} />
          )
        }
        emptyDetail={
          <Text style={[styles.emptyDetail, { color: tokens.muted }]} testID="friends-empty-detail">
            友達を選ぶとプロフィールを確認できます
          </Text>
        }
      />
    </Screen>
  );
}

export default function FriendsScreen() {
  return <FriendsArea />;
}

const styles = StyleSheet.create({
  listRoot: {
    flex: 1,
    gap: spacing.s3,
    paddingTop: spacing.s3,
  },
  listHeader: {
    gap: spacing.s2,
  },
  updated: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  subtitle: {
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
  listContent: {
    gap: spacing.s2,
    paddingBottom: spacing.s4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    minHeight: controls.friendRowMinHeight,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2,
  },
  rowAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowAvatarText: {
    fontSize: typography.sizes.bodyLarge,
    fontWeight: typography.weights.semibold,
  },
  rowName: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitle: {
    fontSize: typography.sizes.bodyLarge,
    fontWeight: typography.weights.semibold,
    lineHeight: typography.sizes.bodyLarge * typography.lineHeightRatio,
  },
  rowMeta: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  streak: {
    fontSize: typography.sizes.small,
    fontVariant: ['tabular-nums'],
  },
  zeroBlock: {
    gap: spacing.s2,
    paddingTop: spacing.s2,
  },
  emptyDetail: {
    fontSize: typography.sizes.body,
    textAlign: 'center',
    padding: spacing.s5,
  },
});
