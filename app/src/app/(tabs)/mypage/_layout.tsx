import { Stack } from 'expo-router';

// The mypage area owns a stack so the theme settings, profile editor and
// conflict resolution screens stay inside the マイページ tab instead of
// becoming extra tabs (4-tab rule).
export default function MypageLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'マイページ' }} />
      <Stack.Screen name="theme" options={{ title: 'テーマ' }} />
      <Stack.Screen name="appearance" options={{ title: '見た目' }} />
      <Stack.Screen name="sync" options={{ title: '送信状況' }} />
      <Stack.Screen name="edit" options={{ title: 'プロフィール編集' }} />
      <Stack.Screen name="conflict" options={{ title: '競合の確認' }} />
    </Stack>
  );
}
