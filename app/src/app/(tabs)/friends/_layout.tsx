import { Stack } from 'expo-router';

import { AdaptiveLayoutProvider } from '../../../navigation/AdaptiveLayout';

// The friends area owns a stack so destinations such as the add-friends
// screen stay inside the 友達 tab instead of becoming extra tabs.
//
// Task 12: the stack is wrapped in ONE AdaptiveLayoutProvider so the
// selected profile (and therefore the split/single detail pane) survives
// screen changes and the ≥900 ⇄ single layout switch
// (選択中の相手・入力を保持する). [userId] takes the INTERNAL user uuid —
// the same id the DTOs and get_profile use.
export default function FriendsLayout() {
  return (
    <AdaptiveLayoutProvider>
      <Stack>
        <Stack.Screen name="index" options={{ title: '友達' }} />
        <Stack.Screen name="add" options={{ title: '友達追加' }} />
        <Stack.Screen name="[userId]" options={{ title: 'プロフィール' }} />
      </Stack>
    </AdaptiveLayoutProvider>
  );
}
