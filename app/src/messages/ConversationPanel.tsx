import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View, type FlatListProps } from 'react-native';
import { ChatAppearancePicker } from '../appearance/ChatAppearancePicker';
import { useAppearanceScope } from '../appearance/provider';
import { createImageStore, expoFileSystemPort } from '../storage/files';
import type { OutboxRecord } from '../storage/outbox';
import { queueStateLabel, formatSyncStamp } from '../sync/SyncStatus';
import { useTheme } from '../theme/provider';
import { spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { Screen, useScreenInsets } from '../ui/Screen';
import { StatusNotice } from '../ui/StatusNotice';
import { Composer, MessageInput } from './Composer';
import { deviceConversationImageLoader, type ConversationImageLoader } from './conversationImages';
import { ImageViewer, type ViewedImage } from './ImageViewer';
import { useChat, type ChatDraft } from './provider';
import type { RepositorySession } from './repository';
import type { AcceptedMessage } from './types';
import type { ChatImageDeps } from '../media/chatImages';

interface Viewport { offset: number; following: boolean; initialized: boolean }
// Presentation memory belongs to a provider lifetime, not another account or
// a component instance. Reparenting the SAME panel into a split layout may
// remount it; server cursors and drafts remain owned by the shared repository.
const viewports = new WeakMap<RepositorySession, Map<string, Viewport>>();
function viewportFor(session: RepositorySession, peerId: string) {
  let peers = viewports.get(session);
  if (!peers) { peers = new Map(); viewports.set(session, peers); }
  let viewport = peers.get(peerId);
  if (!viewport) { viewport = { offset: 0, following: false, initialized: false }; peers.set(peerId, viewport); }
  return viewport;
}

function CancelledEditor({ row, onClose, media }: { row: OutboxRecord; onClose(): void; media?: Omit<ChatImageDeps, 'isCurrent'> }) {
  const chat = useChat()!;
  const payload = row.payload as { body: string; images_staged?: ChatDraft['attachments'] };
  const [draft, setDraft] = useState<ChatDraft>({ body: payload.body, attachments: payload.images_staged ?? [] });
  return <View>
    <MessageInput label="取りやめたメッセージ" submitLabel="修正を保存" draft={draft} media={media}
      onChange={async value => { setDraft(value); }} onSubmit={async () => {
        await chat.getConversation(row.orderingKey!).saveCancelled(row.operationId, draft); onClose();
      }} />
    <Button label="修正を閉じる" variant="ghost" onPress={onClose} />
  </View>;
}

function LocalMessage({ row, canSend, run, media }: {
  row: OutboxRecord; canSend: boolean; run(action: () => Promise<unknown>): void;
  media?: Omit<ChatImageDeps, 'isCurrent'>;
}) {
  const chat = useChat()!;
  const peer = chat.getConversation(row.orderingKey!);
  const { tokens } = useTheme();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const payload = row.payload as { body: string; images_staged?: ChatDraft['attachments'] };
  const deviceStore = useMemo(() => createImageStore({ fs: expoFileSystemPort }), []);
  const imageStore = media?.store ?? deviceStore;
  const cancelled = row.state === 'cancelled';
  const cancellable = ((row.state === 'pending' || row.state === 'needs_confirmation') && row.reachStage === 'not_started') ||
    (row.state === 'failed_permanent' && row.reachStage === 'rejected');
  const retryable = cancelled || row.state === 'needs_confirmation' || (row.state === 'failed_permanent' && row.reachStage === 'rejected');
  return <View style={[styles.local, { borderColor: tokens.line, backgroundColor: tokens.soft }]}>
    <Text allowFontScaling style={[styles.body, { color: tokens.text }]}>{cancelled ? '本人による取りやめ' : queueStateLabel(row.state)}</Text>
    <Text allowFontScaling style={[styles.body, { color: tokens.text }]}>{payload.body}</Text>
    {(payload.images_staged ?? []).map((image, index) => <Image key={image.imageId} source={{ uri: imageStore.resolvePath(image) }}
      resizeMode="contain" style={styles.thumbnail} accessible accessibilityLabel={`未送信の添付画像 ${index + 1}`} />)}
    {row.state === 'pending' && <Text allowFontScaling style={{ color: tokens.muted }}>
      {`自動送信期限 ${formatSyncStamp(row.expiresAt)}${row.nextAttemptAt ? ` · 次の試行 ${formatSyncStamp(row.nextAttemptAt)}` : ''}`}
    </Text>}
    {(row.state === 'sent_unknown' || row.state === 'relationship_stopped') && <Text allowFontScaling style={{ color: tokens.muted }}>
      受付結果を確認できていません。未送信と断定できないため、新しい送信として再送・取りやめはできません。
    </Text>}
    {row.state === 'needs_confirmation' && <Text allowFontScaling style={{ color: tokens.muted }}>自動送信を停止しています。内容を確認して送り直してください。</Text>}
    {cancellable && <Button label="送信をやめる" variant="secondary" onPress={() => run(async () => {
      if (!await peer.cancelUnsent(row.operationId)) throw new Error('Send already started.');
    })} />}
    {cancelled && !editing && <Button label="取りやめた内容を修正" variant="secondary" onPress={() => setEditing(true)} />}
    {cancelled && editing && <CancelledEditor key={row.operationId} row={row} media={media} onClose={() => setEditing(false)} />}
    {retryable && !editing && <Button label="内容を確認して再送" disabled={!canSend} onPress={() => setConfirm(true)} />}
    {confirm && <View style={styles.section}>
      <Text allowFontScaling style={{ color: tokens.text }}>この本文と画像を新しい送信として予約します。取りやめた項目は末尾、未解決の項目は元の待機位置に入ります。</Text>
      <Button label="この内容で送り直す" disabled={!canSend} onPress={() => run(async () => { await peer.retryConfirmed(row.operationId); setConfirm(false); })} />
      <Button label="再送しない" variant="ghost" onPress={() => setConfirm(false)} />
    </View>}
    {cancelled && <Button label="取りやめた内容を破棄" variant="ghost" onPress={() => run(() => peer.discardCancelled(row.operationId))} />}
  </View>;
}

export interface ConversationPanelProps {
  peerId: string; active?: boolean; onBack?(): void; loadImage?: ConversationImageLoader;
  media?: Omit<ChatImageDeps, 'isCurrent'>;
  onOpenSendStatus?(): void;
}
export function ConversationPanel(props: ConversationPanelProps) {
  const chat = useChat();
  if (!chat || chat.stopped) return <Screen title="会話"><Text>会話を読み込み中…</Text>
    {props.onBack && <Button label="戻る" accessibilityLabel="元の画面へ戻る" onPress={props.onBack} />}</Screen>;
  return <OwnedConversationPanel key={`${chat.accountId}:${props.peerId}`} {...props} />;
}
function OwnedConversationPanel({ peerId, active = true, onBack, loadImage: injectedLoader, media, onOpenSendStatus }: ConversationPanelProps) {
  const chat = useChat()!;
  const { tokens } = useTheme();
  const scope = useAppearanceScope();
  // A conversation uses ONLY its explicit conversation scope. A surrounding
  // personal frame is never borrowed for the bubbles or header.
  const appearance = scope?.role === 'conversation' && scope.peerId === peerId ? scope : null;
  const visual = appearance?.visual ?? null;
  const growth = appearance?.conversationProgress ?? null;
  const ink = visual?.text ?? tokens.text;
  const mutedInk = visual?.mutedText ?? tokens.muted;
  const insets = useScreenInsets();
  const peer = chat.getConversation(peerId);
  const viewport = useMemo(() => viewportFor(chat.session, peerId), [chat.session, peerId]);
  const list = useRef<FlatList<AcceptedMessage>>(null);
  const [arrival, setArrival] = useState(false);
  const [image, setImage] = useState<ViewedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const locked = useRef(false);
  const visible = useRef<AcceptedMessage[]>([]);
  const previousLatest = useRef<number | null>(null);
  const firstPlacement = useRef(!viewport.initialized);
  const restored = useRef(false);
  const followRequested = useRef(false);
  const scrollRetry = useRef(0);
  // Native FlatList rejects changing this object's identity after mounting.
  // Viewport coverage also handles a long/200%-scaled message taller than the
  // entire screen, which an item-height percentage could never mark visible.
  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 50, minimumViewTime: 250 }).current;
  const owner = chat.session;
  const selectPeer = chat.selectPeer;
  useEffect(() => { if (active) selectPeer(peerId); }, [selectPeer, peerId, active]);
  const snapshot = chat.activePeerId === peerId ? chat.conversation : null;
  const messages = snapshot?.messages ?? [];
  const metadata = snapshot?.metadata;
  const enabled = active && chat.foreground && chat.activePeerId === peerId && !!snapshot && !chat.stopped && image === null;
  useEffect(() => { if (!snapshot) visible.current = []; }, [snapshot]);
  const gate = useRef({ enabled, chat, peer });
  gate.current = { enabled, chat, peer };
  const reportVisible = useRef(() => {
    const state = gate.current;
    if (!state.enabled || state.chat.getSnapshot().stopped) return;
    const ids = visible.current.filter(m => m.recipientId === state.chat.accountId).map(m => m.messageId);
    if (ids.length) void state.peer.recordVisible(ids).catch(() => setError('閲覧状態は未同期です。再試行してください。'));
  }).current;
  const viewableItemsChanged = useRef<NonNullable<FlatListProps<AcceptedMessage>['onViewableItemsChanged']>>(({ viewableItems }) => {
    visible.current = viewableItems.filter(v => v.isViewable).map(v => v.item);
    reportVisible();
  }).current;
  useEffect(() => { if (enabled) reportVisible(); }, [enabled, reportVisible]);
  const loader = useMemo<ConversationImageLoader>(() => {
    if (injectedLoader) return injectedLoader;
    // Configuration can be unavailable in cached/offline previews; the retry
    // path resolves the real authenticated client, never a public image URL.
    return (...args) => deviceConversationImageLoader(owner)(...args);
  }, [injectedLoader, owner]);
  const latest = messages.at(-1)?.sequence ?? 0;
  useEffect(() => {
    if (!metadata) return;
    if (previousLatest.current !== null && latest > previousLatest.current) {
      if (!viewport.following) setArrival(true);
      else followRequested.current = true;
    }
    previousLatest.current = latest;
  }, [latest, metadata, viewport]);
  // A withdrawal arriving while its dialog is open immediately hides bytes.
  useEffect(() => {
    if (image && !messages.some(m => m.messageId === image.messageId && !m.withdrawn && m.imagePaths.includes(image.remotePath))) setImage(null);
  }, [snapshot, image]);
  async function run(action: () => Promise<unknown>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    try { await action(); }
    catch { setError('操作を完了できませんでした。表示と入力を残しています。もう一度お試しください。'); }
    finally { locked.current = false; setBusy(false); }
  }
  const firstUnread = metadata?.first_unread_sequence;
  const unreadIndex = firstUnread === null || firstUnread === undefined ? -1 : messages.findIndex(m => m.sequence >= firstUnread);
  const initialIndex = firstPlacement.current ? Math.max(0, unreadIndex < 0 ? messages.length - 1 : unreadIndex) : undefined;
  function placeHistory() {
    if (!messages.length || !metadata) return;
    if (!restored.current) {
      restored.current = true;
      if (viewport.initialized) list.current?.scrollToOffset({ offset: viewport.offset, animated: false });
      else {
        viewport.following = unreadIndex < 0 && !metadata.after_cursor;
        list.current?.scrollToIndex({ index: initialIndex ?? 0, animated: false, viewPosition: 0 });
        viewport.initialized = true;
      }
      firstPlacement.current = false;
    } else if (followRequested.current && viewport.following && enabled) {
      followRequested.current = false;
      list.current?.scrollToEnd({ animated: false });
    }
  }
  const target = chat.home?.home?.targets.find(t => t.peer_id === peerId);
  const currentDay = chat.home?.dayStatus === 'current';
  const role = !currentDay && chat.home?.home ? `${chat.home.home.daily_key}取得分 · 今日の相手を確認できません`
    : target ? [target.roles.send ? '今日の送信相手' : '', target.roles.reply ? '今日の返信相手' : '',
      target.status === 'achieved' ? '達成済み' : target.status === 'waiting' ? 'メッセージ待ち' : target.status === 'reply_needed' ? '返信が必要'
        : target.status === 'send_needed' ? '送信が必要' : '状態を確認中'].filter(Boolean).join(' · ') : null;
  const historyHeader = <View style={styles.section}>
      {appearance && <View testID="conversation-growth" style={styles.growth}>
        {growth ? <>
          <Text testID="conversation-growth-current" allowFontScaling style={[styles.growthCurrent, { color: visual?.text ?? tokens.text }]}>
            {growth.copy.current}
          </Text>
          <Text testID="conversation-growth-stage" allowFontScaling style={{ color: mutedInk }}>
            {growth.copy.stage}
          </Text>
          <Text testID="conversation-growth-next" allowFontScaling style={{ color: mutedInk }}>
            {growth.copy.next}
          </Text>
        </> : <Text testID="conversation-growth-checking" allowFontScaling style={{ color: mutedInk }}>
          見た目を確認中
        </Text>}
      </View>}
      {(!chat.connected || chat.refreshPending || chat.error || chat.pendingReadSync || chat.home?.unreadCountsExact === false) &&
        <Text allowFontScaling accessibilityLiveRegion="polite" style={{ color: tokens.muted }}>
          同期確認中です。未読件数や履歴は最新でない可能性があります。
        </Text>}
      {error && <StatusNotice tone="error" title="再試行が必要です" message={error} />}
      <View style={styles.actions}>
        <Button label="前の50件" variant="ghost" disabled={busy || !metadata?.before_cursor} onPress={() => void run(peer.loadBefore)} />
        <Button label="次の50件" variant="ghost" disabled={busy || !metadata?.after_cursor} onPress={() => void run(peer.loadAfter)} />
        <Button label="再読み込み" variant="ghost" disabled={busy} onPress={() => chat.refresh()} />
        {onOpenSendStatus && <Button label="共通の送信状況" variant="ghost" onPress={onOpenSendStatus} />}
      </View>
    </View>;
  return <KeyboardAvoidingView testID="conversation-keyboard-frame" style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={insets.top}>
    <Screen title={metadata?.peer.display_name || '以前の友達'} subtitle={role ?? undefined} testID="conversation-panel"
      headerAccessory={<View style={styles.headerActions}>
        <Button label="チャットの見た目" variant="ghost" testID="conversation-appearance-button"
          onPress={() => setAppearanceOpen(open => !open)} />
        {onBack && <Button label="戻る" accessibilityLabel="元の画面へ戻る" variant="ghost" onPress={onBack} />}
      </View>}>
      {snapshot ? <FlatList ref={list} testID="conversation-history" data={messages} keyExtractor={m => m.messageId}
        style={styles.flex} contentContainerStyle={styles.history} initialNumToRender={50}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }} keyboardShouldPersistTaps="handled"
        onViewableItemsChanged={viewableItemsChanged} viewabilityConfig={viewabilityConfig}
        ListHeaderComponent={historyHeader}
        onContentSizeChange={placeHistory} onLayout={placeHistory}
        onScrollToIndexFailed={info => {
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          if (scrollRetry.current++ < 3) requestAnimationFrame(() => list.current?.scrollToIndex({ index: info.index, animated: false }));
        }}
        onScroll={event => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          viewport.offset = contentOffset.y;
          viewport.following = !metadata?.after_cursor && contentSize.height - layoutMeasurement.height - contentOffset.y < 48;
          if (viewport.following) setArrival(false);
        }} scrollEventThrottle={16}
        ListEmptyComponent={<Text allowFontScaling style={{ color: mutedInk }}>まだメッセージはありません</Text>}
        renderItem={({ item, index }) => {
          const day = new Date(item.acceptedAt).toLocaleDateString();
          const showDay = index === 0 || new Date(messages[index - 1].acceptedAt).toLocaleDateString() !== day;
          return <View style={styles.section}>
            {showDay && <Text allowFontScaling style={{ color: mutedInk }}>{day}</Text>}
            {item.sequence === firstUnread && <Text allowFontScaling style={{ color: mutedInk }}>ここから未読</Text>}
            <View testID={`message-bubble-${item.messageId}`}
              style={[styles.message, {
                backgroundColor: visual
                  ? (item.senderId === chat.accountId ? visual.bubbleOut : visual.bubbleIn)
                  : (item.senderId === chat.accountId ? tokens.accentSoft : tokens.soft),
              }]}>
              <Text allowFontScaling style={[styles.body, { color: ink }]}>
                {item.withdrawn ? 'このメッセージは取り消されています' : item.body}
              </Text>
              {!item.withdrawn && item.imagePaths.map((remotePath, i) => <Button key={remotePath} label={`画像 ${i + 1}を開く`}
                variant="secondary" onPress={() => setImage({ messageId: item.messageId, remotePath })} />)}
              <Text allowFontScaling style={{ color: mutedInk }}>{new Date(item.acceptedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{item.senderId === chat.accountId ? ' · 送信済み' : ''}</Text>
            </View>
          </View>;
        }}
        ListFooterComponent={<View style={styles.section}>
          {snapshot.pending.length > 1 && <Text allowFontScaling style={{ color: tokens.muted }}>同じ相手への送信は順番待ちです · 後続 {snapshot.pending.length - 1}件</Text>}
          {[...snapshot.pending, ...snapshot.cancelled].map(row => <LocalMessage key={row.operationId} row={row}
            canSend={snapshot.canSend} media={media} run={action => void run(action)} />)}
        </View>} /> : <ScrollView style={styles.flex}>{historyHeader}<Text allowFontScaling style={{ color: mutedInk }}>履歴を読み込み中…</Text></ScrollView>}
      <Button label={arrival ? '新着メッセージへ' : '最新へ'} disabled={busy || !active || !chat.foreground}
        onPress={() => void run(async () => {
          if (await peer.jumpLatest()) {
            viewport.following = true; followRequested.current = true; setArrival(false);
            list.current?.scrollToEnd({ animated: false });
          }
        })} />
      {metadata && !snapshot?.canSend && <Text allowFontScaling style={{ color: tokens.text }}>現在この相手には送信できません</Text>}
      {/* Always-mounted slot: opening the picker must not shift the composer's
          sibling position and remount the draft/input subtree. */}
      <View testID="appearance-picker-slot" style={styles.pickerSlot}>
        {appearanceOpen && <ChatAppearancePicker peerId={peerId} metadata={metadata ?? null}
          active={active && chat.foreground && chat.activePeerId === peerId && !chat.stopped}
          onClose={() => setAppearanceOpen(false)}
          onRefetch={async () => peer.loadInitial()} />}
      </View>
      <ScrollView style={styles.composer} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.section}>
        <Composer key={`${chat.accountId}:${peerId}`} peerId={peerId} canSend={snapshot?.canSend === true && active} media={media} />
      </ScrollView>
      <ImageViewer peerId={peerId} image={image && messages.some(m => m.messageId === image.messageId && !m.withdrawn &&
        m.imagePaths.includes(image.remotePath)) ? image : null} loadImage={loader} onClose={() => setImage(null)} />
    </Screen>
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  flex: { flex: 1 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s1, justifyContent: 'flex-end' },
  pickerSlot: { gap: spacing.s1 }, section: { gap: spacing.s2 }, history: { paddingVertical: spacing.s3, gap: spacing.s3 },
  growth: { gap: spacing.s1 }, growthCurrent: { fontSize: typography.sizes.bodyLarge, fontWeight: typography.weights.semibold,
    lineHeight: typography.sizes.bodyLarge * typography.lineHeightRatio },
  message: { padding: spacing.s3, gap: spacing.s2 }, local: { borderWidth: 1, padding: spacing.s3, gap: spacing.s2 },
  body: { fontSize: typography.sizes.bodyLarge, lineHeight: typography.sizes.bodyLarge * typography.lineHeightRatio },
  thumbnail: { width: '100%', height: 144 }, composer: { flexGrow: 0, flexShrink: 1, maxHeight: '55%' },
});
