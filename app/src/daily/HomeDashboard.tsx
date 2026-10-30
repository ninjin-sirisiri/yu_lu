import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';
import { profileImageUrl } from '../backend/profile';
import { useAppearanceScope } from '../appearance/provider';
import type { RepositorySession } from '../messages/repository';
import { useChat } from '../messages/provider';
import type { ChatListRow } from '../messages/chatListRows';
import { useLayoutMetrics } from '../navigation/AdaptiveLayout';
import { scrollRefToTop, subscribeTabReselect } from '../navigation/tabReselect';
import { useTheme } from '../theme/provider';
import { radius, spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import { dailyProgress } from './progress';

const replyLabels = { reply_needed: '必要', waiting: 'メッセージ待ち', achieved: '完了' };
function TargetAvatar({ row }: { row: ChatListRow }) {
  const chat = useChat();
  const { tokens } = useTheme();
  const owner = chat?.session;
  const path = row.peer.avatar_path;
  const [image, setImage] = useState<{ owner: RepositorySession; path: string; uri: string } | null>(null);
  useEffect(() => {
    let alive = true;
    if (owner && path) void (async () => {
      if (!await owner.active() || !alive) return;
      const uri = await profileImageUrl(path);
      const active = await owner.active();
      if (uri && active && alive) setImage({ owner, path, uri });
    })().catch(() => { /* Private/offline image: keep the initials fallback. */ });
    return () => { alive = false; };
  }, [owner, path]);
  const uri = image?.owner === owner && image?.path === path ? image?.uri : null;
  return uri ? <Image testID={`home-avatar-${row.peer_id}`} source={{ uri }} style={styles.avatar} accessible={false}
    importantForAccessibility="no" onError={() => setImage(null)} /> :
    <View style={[styles.avatar, { backgroundColor: tokens.avatar }]} accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Text style={[styles.heading, { color: tokens.avatarInk }]}>{Array.from(row.peer.display_name)[0] ?? ''}</Text>
    </View>;
}
function TargetCard({ row, current, onOpen }: { row: ChatListRow; current: boolean; onOpen(peerId: string): void }) {
  const { tokens } = useTheme();
  const hero = row.roles.send;
  const replyNeeded = row.roles.reply && row.reply_state === 'reply_needed';
  const label = !current ? '会話を開く' : replyNeeded ? '返信する' : hero && !row.send_completed ? '話しかける' : '会話を続ける';
  return <View testID={`home-target-${row.peer_id}`} style={[styles.card, { backgroundColor: tokens.soft, borderColor: tokens.line }]}>
    {current && hero && <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>今日、話しかける相手</Text>}
    <View style={styles.identity}>
      {hero && <TargetAvatar row={row} />}
      <Text accessibilityRole="header" allowFontScaling style={[hero ? styles.person : styles.heading, styles.name, { color: tokens.text }]}>{row.peer.display_name}</Text>
    </View>
    {current && <>
      {hero && <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>
        {row.send_completed ? '今日のひとことは届きました。このまま、会話の続きを。' : '最近あったこと、ふと思い出したこと。今日は、ひとこと話しかけてみよう。'}
      </Text>}
      {hero && <Text allowFontScaling style={[styles.body, { color: tokens.text }]}>{`送信：${row.send_completed ? '完了' : '未完了'}`}</Text>}
      {row.roles.reply && <Text allowFontScaling style={[styles.body, { color: tokens.text }]}>
        {hero ? `返信：${row.reply_state ? replyLabels[row.reply_state] : '確認中'}` : row.reply_state === 'achieved' ? '達成済み' : row.reply_state === 'reply_needed' ? '返信が必要' : 'メッセージ待ち'}
      </Text>}
    </>}
    {!row.can_send && <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>現在この相手には送信できません</Text>}
    <Button label={label} accessibilityLabel={`${row.peer.display_name}：${label}`} variant={hero && current ? 'primary' : 'secondary'} onPress={() => onOpen(row.peer_id)} />
  </View>;
}

/** Format a server instant explicitly in JST, never using the device's day or
 * timezone to relabel cached targets. server_now is the last accepted snapshot. */
function serverStamp(instant: string) {
  const value = Date.parse(instant);
  return Number.isFinite(value) ? `${new Date(value + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')}（日本時間）` : '不明';
}

export function HomeDashboard({ onOpen, onFriends, onChat }: {
  onOpen(peerId: string): void; onFriends(): void; onChat(): void;
}) {
  const chat = useChat();
  const { tokens } = useTheme();
  const appearance = useAppearanceScope();
  const personal = appearance?.role === 'personal' ? appearance : null;
  const appearanceProgress = personal?.personalProgress ?? null;
  const { mode } = useLayoutMetrics();
  const scroll = useRef<ScrollViewInstance>(null);
  useEffect(() => subscribeTabReselect('home', () => scrollRefToTop(scroll)), []);
  const snapshot = chat?.home;
  const home = snapshot?.home;
  const current = snapshot?.dayStatus === 'current';
  const progress = home ? dailyProgress(home) : null;
  const eligible = current && !!progress && progress.state !== 'unavailable';
  const stale = !!home && !current;
  const unavailable = stale || !!chat?.error;
  const targets = snapshot?.targets ?? [];
  const send = targets.filter(row => row.roles.send);
  const replies = targets.filter(row => row.roles.reply && !row.roles.send);
  const participation = home?.participation;
  return <Screen title="今日のつながり" scroll scrollViewRef={scroll} testID="home-dashboard" contentStyle={styles.content}>
    {personal && (appearanceProgress ? <View testID="home-personal-growth" style={styles.growth}>
      <Text testID="home-personal-current" allowFontScaling style={[styles.body, { color: personal.visual?.text ?? tokens.text }]}>
        {appearanceProgress.copy.current}
      </Text>
      <Text testID="home-personal-stage" allowFontScaling style={[styles.body, { color: personal.visual?.mutedText ?? tokens.muted }]}>
        {appearanceProgress.copy.stage}
      </Text>
      <Text testID="home-personal-next" allowFontScaling style={[styles.body, { color: personal.visual?.mutedText ?? tokens.muted }]}>
        {appearanceProgress.copy.next}
      </Text>
    </View> : <Text testID="home-personal-checking" allowFontScaling style={[styles.body, { color: personal.visual?.mutedText ?? tokens.muted }]}>
      見た目を確認中
    </Text>)}
    {home && <>
      <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>{`対象日：${home.daily_key}（日本時間）`}</Text>
      <View style={[styles.summary, { borderColor: tokens.line }]}>
        <Text allowFontScaling style={[styles.heading, { color: tokens.text }]}>
          {`${home.streak}日 ${stale ? '前回の記録' : home.streak ? 'つづいています' : 'ここからはじまる'}`}
        </Text>
        {eligible ? <View style={styles.section}>
          <Text allowFontScaling style={[styles.body, { color: tokens.text }]}>{`送信 ${progress?.send === 'complete' ? '完了' : progress?.send === 'not_applicable' ? '対象なし' : '未完了'}`}</Text>
          <Text allowFontScaling style={[styles.body, { color: tokens.text }]}>{`返信 ${progress?.replyCompleted} / ${progress?.replyTotal}人`}</Text>
        </View> : <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>{stale ? '前回取得分の記録です' : participation === 'checking' ? '今日の達成判定は保留中です' : '今日は達成判定の対象外'}</Text>}
      </View>
      <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>{`前回取得（サーバー時刻）：${serverStamp(home.server_now)}`}</Text>
    </>}
    {!home && !chat?.error && <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>今日の相手を読み込み中…</Text>}
    {unavailable && <View style={styles.section}>
      <Text accessibilityRole="header" allowFontScaling style={[styles.heading, { color: tokens.text }]}>今日の相手を確認できません</Text>
      <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>最新でない可能性があります。取得済みの会話と下書きはそのまま使えます。</Text>
      <Button label="最新の状態を再取得" variant="secondary" onPress={() => chat?.refresh()} />
    </View>}
    {eligible && <>
      {(progress?.state === 'achieved' || progress?.state === 'actionable_complete') && <View style={[styles.card, { backgroundColor: tokens.accentSoft, borderColor: tokens.line }]}>
        <Text allowFontScaling style={[styles.heading, { color: tokens.text }]}>{progress.state === 'achieved' ? '今日のつながりを達成' : '今できることは完了'}</Text>
        <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>{progress.state === 'achieved' ? '今日も、ひとことがつながりました。' : '相手からのメッセージ待ちです。届いたら返信しましょう。'}</Text>
      </View>}
    </>}
    {current && !eligible && <View style={[styles.card, { backgroundColor: tokens.soft, borderColor: tokens.line }]}>
      <Text accessibilityRole="header" allowFontScaling style={[styles.heading, { color: tokens.text }]}>
        {participation === 'no_friends' ? '最初の友達と、つながろう' : participation === 'waiting_next_cycle' ? '次の抽選から参加' : participation === 'draw_failed' ? '今日は相手を選べませんでした' : '今日の相手を確認中'}
      </Text>
      <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>
        {participation === 'no_friends' ? '友達を追加すると、次の抽選から毎日、話しかける相手が決まります。' : participation === 'draw_failed' ? '連続日数はそのままです。友達とはいつでも会話できます。' : participation === 'waiting_next_cycle' ? '今日の割り当てはありません。次の抽選を待つ間も、友達とは自由に話せます。' : 'サーバーで抽選結果を確認しています。確定まで達成判定は保留します。友達とはいつでも会話できます。'}
      </Text>
    </View>}
    {(eligible || stale) && <View style={styles.section}>
      {stale && <Text accessibilityRole="header" allowFontScaling style={[styles.heading, { color: tokens.text }]}>{`前回の対象者（${home?.daily_key}）`}</Text>}
      <View testID="home-target-columns" style={[styles.columns, { flexDirection: mode === 'split' ? 'row' : 'column' }]}>
        <View style={[styles.column, mode === 'split' && styles.splitColumn]}>{send.map(row => <TargetCard key={row.peer_id} row={row} current={eligible} onOpen={onOpen} />)}</View>
        <View style={[styles.column, mode === 'split' && styles.splitColumn]}>
          {eligible && <Text accessibilityRole="header" allowFontScaling style={[styles.heading, { color: tokens.text }]}>あなたからの返信</Text>}
          {eligible && home?.reply_total === 0 && <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>今日は返信対象なし</Text>}
          {replies.map(row => <TargetCard key={row.peer_id} row={row} current={eligible} onOpen={onOpen} />)}
        </View>
      </View>
    </View>}
    <Button label="友達と話す" variant="secondary" onPress={onChat} />
    <Button label="友達を追加" variant="ghost" onPress={onFriends} />
    <Text allowFontScaling style={[styles.body, { color: tokens.muted }]}>次の更新・締切は翌朝4:00（日本時間）</Text>
  </Screen>;
}
const styles = StyleSheet.create({
  content: { gap: spacing.s5 }, section: { gap: spacing.s3 }, columns: { gap: spacing.s5, alignItems: 'stretch' },
  growth: { gap: spacing.s1 },
  column: { gap: spacing.s3, minWidth: 0 }, splitColumn: { flex: 1 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 }, name: { flexShrink: 1 },
  avatar: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  summary: { borderBottomWidth: 1, paddingBottom: spacing.s4, gap: spacing.s3 },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.s4, gap: spacing.s3 },
  body: { fontSize: typography.sizes.body, lineHeight: typography.sizes.body * typography.lineHeightRatio },
  heading: { fontSize: typography.sizes.bodyLarge, fontWeight: typography.weights.semibold, lineHeight: typography.sizes.bodyLarge * typography.lineHeightRatio },
  person: { fontSize: typography.sizes.heading, fontWeight: typography.weights.semibold, lineHeight: typography.sizes.heading * typography.lineHeightRatio },
});
