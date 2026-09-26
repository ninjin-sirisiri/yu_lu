// Task 14: QR読み取り for invitations (友達追加画面のQR読み取り部品).
//
// Ownership: the ONE component that turns camera frames / saved images
// into invitation tokens:
//
// - **Camera**: `CameraView` with QR barcode settings. The camera exists
//   ONLY while `active` is true — the host unmounts it when the screen is
//   hidden (画面非表示時はカメラを停止する), which stops the session on both
//   platforms (SDK 57 docs recommend unmounting over the iOS-only `active`
//   flag).
// - **Saved image**: image picker → `Camera.scanFromURLAsync`. OS cancel is
//   NOT an error (no notice); empty / multi-invitation / invalid results
//   are EXPLAINED in the UI (複数コード・不正URL・権限拒否は申請を起こさず
//  説明する — and never an unhandled rejection).
// - **Permission denial** renders an explanation plus the image fallback
//   (spec: カメラ拒否時も画像選択・User ID検索を使える), never a crash.
//
// All outcomes are StatusNotice text states; the only success path is
// `onToken`, called exactly once per scan session (latched until the
// scanner is hidden again so a lingering preview cannot double-fire).

import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Camera, CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';

import { useTheme } from '../theme/provider';
import { radius, spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { StatusNotice } from '../ui/StatusNotice';
import { parseInvitationUrl } from './links';

/** Minimal scan result shape (a BarcodeScanningResult subset). */
export interface ScanResultLike {
  data: string;
}

export interface InvitationScannerProps {
  /** Called once with the parsed invitation token. */
  onToken: (token: string) => void;
  /** Camera runs only while the host says the screen is visible. */
  active?: boolean;
  /**
   * Saved-image scan (default `Camera.scanFromURLAsync`), injectable so
   * tests never touch the native module.
   */
  scanImage?: (uri: string) => Promise<ScanResultLike[]>;
  /**
   * Image picker returning a local uri, or null when the user cancelled
   * (OS cancellation is not an error).
   */
  pickImage?: () => Promise<string | null>;
  testID?: string;
}

type Notice = { tone: 'warning' | 'error'; title: string; message?: string } | null;

/** Default saved-image flow: pick a photo, then scan QR codes from it. */
async function defaultPickImage(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
  if (result.canceled) return null;
  const uri = result.assets?.[0]?.uri;
  return typeof uri === 'string' && uri !== '' ? uri : null;
}

async function defaultScanImage(uri: string): Promise<ScanResultLike[]> {
  return Camera.scanFromURLAsync(uri, ['qr']);
}

/**
 * Interprets the QR results of one saved image:
 * - no codes at all → 'empty'
 * - no parseable invitation among them → 'invalid'
 * - two or MORE distinct invitation tokens → 'multiple' (ambiguous, explain)
 * - exactly one invitation token → 'token' (duplicates of the SAME link
 *   count once)
 */
export function interpretScanResults(
  results: ScanResultLike[],
): { kind: 'token'; token: string } | { kind: 'empty' } | { kind: 'invalid' } | { kind: 'multiple' } {
  if (results.length === 0) return { kind: 'empty' };
  const tokens = new Set<string>();
  for (const result of results) {
    const token = parseInvitationUrl(result.data);
    if (token !== null) tokens.add(token);
  }
  if (tokens.size === 0) return { kind: 'invalid' };
  if (tokens.size > 1) return { kind: 'multiple' };
  return { kind: 'token', token: [...tokens][0] };
}

const EMPTY_NOTICE_MESSAGES: Record<'empty' | 'invalid' | 'multiple', { title: string; message: string }> = {
  empty: {
    title: 'QRコードが見つかりませんでした',
    message: '招待QRが写っている画像を選び直してください。',
  },
  invalid: {
    title: '招待リンクとして読み取れませんでした',
    message: '招待のQRコードではない画像です。元のリンクを開き直すか、User IDで検索してください。',
  },
  multiple: {
    title: '複数の招待リンクが見つかりました',
    message: '1つだけ招待QRが写っている画像を選び直してください。',
  },
};

export function InvitationScanner({
  onToken,
  active = true,
  scanImage = defaultScanImage,
  pickImage = defaultPickImage,
  testID = 'invitation-scanner',
}: InvitationScannerProps) {
  const { tokens } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [notice, setNotice] = useState<Notice>(null);
  // Latched after a token is emitted so a lingering frame cannot re-fire.
  const emittedRef = useRef(false);

  // Hidden again → the next opening is a fresh scan session.
  useEffect(() => {
    if (!active) emittedRef.current = false;
  }, [active]);

  const emit = useCallback(
    (token: string) => {
      if (emittedRef.current) return;
      emittedRef.current = true;
      onToken(token);
    },
    [onToken],
  );

  const handleScan = useCallback(
    (data: string) => {
      const token = parseInvitationUrl(data);
      if (token !== null) {
        setNotice(null);
        emit(token);
        return;
      }
      // 不正URL: explain and keep scanning — never navigate, never throw.
      setNotice({
        tone: 'warning',
        title: '招待リンクとして読み取れませんでした',
        message: '招待のQRコードをカメラに合わせてください。User ID検索でも探せます。',
      });
    },
    [emit],
  );

  const handleImageResults = useCallback(
    (results: ScanResultLike[]) => {
      const outcome = interpretScanResults(results);
      if (outcome.kind === 'token') {
        setNotice(null);
        emit(outcome.token);
        return;
      }
      const copy = EMPTY_NOTICE_MESSAGES[outcome.kind];
      setNotice({ tone: 'warning', title: copy.title, message: copy.message });
    },
    [emit],
  );

  const scanSavedImage = useCallback(async () => {
    try {
      const uri = await pickImage();
      if (uri === null) return; // OS cancel: not an error, no notice
      const results = await scanImage(uri);
      handleImageResults(results);
    } catch {
      setNotice({
        tone: 'error',
        title: '画像を読み取れませんでした',
        message: '別の画像で試すか、元のリンクを開き直してUser IDで検索してください。',
      });
    }
  }, [pickImage, scanImage, handleImageResults]);

  if (!active) return null; // screen hidden: no camera, no session

  const granted = permission?.granted === true;

  return (
    <View style={styles.root} testID={testID}>
      {permission === null && (
        <Text style={[styles.hint, { color: tokens.muted }]} testID="scanner-loading">
          カメラを準備しています…
        </Text>
      )}

      {permission !== null && !granted && (
        <StatusNotice
          tone="warning"
          title="カメラが許可されていません"
          message="許可するとQRコードを読み取れます。画像からの読み取りとUser ID検索はカメラなしでも使えます。"
          testID="scanner-permission-denied"
        />
      )}

      {granted && (
        <View style={styles.cameraBox}>
          <CameraView
            testID="scanner-camera"
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(event) => handleScan(event.data)}
          />
          <Text style={[styles.overlay, { color: tokens.muted }]} testID="scanner-hint">
            招待QRコードを枠内に合わせてください
          </Text>
        </View>
      )}

      {notice !== null && (
        <StatusNotice
          tone={notice.tone}
          title={notice.title}
          message={notice.message}
          testID="scanner-notice"
        />
      )}

      <View style={styles.actions}>
        {!granted && permission !== null && (
          <Button
            label="カメラの許可を求める"
            variant="secondary"
            testID="scanner-request-permission"
            onPress={() => {
              void requestPermission().catch(() => {
                setNotice({
                  tone: 'warning',
                  title: 'カメラを許可できませんでした',
                  message: '端末の設定から許可するか、画像から読み取ってください。',
                });
              });
            }}
          />
        )}
        <Button
          label="画像から読み取る"
          variant={granted ? 'secondary' : 'primary'}
          testID="scanner-pick-image"
          onPress={() => void scanSavedImage()}
        />
        <Text style={[styles.hint, { color: tokens.muted }]} testID="scanner-search-hint">
          読み取れないときは「User ID 検索」から相手を探せます。
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.s3,
    paddingVertical: spacing.s3,
  },
  cameraBox: {
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  camera: {
    height: 220,
    width: '100%',
  },
  overlay: {
    position: 'absolute',
    bottom: spacing.s2,
    alignSelf: 'center',
    fontSize: typography.sizes.caption,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.s2,
    paddingVertical: spacing.s1,
  },
  actions: {
    gap: spacing.s2,
  },
  hint: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
});
