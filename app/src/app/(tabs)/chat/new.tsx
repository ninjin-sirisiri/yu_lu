import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../../auth/provider';
import { listFriends, type ProfileDetail } from '../../../backend/queries';
import { conversationEntry } from '../../../navigation/conversationEntry';
import { useTheme } from '../../../theme/provider';
import { spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';

export default function NewChatScreen() {
  const router = useRouter();
  const auth = useAuth();
  const { tokens } = useTheme();
  const [state, setState] = useState<{ account: string | null; items: ProfileDetail[]; cursor: string | null; loaded: boolean }>({ account: null, items: [], cursor: null, loaded: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const locked = useRef(false);
  const account = auth.accountId;
  const load = useCallback(async (cursor: string | null = null) => {
    if (!account || locked.current) return;
    const g = generation.current;
    locked.current = true; setBusy(true); setError(false);
    try {
      const page = await listFriends(cursor);
      if (generation.current !== g) return;
      // The server list is friendship-only. Keep a defensive gate so pending
      // requests can never become a new-chat entry even after stale transport.
      const items = page.items.filter(p => p.relationship === 'friend' && p.userId !== account);
      setState(old => ({ account, items: [...new Map([...(cursor && old.account === account ? old.items : []), ...items].map(p => [p.userId, p])).values()], cursor: page.nextCursor, loaded: true }));
    } catch { if (generation.current === g) setError(true); }
    finally { if (generation.current === g) { locked.current = false; setBusy(false); } }
  }, [account]);
  useFocusEffect(useCallback(() => {
    generation.current++; locked.current = false;
    setState({ account, items: [], cursor: null, loaded: false });
    void load();
    return () => { generation.current++; locked.current = false; };
  }, [account, load]));
  const visible = state.account === account ? state : { items: [], cursor: null, loaded: false };
  return <Screen title="友達を選ぶ" scroll contentStyle={styles.content}>
    <Text allowFontScaling style={[styles.text, { color: tokens.muted }]}>今日の対象者でなくても、すべての友達と会話できます。</Text>
    {visible.items.map(friend => <View key={friend.userId}>
      <Button label={friend.displayName} variant="secondary" accessibilityHint={`${friend.userIdText}との会話を開きます`}
        onPress={() => router.push(conversationEntry(friend.userId, 'chat'))} />
    </View>)}
    {busy && <Text allowFontScaling style={[styles.text, { color: tokens.muted }]}>友達を読み込み中…</Text>}
    {error && <Button label="友達の取得を再試行" variant="secondary" onPress={() => void load(visible.cursor)} />}
    {!busy && !error && visible.loaded && !visible.items.length && <Text allowFontScaling style={[styles.text, { color: tokens.muted }]}>友達がいません。友達になると会話できます。</Text>}
    {visible.cursor && !error && <Button label="友達をさらに表示" busy={busy} variant="secondary" onPress={() => void load(visible.cursor)} />}
  </Screen>;
}
const styles = StyleSheet.create({ content: { gap: spacing.s4 }, text: { fontSize: typography.sizes.body, lineHeight: typography.sizes.body * typography.lineHeightRatio } });
