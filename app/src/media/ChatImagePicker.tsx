import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat, type ImageManipulatorContext } from 'expo-image-manipulator';
import type { Storage } from '../storage/database';
import { readChatDraft } from '../storage/chat';
import { createImageStore, expoFileSystemPort, type FileSystemPort, type ImageReference, type ImageStore } from '../storage/files';
import type { ChatDraft } from '../messages/types';
import { useTheme } from '../theme/provider';
import { spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { StatusNotice } from '../ui/StatusNotice';
import { applyChatImageSelection, CHAT_IMAGE_FAILED, CHAT_IMAGE_LIMIT, removeChatDraftImage,
  type ChatImageOps, type ChatRaster } from './chatImages';

async function renderImage(uri: string, transform: ((context: ImageManipulatorContext) => void) | null,
  format: SaveFormat, compress: number): Promise<ChatRaster> {
  const context = ImageManipulator.manipulate(uri);
  try {
    transform?.(context);
    const image = await context.renderAsync();
    try {
      const saved = await image.saveAsync({ format,compress });
      return { uri:saved.uri,width:image.width,height:image.height };
    } finally { image.release(); }
  } finally { context.release(); }
}

/** SDK57 contextual API. iOS applies ImageFixOrientationTransformer when
 * loading (including local HEIC); Android's image loader applies EXIF through
 * Glide. Geometry is measured AFTER that decode, never from picker metadata.
 * No crop, extent or white composite: PNG transparency stays in its pixels. */
export function createDeviceChatImageOps(): ChatImageOps {
  return {
    decode:uri => renderImage(uri,null,SaveFormat.PNG,1),
    encode:(image,size,format,quality) => renderImage(image.uri,context => {
      if (image.width !== size.width || image.height !== size.height) context.resize(size);
    },format === 'png' ? SaveFormat.PNG : SaveFormat.JPEG,quality),
  };
}
const deviceOps = createDeviceChatImageOps();
export interface ChatImagePickerProps {
  db: Storage;
  accountId: string;
  peerId: string;
  disabled?: boolean;
  onChange?: (draft: ChatDraft) => void;
  fs?: FileSystemPort;
  store?: ImageStore;
  ops?: ChatImageOps;
}

/** Scope changes remount the local previews and revoke any outstanding picker
 * or processing result. The parent still owns account/logout authorization. */
export function ChatImagePicker(props: ChatImagePickerProps) {
  return <ScopedChatImagePicker key={JSON.stringify([props.accountId,props.peerId])} {...props} />;
}
function ScopedChatImagePicker({ db,accountId,peerId,disabled = false,onChange,
  fs = expoFileSystemPort,store:givenStore,ops = deviceOps }: ChatImagePickerProps) {
  const { tokens } = useTheme();
  const store = useMemo(() => givenStore ?? createImageStore({ fs }),[givenStore,fs]);
  const [images,setImages] = useState<ImageReference[]>([]);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string | null>(null);
  const [loadFailed,setLoadFailed] = useState(false);
  const [reload,setReload] = useState(0);
  const alive = useRef(true), locked = useRef(false), enabled = useRef(!disabled);
  enabled.current = !disabled;
  useEffect(() => {
    alive.current = true; setLoading(true); setLoadFailed(false);
    let current = true;
    void readChatDraft(db,accountId,peerId).then(draft => {
      if (current) { setImages(draft?.attachments ?? []); setError(null); }
    }).catch(() => {
      if (current) { setError(CHAT_IMAGE_FAILED); setLoadFailed(true); }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; alive.current = false; };
  },[db,accountId,peerId,reload]);
  const isCurrent = () => alive.current && enabled.current;
  async function pick() {
    if (loading || locked.current || !isCurrent() || images.length >= CHAT_IMAGE_LIMIT) return;
    locked.current = true; setBusy(true);
    try {
      // Library-only, original/current representation, no cropping or broad
      // camera/media permission request. OS selectionLimit is only UX; the
      // business pipeline independently enforces the four-image total.
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes:['images'],allowsEditing:false,
        allowsMultipleSelection:true,selectionLimit:CHAT_IMAGE_LIMIT - images.length,orderedSelection:true,
        quality:1,exif:false,base64:false,legacy:false,
        preferredAssetRepresentationMode:ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current });
      if (!isCurrent() || result.canceled) return;
      const applied = await applyChatImageSelection(db,accountId,peerId,result.assets,{ fs,store,ops,isCurrent });
      if (!isCurrent()) return;
      if (applied.status === 'committed') {
        setImages(applied.draft.attachments); setError(null); onChange?.(applied.draft);
      } else if (applied.status === 'failed') setError(applied.message);
    } catch { if (alive.current) setError(CHAT_IMAGE_FAILED); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function remove(imageId: string) {
    if (loading || locked.current || !isCurrent()) return;
    locked.current = true; setBusy(true);
    try {
      const draft = await removeChatDraftImage(db,accountId,peerId,imageId);
      if (isCurrent()) {
        setImages(draft?.attachments ?? []); setError(null); if (draft) onChange?.(draft);
      }
    } catch { if (alive.current) setError(CHAT_IMAGE_FAILED); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  return <View style={styles.section}>
    <Text accessibilityRole="header" allowFontScaling style={[styles.heading,{ color:tokens.text }]}>添付画像</Text>
    <Text allowFontScaling accessibilityLiveRegion="polite" style={[styles.help,{ color:tokens.muted }]}>
      {loading ? '画像を読み込み中…' : `${images.length} / 4枚 · JPEG・PNG・HEIC、各10MiB以下`}
    </Text>
    <View style={styles.previews}>
      {images.map((image,index) => <View key={image.imageId} style={[styles.preview,{ borderColor:tokens.line }]}>
        <Image accessible accessibilityRole="image" accessibilityLabel={`添付画像 ${index + 1}`}
          source={{ uri:store.resolvePath(image) }} resizeMode="contain" style={styles.image} />
        <Button label="解除" variant="ghost" accessibilityLabel={`添付画像 ${index + 1}を解除`}
          disabled={disabled || loading || busy || loadFailed} onPress={() => void remove(image.imageId)} />
      </View>)}
    </View>
    <Button label="ライブラリから画像を追加" variant="secondary" busy={busy}
      disabled={disabled || loading || loadFailed || images.length >= CHAT_IMAGE_LIMIT} onPress={() => void pick()} />
    {busy && <Text allowFontScaling accessibilityLiveRegion="polite" style={[styles.help,{ color:tokens.muted }]}>画像を準備しています…</Text>}
    {error && <StatusNotice tone="error" title="画像を保存できませんでした" message={error} />}
    {loadFailed && <Button label="再読み込み" disabled={disabled} onPress={() => setReload(value => value + 1)} />}
  </View>;
}
const styles = StyleSheet.create({
  section:{ gap:spacing.s3 },
  heading:{ fontSize:typography.sizes.body,fontWeight:typography.weights.semibold },
  help:{ fontSize:typography.sizes.body },
  previews:{ flexDirection:'row',flexWrap:'wrap',gap:spacing.s3 },
  preview:{ flexBasis:144,flexGrow:1,maxWidth:'100%',gap:spacing.s2,borderWidth:1,padding:spacing.s2 },
  image:{ width:'100%',height:144 },
});
