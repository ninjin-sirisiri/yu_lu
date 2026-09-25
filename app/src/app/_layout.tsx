import { Stack, usePathname } from 'expo-router';
import { useEffect } from 'react';

import { AuthProvider } from '../auth/provider';
import { rememberDestination } from '../navigation/entry';
import { runPersistenceProbeIfEnabled } from '../storage/persistenceProbe';

// Task 10: root layout.
//
// Wraps the Router in the auth context (session + registration state) and
// records the current destination on every navigation so a warm resume can
// reopen it (navigation/entry.ts). Login / register / callback paths are
// filtered by rememberDestination itself.

function DestinationRecorder() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) rememberDestination(pathname);
  }, [pathname]);
  return null;
}

export default function RootLayout() {
  // Dev-only: runs the SQLite persistence probe when its flag file is present
  // (see src/storage/persistenceProbe.ts and docs/testing/app-foundation-friends-ui.md).
  useEffect(() => {
    void runPersistenceProbeIfEnabled();
  }, []);

  return (
    <AuthProvider>
      <DestinationRecorder />
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="register" options={{ headerShown: false }} />
        <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
      </Stack>
    </AuthProvider>
  );
}
