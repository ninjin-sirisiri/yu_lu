import type { ComponentProps } from 'react';
import { Redirect, Tabs } from 'expo-router';
import { Text, View } from 'react-native';

import { useAuth } from '../../auth/provider';
import { AppearanceScope } from '../../appearance/provider';
import { LeftNav, useLayoutMetrics } from '../../navigation/AdaptiveLayout';
import { emitTabReselect } from '../../navigation/tabReselect';
import { useTheme } from '../../theme/provider';
import { useChatUnreadBadge } from '../../messages/unreadBadge';

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

type TabScreenListeners = NonNullable<ComponentProps<typeof Tabs>['screenListeners']>;

// Task 22 (spec line 32): tapping the ALREADY-focused tab re-selects it.
// The default tab switch does nothing for a focused tab, so the press is
// intercepted here: the tab's stack pops back to its root (再選択はその
// 先頭へ戻り) and the re-select is announced so mounted lists scroll to
// their top (すでに一覧なら先頭へスクロール). An UNFOCUSED tab falls
// through to the normal switch, so the detail screen is still there when
// the user comes back (別タブから戻ると詳細画面を保持する).
const tabScreenListeners: TabScreenListeners = ({ route, navigation }) => ({
  tabPress: (event) => {
    if (!navigation.isFocused()) return; // switching tabs: default behaviour
    event.preventDefault();
    // Announce BEFORE the pop: a deeper screen (申請一覧) is still mounted
    // here and must get its scroll response before it unmounts.
    emitTabReselect(route.name);
    const state = navigation.getState();
    const active = state.routes[state.index];
    const nested = active?.state;
    if (nested?.type === 'stack' && typeof nested.key === 'string' && nested.routes.length > 1) {
      navigation.dispatch({ type: 'POP_TO_TOP', target: nested.key });
    }
  },
});

export default function TabLayout() {
  const unread = useChatUnreadBadge();
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
      options={{ title: 'チャット', tabBarButtonTestID: 'tab-chat', tabBarBadge: unread.badge, tabBarAccessibilityLabel: unread.label }}
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
      <AppearanceScope role="personal" active={auth.status === 'ready'}>
        <View style={{ flex: 1, flexDirection: 'row', backgroundColor: tokens.surface }}>
          <LeftNav />
          <View style={{ flex: 1 }}>
            <Tabs screenListeners={tabScreenListeners} screenOptions={{ tabBarStyle: { display: 'none' } }}>
              {screens}
            </Tabs>
          </View>
        </View>
      </AppearanceScope>
    );
  }

  return (
    <AppearanceScope role="personal" active={auth.status === 'ready'}>
      <Tabs screenListeners={tabScreenListeners}>{screens}</Tabs>
    </AppearanceScope>
  );
}
