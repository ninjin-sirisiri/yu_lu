import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { exchangeCallbackUrl, parseAuthCallback } from '../../auth/oauth';
import { useAuth } from '../../auth/provider';
import { getAppClient } from '../../backend/client';
import { useTheme } from '../../theme/provider';
import type { ThemeTokens } from '../../theme/tokens';

// Task 10: OAuth callback route.
//
// Reached when the identity provider redirects back into the app via the
// registered callback URL (app://auth/callback?code=…). Two entry modes:
// - the auth session opened by login.tsx resolves in place with the callback
//   URL (handled there, not here);
// - the redirect arrives as a deep link — typically the app was killed during
//   the provider round trip and relaunched by the callback (callback中断).
//
// Only `code` / `error` params are acted on. An invitation link or a bare
// token in the URL is never exchanged (parseAuthCallback → 'none') — those
// belong to the invitation routes, not to auth. A failed exchange falls back
// to the login screen with the reason; it never fabricates a session.

type Phase = 'exchanging' | 'failed' | 'invalid';

export default function AuthCallbackScreen() {
  const params = useLocalSearchParams<{
    code?: string;
    error?: string;
    error_description?: string;
  }>();
  const auth = useAuth();
  // Task 11: themed (readable in both schemes).
  const { tokens } = useTheme();
  const styles = makeStyles(tokens);
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('exchanging');
  const [failure, setFailure] = useState<string | null>(null);
  const startedRef = useRef(false);

  // Rebuild the callback URL the way the browser would deliver it, so the
  // same parser serves both entry modes.
  const callbackUrl = (() => {
    const query = new URLSearchParams();
    if (typeof params.code === 'string') query.set('code', params.code);
    if (typeof params.error === 'string') query.set('error', params.error);
    if (typeof params.error_description === 'string') {
      query.set('error_description', params.error_description);
    }
    return `app://auth/callback?${query.toString()}`;
  })();

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const callback = parseAuthCallback(callbackUrl);
    if (callback.kind === 'none') {
      setPhase('invalid');
      return;
    }
    void (async () => {
      try {
        const result = await exchangeCallbackUrl(callbackUrl, { client: getAppClient() });
        if (result.status === 'authenticated') {
          await auth.refresh();
          return; // the redirect below routes to register or home
        }
        setFailure(result.status === 'cancelled' ? null : result.message);
        setPhase('failed');
      } catch (cause) {
        setFailure(cause instanceof Error ? cause.message : String(cause));
        setPhase('failed');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Signed in through the exchange above → entry guard picks the destination.
  if (auth.status === 'ready' && auth.accountId !== null) {
    const href = auth.registration === 'registered' ? '/home' : '/register';
    return <Redirect href={href} />;
  }

  if (phase === 'exchanging') {
    return (
      <View style={styles.container} testID="callback-busy">
        <Text style={styles.title}>ログイン処理中…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="callback-failed">
      <Text style={styles.title}>ログインを完了できませんでした</Text>
      {failure !== null && <Text style={styles.message}>{failure}</Text>}
      <Text style={styles.message}>
        {phase === 'invalid'
          ? 'ログイン用の応答がありませんでした。招待リンクは友達タブから開いてください。'
          : '通信状況を確認して、もう一度お試しください。'}
      </Text>
      <TouchableOpacity testID="callback-retry" onPress={() => router.replace('/login')}>
        <Text style={styles.link}>ログインに戻る</Text>
      </TouchableOpacity>
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
      fontSize: 18,
      fontWeight: '600',
      color: tokens.text,
    },
    message: {
      fontSize: 14,
      color: tokens.muted,
      textAlign: 'center',
      maxWidth: 320,
    },
    link: {
      fontSize: 16,
      fontWeight: '600',
      textDecorationLine: 'underline',
      color: tokens.text,
    },
  });
