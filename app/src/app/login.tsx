import { Redirect } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useState } from 'react';

import { useAuth } from '../auth/provider';
import type { OAuthProvider } from '../auth/session';
import { useTheme } from '../theme/provider';
import type { ThemeTokens } from '../theme/tokens';

// Task 10: login screen.
//
// Apple / Google only (global constraint — no email/password form exists,
// so email signup cannot be used from the app). A cancelled browser session
// or a network failure never loses state: the screen keeps the provider the
// user attempted, shows the reason, and offers 再試行 which re-attempts the
// same provider without re-asking the user to choose. Registration input is
// preserved separately by the account-scoped draft (register.tsx).

type Notice =
  | { kind: 'cancelled'; message: string }
  | { kind: 'failed'; message: string; retryable: boolean }
  | null;

export default function LoginScreen() {
  const auth = useAuth();
  // Task 11: themed — colours come from the resolved scheme, so the screen
  // stays readable in both light and dark.
  const { tokens } = useTheme();
  const styles = makeStyles(tokens);
  const [pending, setPending] = useState<OAuthProvider | null>(null);
  // Kept after an attempt finishes so cancel/failure can offer 再試行 for
  // the SAME provider without asking the user to choose again.
  const [lastProvider, setLastProvider] = useState<OAuthProvider | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  // Already signed in: the guard decides register vs home.
  if (auth.status === 'ready' && auth.accountId !== null) {
    return (
      <Redirect href={auth.registration === 'registered' ? '/home' : '/register'} />
    );
  }

  const attempt = async (provider: OAuthProvider): Promise<void> => {
    setPending(provider);
    setLastProvider(provider);
    setNotice(null);
    const result = await auth.signIn(provider);
    setPending(null);
    if (result.status === 'cancelled') {
      setNotice({
        kind: 'cancelled',
        message: 'ログインをキャンセルしました。',
      });
    } else if (result.status === 'failed') {
      setNotice({
        kind: 'failed',
        message: result.message,
        retryable: result.retryable,
      });
    }
    // authenticated → the context refresh flips the Redirect above.
  };

  const retry = (): void => {
    if (lastProvider !== null && pending === null) void attempt(lastProvider);
  };

  if (auth.status === 'error') {
    return (
      <View style={styles.container} testID="login-error">
        <Text style={styles.title}>ログインできません</Text>
        <Text style={styles.notice}>{auth.error ?? '設定を確認してください。'}</Text>
        <TouchableOpacity testID="login-retry-config" onPress={() => void auth.refresh()}>
          <Text style={styles.retry}>再試行</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>ログイン</Text>
      <Text style={styles.subtitle}>Apple または Google でログインします。</Text>

      <TouchableOpacity
        testID="login-apple"
        style={styles.button}
        disabled={pending !== null}
        onPress={() => void attempt('apple')}
      >
        <Text style={styles.buttonLabel}>Appleでログイン</Text>
      </TouchableOpacity>

      <TouchableOpacity
        testID="login-google"
        style={styles.button}
        disabled={pending !== null}
        onPress={() => void attempt('google')}
      >
        <Text style={styles.buttonLabel}>Googleでログイン</Text>
      </TouchableOpacity>

      {notice !== null && (
        <View style={styles.noticeBox} testID="login-notice">
          <Text style={styles.notice}>
            {notice.kind === 'cancelled'
              ? notice.message
              : `通信に失敗しました: ${notice.message}`}
          </Text>
          {notice.kind === 'cancelled' || notice.retryable ? (
            <TouchableOpacity testID="login-retry" onPress={retry}>
              <Text style={styles.retry}>再試行</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </View>
  );
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
    title: {
      fontSize: 20,
      fontWeight: '600',
      color: tokens.text,
    },
    subtitle: {
      fontSize: 14,
      color: tokens.muted,
      marginBottom: 8,
    },
    button: {
      width: '100%',
      maxWidth: 320,
      borderWidth: 1,
      borderColor: tokens.line,
      borderRadius: 8,
      paddingVertical: 12,
      alignItems: 'center',
      backgroundColor: tokens.surface,
    },
    buttonLabel: {
      fontSize: 16,
      color: tokens.text,
    },
    noticeBox: {
      gap: 8,
      alignItems: 'center',
      marginTop: 8,
    },
    notice: {
      fontSize: 14,
      color: tokens.muted,
      textAlign: 'center',
    },
    retry: {
      fontSize: 16,
      fontWeight: '600',
      textDecorationLine: 'underline',
      color: tokens.text,
    },
  });
