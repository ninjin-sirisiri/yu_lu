import { Redirect, Tabs } from 'expo-router';
import { Text, View } from 'react-native';

import { useAuth } from '../../auth/provider';
import { LeftNav, useLayoutMetrics } from '../../navigation/AdaptiveLayout';
import { useTheme } from '../../theme/provider';

// Smartphones get a bottom tab bar with exactly four tabs:
// ホーム / チャット / 友達 / マイページ
//
// Wide windows (logical width ≥ 900, text scaling still fitting) swap the
// bottom bar for the left vertical navigation; routes, tab order and screen
// state are identical in both modes, so the switch never changes which
// screen is open or loses its input (Global Constraints). The two-pane
// list/detail arrangement itself is rendered by screens through
// <AdaptiveLayout> — NOT through expo-router's iOS-only alpha SplitView.
//
// The tab shell is a guarded area: signed-out users are sent to login and
// signed-in-but-unregistered users to register (未登録ガード — ID確定前は通常
// 画面に入れない). While the session state is still resolving the shell waits
// instead of flashing either destination.

export default function TabLayout() {
  const auth = useAuth();
  const { mode } = useLayoutMetrics();
  const { tokens } = useTheme();

  if (auth.status === 'loading') {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens.surface,
        }}
      >
        <Text style={{ fontSize: 16, color: tokens.muted }}>読み込み中…</Text>
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

  // NOTE: an array (not a Fragment) — expo-router reads `Tabs.Screen`
  // configurations from the navigator's direct children, and a Fragment would
  // hide them, dropping titles and testIDs.
  const screens = [
    <Tabs.Screen
      key="home"
      name="home"
      options={{ title: 'ホーム', tabBarButtonTestID: 'tab-home' }}
    />,
    <Tabs.Screen
      key="chat"
      name="chat"
      options={{ title: 'チャット', tabBarButtonTestID: 'tab-chat' }}
    />,
    <Tabs.Screen
      key="friends"
      name="friends"
      options={{ title: '友達', tabBarButtonTestID: 'tab-friends' }}
    />,
    <Tabs.Screen
      key="mypage"
      name="mypage"
      options={{ title: 'マイページ', tabBarButtonTestID: 'tab-mypage' }}
    />,
  ];

  if (mode === 'split') {
    return (
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: tokens.surface }}>
        <LeftNav />
        <View style={{ flex: 1 }}>
          <Tabs screenOptions={{ tabBarStyle: { display: 'none' } }}>{screens}</Tabs>
        </View>
      </View>
    );
  }

  return <Tabs>{screens}</Tabs>;
}
