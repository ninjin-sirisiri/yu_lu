import { Stack, useGlobalSearchParams, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Dimensions, View } from 'react-native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { AuthProvider } from '../auth/provider';
import { AvatarProbeHost } from '../media/avatarProbe';
import { AuthenticatedChatProvider } from '../messages/provider';
import { rememberDestination } from '../navigation/entry';
import { parseConversationEntry } from '../navigation/conversationEntry';
import { NotificationHost } from '../notify/NotificationHost';
import { runPersistenceProbeIfEnabled } from '../storage/persistenceProbe';
import { ThemeProvider, useTheme } from '../theme/provider';

// Task 10: root layout.
//
// Wraps the Router in the auth context (session + registration state) and
// records the current destination on every navigation so a warm resume can
// reopen it (navigation/entry.ts). Login / register / callback paths are
// filtered by rememberDestination itself.
//
// Task 11: adds the two app-level foundations —
// - SafeAreaProvider: real insets on device; the explicit zero fallback keeps
//   the provider rendering its children where no native metrics exist (jest),
//   instead of dropping the whole tree (its `initialMetrics` would be null);
// - ThemeProvider: the 4-mode theme resolves ABOVE the router so a theme
//   change never unmounts the current screen or its input, and the themed
//   root background + status bar follow the resolved scheme.
//
// Task 19: NotificationHost owns notification receipt (foreground
// suppression, the shared response path, cold-start seeding, the in-app
// notice) — it renders nothing unless a notification actually arrived, so
// every other route's behaviour is unchanged.

function DestinationRecorder() {
  const pathname = usePathname();
  const { origin } = useGlobalSearchParams();
  useEffect(() => {
    if (!pathname) return;
    const entry = pathname.startsWith('/conversations/')
      ? parseConversationEntry({ peerId: pathname.split('/')[2], origin }) : null;
    rememberDestination(entry ? `/conversations/${entry.peerId}?origin=${entry.origin}` : pathname);
  }, [pathname, origin]);
  return null;
}

const ZERO_METRICS = {
  frame: {
    x: 0,
    y: 0,
    width: Dimensions.get('window').width,
    height: Dimensions.get('window').height,
  },
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
};

function ThemedRoot() {
  const { scheme, tokens } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: tokens.surface }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <DestinationRecorder />
      {/* Dev-only: renders null unless Documents/avatar-probe.enabled exists
          (see src/media/avatarProbe.tsx, Task 16 device evidence). */}
      <AvatarProbeHost />
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="register" options={{ headerShown: false }} />
        <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
        <Stack.Screen name="invitation/[token]" options={{ headerShown: false }} />
        <Stack.Screen name="conversations/[peerId]" options={{ headerShown: false }} />
      </Stack>
      {/* Task 19: notification receipt + in-app notice. Renders null until a
          notification actually arrives, so routes/tests are unaffected. */}
      <NotificationHost />
    </View>
  );
}

export default function RootLayout() {
  // Dev-only: runs the SQLite persistence probe when its flag file is present
  // (see src/storage/persistenceProbe.ts and docs/testing/app-foundation-friends-ui.md).
  useEffect(() => {
    void runPersistenceProbeIfEnabled();
  }, []);

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics ?? ZERO_METRICS}>
      <AuthProvider>
        <AuthenticatedChatProvider>
          <ThemeProvider>
            <ThemedRoot />
          </ThemeProvider>
        </AuthenticatedChatProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
