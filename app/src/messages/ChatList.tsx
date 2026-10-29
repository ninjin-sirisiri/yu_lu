import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';
import { scrollRefToTop, subscribeTabReselect } from '../navigation/tabReselect';
import { useTheme } from '../theme/provider';
import { radius, spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import { queueStateLabel } from '../sync/SyncStatus';
import type { ChatListRow } from './chatListRows';
import { useChat } from './provider';

const statusLabels = { reply_needed: '返信が必要', send_needed: '送信が必要', waiting: 'メッセージ待ち', achieved: '達成済み' };
function ChatRow({ row, current, exact, selected, onOpen }: {
  row: ChatListRow; current: boolean; exact: boolean; selected: boolean; onOpen(peerId: string): void;
}) {
  const { tokens } = useTheme();
  const local = row.local;
  const localLabel = local ? [local.draft ? '下書き' : '', ...local.states.map(queueStateLabel)].filter(Boolean).join(' · ') : '';
  return <Pressable testID={`chat-row-${row.peer_id}`} accessibilityRole="button" accessibilityState={{ selected }}
    accessibilityHint="この相手との会話を開きます" onPress={() => onOpen(row.peer_id)}
    style={({ pressed }) => [styles.row, { borderColor: tokens.line, backgroundColor: selected ? tokens.accentSoft : tokens.surface, opacity: pressed ? 0.7 : 1 }]}>
    <Text allowFontScaling style={[styles.name, { color: tokens.text }]}>{row.peer.display_name}</Text>
    {current && <>
      <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>{row.roles.send && row.roles.reply ? '送信・返信の対象' : row.roles.reply ? '返信の対象' : '送信の対象'}</Text>
      {row.status && <Text allowFontScaling style={[styles.body, { color: tokens.text }]}>{statusLabels[row.status]}</Text>}
    </>}
    {(row.unread_count > 0 || !exact) && <Text allowFontScaling style={[styles.body, { color: tokens.accent }]}>
      {exact ? `未読 ${row.unread_count}件` : `未読 ${row.unread_count}件以下（同期確認中）`}
    </Text>}
    {!!localLabel && <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>
      {local?.only ? `この端末のみ · ${localLabel}` : `${localLabel}（この端末）`}
    </Text>}
    {!row.can_send && row.last_message && <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>現在この相手には送信できません</Text>}
  </Pressable>;
}

export function ChatList({ onOpen, onNew, selectedPeerId = null }: {
  onOpen(peerId: string): void; onNew(): void; selectedPeerId?: string | null;
}) {
  const chat = useChat();
  const { tokens } = useTheme();
  const scroll = useRef<ScrollViewInstance>(null);
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState(false);
  const locked = useRef(false);
  useEffect(() => subscribeTabReselect('chat', () => scrollRefToTop(scroll)), []);
  const home = chat?.home;
  const current = home?.dayStatus === 'current';
  const rows = (items: ChatListRow[], target: boolean) => items.map(row => <ChatRow key={row.peer_id} row={row}
    current={target && current} exact={home?.unreadCountsExact ?? false} selected={selectedPeerId === row.peer_id} onOpen={onOpen} />);
  async function more() {
    if (!chat || locked.current) return;
    locked.current = true; setBusy(true); setPageError(false);
    try { if (!await chat.homeRepository.loadMore()) { setPageError(true); chat.refresh(); } }
    catch { setPageError(true); }
    finally { locked.current = false; setBusy(false); }
  }
  return <Screen title="チャット" scroll scrollViewRef={scroll} testID="chat-list" contentStyle={styles.content}>
    <Button label="新しいチャット" onPress={onNew} />
    {!home?.home && <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>会話一覧を読み込み中…</Text>}
    {(chat?.error || (home && home.dayStatus !== 'current')) && <>
      <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>最新の状態を確認できていません</Text>
      <Button label="一覧を再取得" variant="secondary" onPress={() => chat?.refresh()} />
    </>}
    {chat?.pendingReadSync && <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>閲覧状態は未同期です</Text>}
    {home && !home.unreadCountsExact && <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>未読件数は同期確認中の上限です</Text>}
    {!!home?.targets.length && <View testID="chat-targets" style={styles.section}>
      <Text accessibilityRole="header" allowFontScaling style={[styles.heading, { color: tokens.text }]}>
        {current ? '今日の対象者' : `前回の対象者（${home.home?.daily_key ?? '確認中'}）`}
      </Text>
      {rows(home.targets, true)}
    </View>}
    <View testID="chat-others" style={styles.section}>
      <Text accessibilityRole="header" allowFontScaling style={[styles.heading, { color: tokens.text }]}>その他の会話</Text>
      {rows(home?.others ?? [], false)}
      {home?.home && !home.others.length && <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>その他の会話はありません。友達とはいつでも会話できます。</Text>}
    </View>
    {home?.nextCursor && <Button label={pageError ? '追加取得を再試行' : '次の20件'} variant="secondary" busy={busy} onPress={() => void more()} />}
  </Screen>;
}

const styles = StyleSheet.create({
  content: { gap: spacing.s4 }, section: { gap: spacing.s3 },
  row: { minHeight: 48, borderWidth: 1, borderRadius: radius.md, padding: spacing.s4, gap: spacing.s2 },
  name: { fontSize: typography.sizes.bodyLarge, fontWeight: typography.weights.semibold, lineHeight: typography.sizes.bodyLarge * typography.lineHeightRatio },
  heading: { fontSize: typography.sizes.bodyLarge, fontWeight: typography.weights.semibold, lineHeight: typography.sizes.bodyLarge * typography.lineHeightRatio },
  body: { fontSize: typography.sizes.body, lineHeight: typography.sizes.body * typography.lineHeightRatio },
});
