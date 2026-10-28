import React, { useEffect, useState } from 'react';
import { Image, Modal, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../theme/provider';
import { spacing } from '../theme/tokens';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import type { ConversationImageLoader } from './conversationImages';

export interface ViewedImage { messageId: string; remotePath: string }
export function ImageViewer({ peerId, image, loadImage, onClose }: {
  peerId: string; image: ViewedImage | null; loadImage: ConversationImageLoader; onClose(): void;
}) {
  const { tokens } = useTheme();
  const { width, height } = useWindowDimensions();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(false);
  const imageWidth = Math.max(1, width - spacing.s5 * 2) * (zoom ? 2 : 1);
  const imageHeight = Math.max(240, height * 0.5) * (zoom ? 2 : 1);
  useEffect(() => {
    let current = true;
    setUri(null); setFailed(false); setZoom(false);
    if (image) void loadImage(peerId, image.messageId, image.remotePath).then(value => {
      if (current) setUri(value);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [peerId, image?.messageId, image?.remotePath, loadImage, retry]);
  return <Modal testID="conversation-image-dialog" visible={!!image} onRequestClose={onClose} presentationStyle="fullScreen" animationType="none">
    <View accessibilityViewIsModal style={styles.flex} onAccessibilityEscape={onClose}>
      <Screen title="画像" headerAccessory={<Button label="閉じる" onPress={onClose} />}>
        {uri ? <ScrollView horizontal style={styles.flex} contentContainerStyle={styles.imageArea} accessibilityLabel="拡大画像">
          <ScrollView style={{ width: imageWidth }} maximumZoomScale={4} minimumZoomScale={1} centerContent>
            <Image source={{ uri }} accessibilityLabel="会話の画像" accessible resizeMode="contain"
              style={{ width: imageWidth, height: imageHeight }} />
          </ScrollView>
        </ScrollView> : <Text allowFontScaling accessibilityLiveRegion="polite" style={{ color: tokens.text }}>
          {failed ? '画像を取得できませんでした' : '画像を読み込み中…'}
        </Text>}
        {failed && <Button label="画像を再読み込み" onPress={() => setRetry(v => v + 1)} />}
        {uri && <Button label={zoom ? '画像を縮小' : '画像を拡大'} variant="secondary" onPress={() => setZoom(v => !v)} />}
      </Screen>
    </View>
  </Modal>;
}
const styles = StyleSheet.create({ flex: { flex: 1 }, imageArea: { flexGrow: 1, paddingVertical: spacing.s3 } });
