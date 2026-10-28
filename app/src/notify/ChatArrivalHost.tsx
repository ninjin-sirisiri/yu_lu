import { usePathname, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChat } from '../messages/provider';
import { conversationEntry, parseConversationEntry } from '../navigation/conversationEntry';
import { useTheme } from '../theme/provider';
import { radius, spacing, typography } from '../theme/tokens';
import { blocksNotificationEntry } from './listener';

/** Foreground chat only. No OS notification API, permissions, sound, content,
 * extra event subscription or storage writer belongs to this presentation. */
export function ChatArrivalHost() {
  const chat = useChat(); const router = useRouter(); const pathname = usePathname();
  const insets = useSafeAreaInsets(); const { tokens } = useTheme();
  const arrival = chat?.arrival;
  const destination = arrival ? parseConversationEntry({ peerId: arrival.peerId }) : null;
  const active = parseConversationEntry({ peerId: pathname.split('/')[2] });
  const visible = !!arrival && !!destination && !chat?.stopped && chat?.foreground && !blocksNotificationEntry(pathname) &&
    !(pathname.startsWith('/conversations/') && active?.peerId === arrival.peerId) && chat.activePeerId !== arrival.peerId;
  useEffect(() => {
    if (!arrival || !chat) return;
    if (!visible) { chat.dismissArrival(arrival.id); return; }
    const timer = setTimeout(() => chat.dismissArrival(arrival.id), 5000);
    return () => clearTimeout(timer);
  }, [arrival, visible, chat?.dismissArrival]);
  if (!arrival || !visible || !chat) return null;
  return <View pointerEvents="box-none" style={[styles.overlay, { top: insets.top + spacing.s2,
    paddingLeft: insets.left + spacing.s3, paddingRight: insets.right + spacing.s3 }]}>
    <Pressable testID="chat-arrival-notice" accessibilityRole="button"
      accessibilityLabel={`${arrival.name}、新しいメッセージ`} accessibilityHint="この相手との会話を開きます"
      accessibilityLiveRegion="polite"
      style={({ pressed }) => [styles.notice, { backgroundColor: tokens.soft, borderColor: tokens.line, opacity: pressed ? .7 : 1 }]}
      onPress={async () => {
        // A retained callback cannot navigate using a revoked account lifetime.
        if (!await chat.session.active()) return;
        const current = chat.getSnapshot();
        if (current.stopped || !current.foreground || current.arrival?.id !== arrival.id) return;
        chat.dismissArrival(arrival.id);
        router.push(conversationEntry(arrival.peerId, 'chat'));
      }}>
      <Text allowFontScaling style={[styles.name, { color: tokens.text }]}>{arrival.name}</Text>
      <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>新しいメッセージ</Text>
    </Pressable>
  </View>;
}
const styles = StyleSheet.create({
  overlay: { position: 'absolute', left: 0, right: 0, zIndex: 11, paddingHorizontal: spacing.s3 },
  notice: { alignSelf: 'center', width: '100%', maxWidth: 560, minHeight: 48, borderWidth: 1, borderRadius: radius.md, padding: spacing.s3, gap: spacing.s1 },
  name: { fontSize: typography.sizes.body, fontWeight: typography.weights.semibold },
  body: { fontSize: typography.sizes.small },
});
