import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../../theme/provider';
import { spacing, typography } from '../../../theme/tokens';
import { Screen } from '../../../ui/Screen';

export default function ChatScreen() {
  const { tokens } = useTheme();
  return (
    <Screen>
      <View style={styles.center}>
        <Text style={[styles.title, { color: tokens.text }]}>チャット</Text>
        <Text style={[styles.placeholder, { color: tokens.muted }]}>準備中</Text>
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
