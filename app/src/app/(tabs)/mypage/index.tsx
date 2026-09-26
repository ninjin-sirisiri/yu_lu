import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../../auth/provider';
import { subscribeAppResume } from '../../../requests/friendsRepository';
import { countUnfinishedOperations } from '../../../sync/SyncStatus';
import { useTheme } from '../../../theme/provider';
import { spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';

// マイページ is still a placeholder (profile editing lands in Task 17); the
// theme settings entry ships with Task 11 because the 4-mode theme must be
// reachable from the UI.
//
// Task 13: 送信状況 entry — the unfinished-count entry point (未完了件数).
// The count is read from the account's own outbox (送信待ち・送信中・
// 結果確認中・不成立・確認が必要), refreshed on mount and on app resume so a
// finished queue never keeps a stale badge.
export default function MypageScreen() {
  const router = useRouter();
  const auth = useAuth();
  const { tokens } = useTheme();
  const [unfinished, setUnfinished] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      const count = await countUnfinishedOperations(auth.storage, auth.accountId);
      if (alive) setUnfinished(count);
    };
    void load();
    return () => {
      alive = false;
    };
  }, [auth.storage, auth.accountId]);

  useEffect(() =>
    subscribeAppResume(() => {
      void countUnfinishedOperations(auth.storage, auth.accountId).then((count) =>
        setUnfinished(count),
      );
    }), [auth.storage, auth.accountId]);

  return (
    <Screen>
      <View style={styles.center}>
        <Text style={[styles.title, { color: tokens.text }]}>マイページ</Text>
        <Text style={[styles.placeholder, { color: tokens.muted }]}>
          マイページは準備中です
        </Text>
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
  },
  title: {
    fontSize: typography.sizes.title,
    fontWeight: typography.weights.semibold,
  },
  placeholder: {
    fontSize: typography.sizes.bodyLarge,
  },
  entry: {
    minWidth: 200,
    marginTop: spacing.s2,
  },
});
