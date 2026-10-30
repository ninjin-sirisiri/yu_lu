import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ChatMessagesResult } from '../backend/chat';
import { useChat } from '../messages/provider';
import { useTheme } from '../theme/provider';
import { radius, spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { StatusNotice, type StatusTone } from '../ui/StatusNotice';
import { APPEARANCE_PRESET_LIST, presetFor } from './catalog';
import {
  readChatAppearance,
  type AppearancePresetId,
} from './contracts';
import {
  OFFLINE_APPEARANCE_MESSAGE,
  PENDING_APPEARANCE_MESSAGE,
  type PendingAppearanceCommand,
  type SharedAppearanceOutcome,
} from './sharedSettings';

/**
 * Task 10: non-modal shared appearance picker.
 *
 * The confirmed query is the only source of the "current" setting. Browsing
 * samples is local-only; pressing 2人に適用 sends exactly one explicit command
 * and then refetches the confirmed query. The component never writes the
 * display cache or merely copies a command response into the UI.
 */

export interface ChatAppearancePickerProps {
  peerId: string;
  metadata: ChatMessagesResult | null;
  active: boolean;
  onClose(): void;
  onRefetch(): Promise<unknown>;
}

interface Notice {
  tone: StatusTone;
  title: string;
  message?: string;
}

const UNKNOWN_NOTICE: Notice = {
  tone: 'warning',
  title: '結果を確認できていません',
  message: '前回の変更が届いたか確認できません。「結果を確認」で同じ操作の結果を確かめてください。',
};

export function ChatAppearancePicker({
  peerId,
  metadata,
  active,
  onClose,
  onRefetch,
}: ChatAppearancePickerProps) {
  const chat = useChat();
  const controller = chat?.sharedAppearance;
  const { tokens, scheme } = useTheme();
  const read = readChatAppearance(metadata?.appearance);
  const confirmed = read.status === 'ready' ? read.value : null;

  const [choice, setChoice] = useState<AppearancePresetId | null>(null);
  const [pending, setPending] = useState<PendingAppearanceCommand | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [refetching, setRefetching] = useState(false);

  const alive = useRef(true);
  const activeRef = useRef(active);
  const peerRef = useRef(peerId);
  const busyRef = useRef(false);
  const operationGeneration = useRef(0);
  const confirmedSignature = useRef<string | null>(null);
  activeRef.current = active;
  peerRef.current = peerId;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      operationGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!active) operationGeneration.current += 1;
  }, [active]);

  const signature = confirmed
    ? `${confirmed.settingsRevision}:${confirmed.selectedPresetId ?? 'auto'}`
    : null;
  useEffect(() => {
    // A new confirmed revision (including one fetched after an apply) resets
    // the local sample choice. Simply browsing samples never changes it.
    if (!confirmed || signature === null || confirmedSignature.current === signature) return;
    confirmedSignature.current = signature;
    setChoice(confirmed.selectedPresetId);
  }, [confirmed, signature]);

  useEffect(() => {
    let live = true;
    setPending(null);
    setNotice(null);
    if (!controller) return () => { live = false; };
    void controller.pending(peerId).then(record => {
      if (!live || !alive.current || peerRef.current !== peerId) return;
      if (record) {
        setPending(record);
        setNotice(UNKNOWN_NOTICE);
      }
    }).catch(() => {
      // A broken cache row must not prevent the picker from opening.
    });
    return () => { live = false; };
  }, [controller, peerId]);

  function guard(generation: number): boolean {
    return alive.current && activeRef.current && peerRef.current === peerId &&
      operationGeneration.current === generation;
  }

  function storeIsCurrent(): boolean {
    const state = chat?.getSnapshot();
    return !!state && state.activePeerId === peerId && !state.stopped && state.foreground;
  }

  async function refetchConfirmed(generation: number): Promise<void> {
    if (!guard(generation)) return;
    setRefetching(true);
    try {
      const result = await onRefetch();
      if (!guard(generation)) return;
      if (result === false) {
        setNotice({
          tone: 'warning',
          title: '変更は受け付けられました',
          message: '確定した設定を再取得できませんでした。会話を再読み込みしてください。',
        });
      } else {
        setNotice({
          tone: 'success',
          title: '2人の設定に反映しました',
          message: '確定した設定を再取得しました。',
        });
      }
    } catch {
      if (!guard(generation)) return;
      setNotice({
        tone: 'error',
        title: '変更は受け付けられました',
        message: '確定した設定を再取得できませんでした。会話を再読み込みしてください。',
      });
    } finally {
      if (guard(generation)) setRefetching(false);
    }
  }

  async function handleOutcome(result: SharedAppearanceOutcome, generation: number): Promise<void> {
    if (!guard(generation)) return;
    switch (result.status) {
      case 'applied':
        // Never assign the command response or the local sample to the
        // confirmed display. Only the refetched query may change it.
        setPending(null);
        await refetchConfirmed(generation);
        return;
      case 'unknown':
        setPending(result.pending);
        setNotice({
          tone: 'warning',
          title: UNKNOWN_NOTICE.title,
          message: result.message ?? UNKNOWN_NOTICE.message,
        });
        return;
      case 'rejected':
        setPending(null);
        setNotice({
          tone: 'error',
          title: '変更できませんでした',
          message: result.message ?? 'この設定には変更できませんでした。',
        });
        return;
      case 'offline':
        setPending(result.pending);
        setNotice({
          tone: 'warning',
          title: 'オフラインです',
          message: result.message ?? OFFLINE_APPEARANCE_MESSAGE,
        });
        return;
      case 'blocked':
        setPending(result.pending);
        setNotice({
          tone: 'warning',
          title: '前回の結果を確認してください',
          message: result.message ?? PENDING_APPEARANCE_MESSAGE,
        });
        return;
      case 'none':
        setPending(null);
        setNotice({
          tone: 'info',
          title: '確認する変更はありません',
          message: '保留中の変更はありません。',
        });
        return;
    }
  }

  async function applySetting(presetId: AppearancePresetId | null): Promise<void> {
    if (!controller || !confirmed?.canChange || !metadata?.friendship_epoch ||
        !active || busyRef.current || pending !== null) return;
    const generation = ++operationGeneration.current;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await controller.apply({
        peerId,
        friendshipEpoch: metadata.friendship_epoch,
        presetId,
        isCurrent: storeIsCurrent,
      });
      if (!guard(generation)) return;
      await handleOutcome(result, generation);
    } catch {
      if (guard(generation)) {
        setNotice({
          tone: 'error',
          title: '変更できませんでした',
          message: '通信状態を確認して、もう一度お試しください。',
        });
      }
    } finally {
      if (guard(generation)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  async function confirmPending(): Promise<void> {
    if (!controller || !pending || !active || busyRef.current) return;
    const generation = ++operationGeneration.current;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await controller.confirm(peerId, { isCurrent: storeIsCurrent });
      if (!guard(generation)) return;
      await handleOutcome(result, generation);
    } catch {
      if (guard(generation)) {
        setNotice({
          tone: 'error',
          title: '結果を確認できませんでした',
          message: '通信状態を確認して、もう一度お試しください。',
        });
      }
    } finally {
      if (guard(generation)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  const canApply = !!confirmed?.canChange && !!metadata?.friendship_epoch &&
    active && !busy && !refetching && pending === null;
  const samplesDisabled = !active || confirmed?.canChange === false;
  const currentName = confirmed ? presetFor(confirmed.effectivePresetId).name : null;
  const automatic = confirmed?.selectedPresetId === null;

  return <ScrollView testID="chat-appearance-picker" style={styles.frame}
    contentContainerStyle={[styles.panel, { borderColor: tokens.line, backgroundColor: tokens.soft }]}
    keyboardShouldPersistTaps="handled">
    <View style={styles.heading}>
      <Text accessibilityRole="header" allowFontScaling style={[styles.title, { color: tokens.text }]}>
        チャットの見た目
      </Text>
      <Button label="閉じる" variant="ghost" testID="appearance-close" onPress={onClose} />
    </View>

    {confirmed ? <View style={styles.section}>
      <Text allowFontScaling style={[styles.body, { color: tokens.text }]}>
        {`最後の確定設定: ${currentName}${automatic ? '（自動）' : ''}`}
      </Text>
      <Text allowFontScaling style={{ color: tokens.muted }}>
        この設定は2人の会話に共有されます。
      </Text>
      <Text allowFontScaling style={{ color: tokens.muted }}>
        自動に戻すと、固定の元の割り当てに戻ります。
      </Text>
    </View> : <Text allowFontScaling style={{ color: tokens.muted }}>
      見た目を確認中です。この会話の確定した設定を取得できていません。
    </Text>}

    {confirmed?.canChange === false && <Text allowFontScaling style={[styles.body, { color: tokens.text }]}>
      この関係では見た目を変更できません。最後に確定した設定を閲覧できます。
    </Text>}

    <Text allowFontScaling style={{ color: tokens.muted }}>
      見本を選んでもまだ変更されません。「2人に適用」を押したときだけ送信します。
    </Text>

    <View style={styles.samples}>
      {APPEARANCE_PRESET_LIST.map(preset => {
        const palette = preset.palettes[scheme];
        return <View key={preset.id} style={styles.sample}>
          <View accessible={false} style={[styles.swatch, {
            backgroundColor: palette.background, borderColor: palette.accent,
          }]}>
            <View style={[styles.swatchAccent, { backgroundColor: palette.accent }]} />
            <View style={[styles.swatchPattern, { backgroundColor: palette.pattern }]} />
          </View>
          <Button
            label={preset.name}
            variant={choice === preset.id ? 'secondary' : 'ghost'}
            selected={choice === preset.id}
            disabled={samplesDisabled}
            testID={`appearance-sample-${preset.id}`}
            onPress={() => setChoice(preset.id)}
          />
        </View>;
      })}
      <Button
        label="自動（元の割り当て）"
        variant={choice === null ? 'secondary' : 'ghost'}
        selected={choice === null}
        disabled={samplesDisabled}
        testID="appearance-sample-auto"
        onPress={() => setChoice(null)}
      />
    </View>

    <View style={styles.actions}>
      <Button label="2人に適用" testID="appearance-apply" disabled={!canApply} busy={busy}
        onPress={() => void applySetting(choice)} />
      <Button label="自動に戻す" testID="appearance-auto" variant="secondary"
        disabled={!canApply} busy={busy} onPress={() => void applySetting(null)} />
    </View>

    {refetching && <Text allowFontScaling style={{ color: tokens.muted }}>変更を確認しています…</Text>}

    {pending && <View style={styles.section}>
      <Text allowFontScaling style={{ color: tokens.text }}>
        結果が確定していない変更があります。新しい設定を適用する前に結果を確認してください。
      </Text>
      <Button label="結果を確認" testID="appearance-confirm" variant="secondary"
        disabled={!active || busy} onPress={() => void confirmPending()} />
    </View>}

    {notice && <StatusNotice testID="appearance-notice" tone={notice.tone}
      title={notice.title} message={notice.message} />}
  </ScrollView>;
}

const styles = StyleSheet.create({
  frame: { flexGrow: 0, flexShrink: 1, maxHeight: '55%' },
  panel: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.s3,
    gap: spacing.s3,
  },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s2 },
  title: { fontSize: typography.sizes.title, fontWeight: typography.weights.semibold },
  section: { gap: spacing.s2 },
  body: { fontSize: typography.sizes.body, lineHeight: typography.sizes.body * typography.lineHeightRatio },
  samples: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2, alignItems: 'center' },
  sample: { gap: spacing.s1, alignItems: 'center' },
  swatch: {
    width: 48,
    height: 32,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.s1,
    justifyContent: 'space-between',
  },
  swatchAccent: { height: 5, width: '60%', borderRadius: radius.sm },
  swatchPattern: { height: 5, width: '90%', borderRadius: radius.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
});
