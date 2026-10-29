import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { createDeviceChatImageOps } from '../media/ChatImagePicker';
import { CHAT_IMAGE_FAILED, prepareChatImage, type ChatImageDeps } from '../media/chatImages';
import { createImageStore, expoFileSystemPort } from '../storage/files';
import { useTheme } from '../theme/provider';
import { controls, focusRing, spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { StatusNotice } from '../ui/StatusNotice';
import { useChat, type ChatDraft } from './provider';
import { chatVisualLength, validateChatBody } from './text';

export const EMPTY_DRAFT: ChatDraft = { body: '', attachments: [] };

/** Shared editor for the current draft and a SEPARATE cancelled item. No API
 * for accepted-message editing exists here. All image sources are durable,
 * account-owned references created by Task5's exact processing pipeline. */
export function MessageInput({ draft, onChange, onSubmit, label = 'メッセージ', submitLabel = '送信', disabled = false, media }: {
  draft: ChatDraft; onChange(draft: ChatDraft): Promise<void>; onSubmit(): Promise<void>;
  label?: string; submitLabel?: string; disabled?: boolean;
  media?: Omit<ChatImageDeps, 'isCurrent'>;
}) {
  const chat = useChat();
  const { tokens } = useTheme();
  const deviceStore = useMemo(() => createImageStore({ fs: expoFileSystemPort }), []);
  const deviceOps = useMemo(createDeviceChatImageOps, []);
  const store = media?.store ?? deviceStore;
  const ops = media?.ops ?? deviceOps;
  const fs = media?.fs ?? expoFileSystemPort;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const lock = useRef(false), alive = useRef(true), enabled = useRef(!disabled);
  enabled.current = !disabled;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && enabled.current && !!chat && !chat.getSnapshot().stopped;
  async function action(run: () => Promise<void>) {
    if (lock.current || !current()) return;
    lock.current = true; setBusy(true); setError(null);
    try { await run(); }
    catch { if (alive.current) setError('保存できませんでした。入力を残しています。もう一度お試しください。'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function pick() {
    if (!chat || draft.attachments.length >= 4) return;
    const prepared: Awaited<ReturnType<typeof prepareChatImage>>[] = [];
    let committed = false;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false,
        allowsMultipleSelection: true, selectionLimit: 4 - draft.attachments.length, orderedSelection: true,
        quality: 1, exif: false, base64: false, legacy: false,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current });
      if (result.canceled || !current()) return;
      if (result.assets.length + draft.attachments.length > 4) throw new Error('Image limit.');
      for (const asset of result.assets) prepared.push(await prepareChatImage(chat.accountId, asset, {
        fs, store, ops, isCurrent: current,
      }));
      if (!current() || !await chat.session.active()) return;
      await onChange({ ...draft, attachments: [...draft.attachments, ...prepared.map(p => p.reference)] });
      committed = true;
    } catch { if (alive.current) setError(CHAT_IMAGE_FAILED); }
    finally {
      if (!committed) for (const p of prepared) await store.removeImage(p.reference).catch(() => undefined);
    }
  }
  const valid = validateChatBody(draft.body, draft.attachments.length);
  return <View style={styles.editor}>
    <Text allowFontScaling style={[styles.label, { color: tokens.text }]}>{label}</Text>
    <TextInput accessibilityLabel={label} multiline value={draft.body} editable={!disabled && !busy}
      allowFontScaling onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onChangeText={body => { setError(null); void onChange({ ...draft, body }).catch(() => setError('下書きを保存できませんでした。入力はそのままです。')); }}
      style={[styles.input, { color: tokens.text, borderColor: focused ? focusRing.color : tokens.line, backgroundColor: tokens.surface },
        focused && { outlineColor: focusRing.color, outlineWidth: focusRing.width, outlineStyle: 'solid' }]} />
    <Text allowFontScaling style={{ color: tokens.muted }}>{chatVisualLength(draft.body)} / 10,000文字 · 添付 {draft.attachments.length} / 4枚</Text>
    <View style={styles.images}>
      {draft.attachments.map((image, index) => <View key={image.imageId} style={styles.preview}>
        <Image source={{ uri: store.resolvePath(image) }} resizeMode="contain" style={styles.image}
          accessible accessibilityLabel={`添付画像 ${index + 1}`} />
        <Button label="解除" accessibilityLabel={`添付画像 ${index + 1}を解除`} variant="ghost" disabled={disabled || busy}
          onPress={() => void action(() => onChange({ ...draft, attachments: draft.attachments.filter(i => i.imageId !== image.imageId) }))} />
      </View>)}
    </View>
    <View style={styles.actions}>
      <Button label="ライブラリから画像を追加" variant="secondary" disabled={disabled || busy || draft.attachments.length >= 4}
        onPress={() => void action(pick)} />
      <Button label={submitLabel} busy={busy} disabled={disabled || !valid.ok} onPress={() => void action(onSubmit)} />
    </View>
    {!valid.ok && draft.body.length > 0 && <Text allowFontScaling accessibilityLiveRegion="polite" style={{ color: tokens.danger }}>
      {chatVisualLength(draft.body) > 10000 ? '本文は10,000文字以内にしてください' : '本文または画像を入力してください'}
    </Text>}
    {error && <StatusNotice tone="error" title="入力を保存できませんでした" message={error} />}
  </View>;
}

export function Composer({ peerId, canSend, media }: { peerId: string; canSend: boolean; media?: Omit<ChatImageDeps, 'isCurrent'> }) {
  const chat = useChat();
  const [draft, setDraft] = useState<ChatDraft>(EMPTY_DRAFT);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(draft);
  const readDraft = chat?.readDraft;
  useEffect(() => {
    let current = true; setReady(false);
    if (readDraft) void readDraft(peerId).then(value => {
      if (current) { latest.current = value ?? EMPTY_DRAFT; setDraft(latest.current); setReady(true); setError(false); }
    }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [peerId, readDraft, retry]);
  async function change(value: ChatDraft) {
    if (!chat) return;
    const previous = latest.current;
    latest.current = value; setDraft(value);
    const write = writes.current.catch(() => undefined).then(() => chat.setDraft(peerId, value));
    writes.current = write;
    try { await write; }
    catch (error) {
      // Failed image imports are removed by the picker. Restore their previous
      // references too, without discarding a typed body or a newer edit.
      if (latest.current === value && value.attachments !== previous.attachments) {
        latest.current = { ...value, attachments: previous.attachments };
        setDraft(latest.current);
      }
      throw error;
    }
  }
  async function send() {
    if (!chat || !canSend) return;
    await writes.current;
    await chat.getConversation(peerId).enqueueMessage({ ...latest.current, clearDraft: true });
    latest.current = EMPTY_DRAFT; setDraft(EMPTY_DRAFT);
  }
  return <View>
    <MessageInput draft={draft} onChange={change} onSubmit={send} disabled={!ready || !canSend} media={media} />
    {error && <Button label="下書きを再読み込み" onPress={() => setRetry(v => v + 1)} />}
  </View>;
}
const styles = StyleSheet.create({
  editor: { gap: spacing.s2, paddingVertical: spacing.s3 },
  label: { fontSize: typography.sizes.body, fontWeight: typography.weights.semibold },
  input: { minHeight: controls.buttonMinHeight * 2, borderWidth: 1, padding: spacing.s3,
    fontSize: typography.sizes.bodyLarge, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  images: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  preview: { flexBasis: 128, flexGrow: 1, maxWidth: '100%' }, image: { width: '100%', height: 100 },
});
