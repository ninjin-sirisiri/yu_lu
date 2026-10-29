import { Stack } from 'expo-router';

export default function ChatLayout() {
  return <Stack>
    <Stack.Screen name="index" options={{ title: 'チャット', headerShown: false }} />
    <Stack.Screen name="new" options={{ title: '新しいチャット' }} />
  </Stack>;
}
