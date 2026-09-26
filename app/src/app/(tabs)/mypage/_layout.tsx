import { Stack } from 'expo-router';

// The mypage area owns a stack so the theme settings screen stays inside the
// マイページ tab instead of becoming a fifth tab (4-tab rule).
export default function MypageLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'マイページ' }} />
      <Stack.Screen name="theme" options={{ title: 'テーマ' }} />
      <Stack.Screen name="sync" options={{ title: '送信状況' }} />
    </Stack>
  );
}
