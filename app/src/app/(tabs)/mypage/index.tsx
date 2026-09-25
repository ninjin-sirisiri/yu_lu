import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../../theme/provider';
import { spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';

// マイページ is still a placeholder (profile editing lands in Task 17); the
// theme settings entry ships with Task 11 because the 4-mode theme must be
// reachable from the UI.
export default function MypageScreen() {
  const router = useRouter();
  const { tokens } = useTheme();

  return (
    <Screen>
      <View style={styles.center}>
        <Text style={[styles.title, { color: tokens.text }]}>マイページ</Text>
        <Text style={[styles.placeholder, { color: tokens.muted }]}>
          マイページは準備中です
        </Text>
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
