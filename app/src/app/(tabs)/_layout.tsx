import { Redirect, Tabs } from 'expo-router';
import { Text, View } from 'react-native';

import { useAuth } from '../../auth/provider';

// Smartphones get a bottom tab bar with exactly four tabs:
// ホーム / チャット / 友達 / マイページ
//
// The tab shell is a guarded area: signed-out users are sent to login and
// signed-in-but-unregistered users to register (未登録ガード — ID確定前は通常
// 画面に入れない). While the session state is still resolving the shell waits
// instead of flashing either destination.

export default function TabLayout() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text>読み込み中…</Text>
      </View>
    );
  }
  if (auth.status === 'error') {
    // The entry route owns the retry UI; the shell never guesses a session.
    return <Redirect href="/" />;
  }
  if (auth.accountId === null) {
    return <Redirect href="/login" />;
  }
  if (auth.registration !== 'registered') {
    return <Redirect href="/register" />;
  }

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
