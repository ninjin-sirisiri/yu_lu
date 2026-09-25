import { Redirect } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { peekDestination, resolveEntry } from '../navigation/entry';
import { useAuth } from '../auth/provider';
import { useTheme } from '../theme/provider';
import type { ThemeTokens } from '../theme/tokens';

// Task 10: the root route decides where the app opens.
//
// Cold start (no remembered destination) and warm resume (process alive,
// destination remembered by navigation/entry.ts) both run through the pure
// resolveEntry — the Router only performs the redirect it returns.

export default function Index() {
  const auth = useAuth();
  // Task 11: themed shell (readable in both schemes).
  const { tokens } = useTheme();
  const styles = makeStyles(tokens);

  if (auth.status === 'loading') {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>読み込み中…</Text>
      </View>
    );
  }

  if (auth.status === 'error') {
    return (
      <View style={styles.container} testID="entry-error">
        <Text style={styles.message}>{auth.error ?? '起動状態を取得できません。'}</Text>
        <TouchableOpacity testID="entry-retry" onPress={() => void auth.refresh()}>
          <Text style={styles.retry}>再試行</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const destination = peekDestination();
  const decision = resolveEntry({
    phase: destination === null ? 'cold' : 'warm',
    auth: auth.accountId === null ? 'signedOut' : 'signedIn',
    registration: auth.registration === 'loading' ? 'loading' : auth.registration,
    destination,
  });

  if (decision.kind === 'wait') {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>読み込み中…</Text>
      </View>
    );
  }

  return <Redirect href={decision.path} />;
}

const makeStyles = (tokens: ThemeTokens) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      padding: 16,
      backgroundColor: tokens.surface,
    },
    message: {
      fontSize: 16,
      textAlign: 'center',
      color: tokens.text,
    },
    retry: {
      fontSize: 16,
      fontWeight: '600',
      textDecorationLine: 'underline',
      color: tokens.text,
    },
  });
