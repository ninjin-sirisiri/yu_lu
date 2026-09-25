import { Tabs } from 'expo-router';

// Smartphones get a bottom tab bar with exactly four tabs:
// ホーム / チャット / 友達 / マイページ
export default function TabLayout() {
  return (
    <Tabs>
      <Tabs.Screen
        name="home"
        options={{ title: 'ホーム', tabBarButtonTestID: 'tab-home' }}
      />
      <Tabs.Screen
        name="chat"
        options={{ title: 'チャット', tabBarButtonTestID: 'tab-chat' }}
      />
      <Tabs.Screen
        name="friends"
        options={{ title: '友達', tabBarButtonTestID: 'tab-friends' }}
      />
      <Tabs.Screen
        name="mypage"
        options={{ title: 'マイページ', tabBarButtonTestID: 'tab-mypage' }}
      />
    </Tabs>
  );
}
