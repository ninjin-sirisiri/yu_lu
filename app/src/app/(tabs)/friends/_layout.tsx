import { Stack } from 'expo-router';

// The friends area owns a stack so destinations such as the add-friends
// screen stay inside the 友達 tab instead of becoming extra tabs.
export default function FriendsLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: '友達' }} />
      <Stack.Screen name="add" options={{ title: '友達追加' }} />
    </Stack>
  );
}
