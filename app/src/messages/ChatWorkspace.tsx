import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ChatList } from './ChatList';
import { ConversationPanel } from './ConversationPanel';
import { AppearanceScope } from '../appearance/provider';
import { useChat } from './provider';
import { useLayoutMetrics } from '../navigation/AdaptiveLayout';
import { subscribeTabReselect } from '../navigation/tabReselect';
import { useTheme } from '../theme/provider';
import { spacing, typography } from '../theme/tokens';

/** Navigation/platform callbacks only; domain state stays in useChat. */
export function ChatWorkspace({ active, onNew, onOpen, onOpenSendStatus }: {
  active: boolean; onNew(): void; onOpen(peerId: string): void; onOpenSendStatus(): void;
}) {
  const chat = useChat();
  const { mode } = useLayoutMetrics();
  const { tokens } = useTheme();
  // Presentation selection is not a second repository owner. A narrow entry
  // uses the shared route; a split selection stays mounted if the window shrinks.
  const [selection, setSelection] = useState<{ account: string; peer: string } | null>(null);
  const selected = selection?.account === chat?.accountId ? selection?.peer ?? null : null;
  const split = mode === 'split';
  useEffect(() => subscribeTabReselect('chat', () => setSelection(null)), []);
  return <View style={[styles.root, { flexDirection: split ? 'row' : 'column', backgroundColor: tokens.surface }]}
    testID="chat-workspace" accessibilityLabel={split ? '一覧と会話の2列表示' : selected ? '会話の1列表示' : '一覧の1列表示'}>
    <View style={[split ? styles.list : styles.flex, !split && selected ? styles.hidden : null]}>
      <ChatList selectedPeerId={selected} onNew={onNew} onOpen={peerId => {
        if (split && chat) { setSelection({ account: chat.accountId, peer: peerId }); chat.selectPeer(peerId); }
        else onOpen(peerId);
      }} />
    </View>
    <View style={[styles.flex, !split && !selected ? styles.hidden : null, { borderColor: tokens.line }, split ? styles.detail : null]}>
      {selected ? <AppearanceScope role="conversation" peerId={selected} active={active}>
        <ConversationPanel peerId={selected} active={active} onBack={() => setSelection(null)}
          onOpenSendStatus={onOpenSendStatus} />
      </AppearanceScope> : split ?
        <Text allowFontScaling style={[styles.empty, { color: tokens.muted }]}>会話する相手を選んでください</Text> : null}
    </View>
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1 }, flex: { flex: 1 }, list: { width: 340 }, hidden: { display: 'none' },
  detail: { borderLeftWidth: 1 }, empty: { padding: spacing.s5, fontSize: typography.sizes.body, lineHeight: typography.sizes.body * typography.lineHeightRatio } });
