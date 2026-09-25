import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { runPersistenceProbeIfEnabled } from '../storage/persistenceProbe';

export default function RootLayout() {
  // Dev-only: runs the SQLite persistence probe when its flag file is present
  // (see src/storage/persistenceProbe.ts and docs/testing/app-foundation-friends-ui.md).
  useEffect(() => {
    void runPersistenceProbeIfEnabled();
  }, []);

  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
