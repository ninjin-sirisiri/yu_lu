import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../../theme/provider';
import { spacing, typography } from '../../../theme/tokens';
import { Screen } from '../../../ui/Screen';

export default function FriendsScreen() {
  const { tokens } = useTheme();
  return (
    <Screen>
      <View style={styles.center}>
        <Text style={[styles.title, { color: tokens.text }]}>友達</Text>
        <Text style={[styles.placeholder, { color: tokens.muted }]}>
          友達一覧は準備中です
        </Text>
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
    padding: spacing.s4,
  },
  title: {
    fontSize: typography.sizes.title,
    fontWeight: typography.weights.semibold,
  },
  placeholder: {
    fontSize: typography.sizes.bodyLarge,
  },
});
