import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image as RNImage, StyleSheet, Text, View } from 'react-native';

import * as ImagePicker from 'expo-image-picker';
import {
  ImageManipulator,
  SaveFormat,
  type ImageManipulatorContext,
} from 'expo-image-manipulator';
import Svg, { Image as SvgImage, Rect } from 'react-native-svg';

import { randomId, type Storage } from '../storage/database';
import {
  createImageStore,
  expoFileSystemPort,
  type FileSystemPort,
  type ImageReference,
  type ImageStore,
} from '../storage/files';
import { useTheme } from '../theme/provider';
import { spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { StatusNotice } from '../ui/StatusNotice';
import {
  AVATAR_MAX_DIMENSION,
  applyAvatarSelection,
  clearAvatarWork,
  discardAvatarDraft,
  pngDimensionsFromBase64,
  readAvatarDraft,
  type AvatarImage,
  type AvatarOps,
} from './avatar';

// Task 16: avatar picker UI + the DEVICE implementation of the avatar
// pipeline (`avatar.ts` holds the pure, injected pipeline; this file wires it
// to the OS picker, the native stages, the draft storage and the themed UI).
//
// White background (透過は白背景): JPEG conversion is NOT trusted to produce
// a white background on either OS — transparency is composited by rendering
// the image over a white `<Rect>` in an offscreen `react-native-svg` scene
// and rasterizing it with `Svg.toDataURL` (native on iOS/Android, canvas on
// web). Only that opaque PNG is encoded to JPEG. The offscreen scene is
// always mounted (toDataURL needs a registered native view) and only carries
// an image while a composite job is running.
//
// Cancel: `launch*Async` results with `canceled: true` return before anything
// is read, written or deleted — the OS cancel path shares the pipeline's
// `canceled` result and can never clear an existing draft or image.

const COMPOSITE_TIMEOUT_MS = 15000;

const PICK_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  // Square crop in the OS UI (iOS crop is always square; the aspect pins
  // Android's crop rectangle to 1:1).
  allowsEditing: true,
  aspect: [1, 1],
  quality: 1,
};

const PICK_ERROR_MESSAGE = '画像の選択に失敗しました。もう一度お試しください。';

// ---------------------------------------------------------------------------
// Native stages (expo-image-manipulator)
// ---------------------------------------------------------------------------

async function renderManipulated(
  sourceUri: string,
  apply: ((context: ImageManipulatorContext) => void) | null,
  format: SaveFormat,
  compress: number = 1,
): Promise<AvatarImage> {
  const context = ImageManipulator.manipulate(sourceUri);
  try {
    apply?.(context);
    const rendered = await context.renderAsync();
    try {
      const saved = await rendered.saveAsync({ format, compress });
      return { uri: saved.uri, width: rendered.width, height: rendered.height };
    } finally {
      rendered.release();
    }
  } finally {
    context.release();
  }
}

/**
 * Device implementation of {@link AvatarOps}. `flattenOntoWhite` is injected
 * because it needs the mounted SVG scene (see {@link useAvatarComposite}).
 */
export function createDeviceAvatarOps(flattenOntoWhite: AvatarOps['flattenOntoWhite']): AvatarOps {
  return {
    async decode(sourceUri: string): Promise<AvatarImage> {
      // Loading through the platform decoder normalizes EXIF orientation
      // into the pixels (iOS adds ImageFixOrientationTransformer on every
      // manipulate(); Android's picker baked the rotation and stripped the
      // Orientation tag before we ever see the file). Saving as PNG keeps
      // that result lossless for the geometry stage.
      return renderManipulated(sourceUri, null, SaveFormat.PNG);
    },
    async fit(image: AvatarImage, geometry): Promise<AvatarImage> {
      const unchanged =
        geometry.originX === 0 &&
        geometry.originY === 0 &&
        geometry.cropSize === image.width &&
        geometry.cropSize === image.height &&
        geometry.outWidth === image.width &&
        geometry.outHeight === image.height;
      if (unchanged) return image;
      return renderManipulated(
        image.uri,
        (context) => {
          context.crop({
            originX: geometry.originX,
            originY: geometry.originY,
            width: geometry.cropSize,
            height: geometry.cropSize,
          });
          context.resize({ width: geometry.outWidth, height: geometry.outHeight });
        },
        SaveFormat.PNG,
      );
    },
    flattenOntoWhite,
    async encodeJpeg(image: AvatarImage, quality: number): Promise<AvatarImage> {
      return renderManipulated(image.uri, null, SaveFormat.JPEG, quality);
    },
  };
}

// ---------------------------------------------------------------------------
// White-composite scene (the drawing part of the pipeline)
// ---------------------------------------------------------------------------

interface CompositeJob {
  image: AvatarImage;
  resolve: (image: AvatarImage) => void;
  reject: (error: Error) => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export interface AvatarComposite {
  /** Stage implementation: renders `image` over white and returns the PNG file. */
  flatten: AvatarOps['flattenOntoWhite'];
  /** Must be rendered (can be anywhere in the tree) for `flatten` to work. */
  host: React.ReactNode;
}

/**
 * Owns the offscreen SVG scene used to flatten transparency onto white.
 * The rasterized PNG is written into the avatar work directory so the
 * pipeline's normal temp cleanup removes it (success and failure alike).
 */
export function useAvatarComposite(fs: FileSystemPort): AvatarComposite {
  const svgRef = useRef<Svg | null>(null);
  const jobRef = useRef<CompositeJob | null>(null);
  const [job, setJob] = useState<AvatarImage | null>(null);

  const settle = useCallback((finish: (job: CompositeJob) => void) => {
    const active = jobRef.current;
    if (active === null || active.settled) return;
    active.settled = true;
    clearTimeout(active.timer);
    jobRef.current = null;
    setJob(null);
    finish(active);
  }, []);

  const flatten = useCallback(
    (image: AvatarImage) =>
      new Promise<AvatarImage>((resolve, reject) => {
        const pending: CompositeJob = {
          image,
          resolve,
          reject,
          settled: false,
          timer: setTimeout(() => {
            settle((active) => active.reject(new Error('white composite timed out')));
          }, COMPOSITE_TIMEOUT_MS),
        };
        jobRef.current = pending;
        setJob(image);
      }),
    [settle],
  );

  const handleLoaded = useCallback(() => {
    const active = jobRef.current;
    if (active === null || active.settled) return;
    const { width, height } = active.image;
    svgRef.current?.toDataURL(
      (encoded) => {
        try {
          const base64 = String(encoded ?? '')
            .replace(/^data:image\/png;base64,/, '')
            .replace(/\s+/g, '');
          if (base64.length === 0) throw new Error('composite produced no data');
          // iOS rasterizes at the screen scale, so trust the PNG header over
          // the requested bounds; the pipeline re-applies the 1024 cap to
          // these real dimensions before encoding the JPEG.
          const actual = pngDimensionsFromBase64(base64);
          if (actual === null) throw new Error('composite is not a PNG');
          const directory = fs.join(fs.documentRoot, 'images', '.avatar-work');
          fs.ensureDirectory(directory);
          const uri = fs.join(directory, `${randomId()}.composite.png`);
          fs.writeFile(uri, base64, 'base64');
          settle((done) => done.resolve({ uri, width: actual.width, height: actual.height }));
        } catch (error) {
          settle((done) =>
            done.reject(error instanceof Error ? error : new Error('composite failed')),
          );
        }
      },
      { width, height },
    );
  }, [fs, settle]);

  // A job in flight when the picker unmounts must not hang its caller.
  useEffect(
    () => () => {
      settle((active) => active.reject(new Error('avatar composite cancelled')));
    },
    [settle],
  );

  const host = (
    <Svg
      ref={svgRef}
      width={AVATAR_MAX_DIMENSION}
      height={AVATAR_MAX_DIMENSION}
      style={styles.compositeScene}
      testID="avatar-composite"
    >
      <Rect x={0} y={0} width="100%" height="100%" fill="#FFFFFF" />
      {job !== null && (
        <SvgImage
          href={job.uri}
          x={0}
          y={0}
          width={job.width}
          height={job.height}
          preserveAspectRatio="none"
          onLoad={handleLoaded}
        />
      )}
    </Svg>
  );

  return { flatten, host };
}

// ---------------------------------------------------------------------------
// Picker component
// ---------------------------------------------------------------------------

/** Device-default store (created once per bundle, bound to the document root). */
let deviceStore: ImageStore | null = null;
function deviceImageStore(): ImageStore {
  deviceStore ??= createImageStore({ fs: expoFileSystemPort });
  return deviceStore;
}

export interface AvatarPickerProps {
  accountId: string;
  /** Account storage handle; the avatar draft lives in its `drafts` table. */
  db: Storage;
  /** Injected for tests; defaults to the device document-root store. */
  store?: ImageStore;
  fs?: FileSystemPort;
  /** Published avatar to display while the draft holds no image. */
  publishedUri?: string | null;
  /** Called after the staged image changes (committed, or cleared). */
  onChange?: (reference: ImageReference | null) => void;
  disabled?: boolean;
  testID?: string;
}

export function AvatarPicker({
  accountId,
  db,
  store,
  fs,
  publishedUri,
  onChange,
  disabled = false,
  testID = 'avatar-picker',
}: AvatarPickerProps) {
  const { tokens } = useTheme();
  const fileSystem = fs ?? expoFileSystemPort;
  const imageStore = store ?? deviceImageStore();

  const [draftRef, setDraftRef] = useState<ImageReference | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const composite = useAvatarComposite(fileSystem);
  const opsRef = useRef<AvatarOps | null>(null);
  opsRef.current ??= createDeviceAvatarOps(composite.flatten);

  // Restore the staged selection (relaunch / back navigation). A missing or
  // corrupt draft is simply "no image staged", never an error.
  useEffect(() => {
    let alive = true;
    setDraftLoaded(false);
    void readAvatarDraft(db, accountId)
      .then((reference) => {
        if (alive) setDraftRef(reference);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setDraftLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [db, accountId]);

  // Reclaim leftovers of previously failed runs (best effort, mount only).
  useEffect(() => {
    try {
      clearAvatarWork(fileSystem);
    } catch {
      // Work cleanup never blocks the screen.
    }
  }, [fileSystem]);

  const handlePick = useCallback(
    async (source: 'camera' | 'library') => {
      if (busy || disabled) return;
      setBusy(true);
      setError(null);
      try {
        let result: ImagePicker.ImagePickerResult;
        if (source === 'camera') {
          const permission = await ImagePicker.requestCameraPermissionsAsync();
          if (!permission.granted) {
            setError('カメラが許可されていないため撮影できません。端末の設定で許可してください。');
            return;
          }
          result = await ImagePicker.launchCameraAsync(PICK_OPTIONS);
        } else {
          result = await ImagePicker.launchImageLibraryAsync(PICK_OPTIONS);
        }
        // OS cancel is not an error and deletes nothing.
        if (result.canceled) return;
        const asset = result.assets[0];
        if (!asset) return;

        const outcome = await applyAvatarSelection(
          db,
          accountId,
          {
            uri: asset.uri,
            mimeType: asset.mimeType,
            fileName: asset.fileName,
            fileSize: asset.fileSize,
          },
          { ops: opsRef.current as AvatarOps, store: imageStore, fs: fileSystem },
        );
        if (outcome.status === 'committed') {
          setDraftRef(outcome.reference);
          onChange?.(outcome.reference);
        } else if (outcome.status === 'rejected' || outcome.status === 'failed') {
          setError(outcome.message);
        }
      } catch {
        setError(PICK_ERROR_MESSAGE);
      } finally {
        setBusy(false);
      }
    },
    [accountId, busy, db, disabled, fileSystem, imageStore, onChange],
  );

  const handleDiscard = useCallback(async () => {
    if (busy || disabled || !draftLoaded || draftRef === null) return;
    setBusy(true);
    try {
      const result = await discardAvatarDraft(db, accountId, imageStore);
      setDraftRef(null);
      setError(null);
      // The staged image is gone; the published image is untouched.
      onChange?.(null);
    } catch {
      setError('画像の削除に失敗しました。もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }, [accountId, db, draftLoaded, draftRef, disabled, imageStore, busy, onChange]);

  const displayUri = draftRef !== null ? imageStore.resolvePath(draftRef) : publishedUri ?? null;
  const inactive = disabled || busy;

  return (
    <View style={styles.block} testID={testID}>
      <Text style={[styles.label, { color: tokens.text }]} allowFontScaling>
        プロフィール画像
      </Text>
      <View style={styles.row}>
        {displayUri !== null ? (
          <RNImage
            source={{ uri: displayUri }}
            style={[styles.preview, { backgroundColor: tokens.avatar }]}
            testID="avatar-preview"
            accessible
            accessibilityLabel="プロフィール画像のプレビュー"
          />
        ) : (
          <View
            style={[styles.preview, { backgroundColor: tokens.avatar }]}
            testID="avatar-preview-empty"
            accessible
            accessibilityLabel="プロフィール画像は未設定です"
          />
        )}
        <View style={styles.actions}>
          <Button
            label="撮影"
            variant="secondary"
            onPress={() => void handlePick('camera')}
            busy={busy}
            disabled={disabled}
            testID="avatar-camera"
            accessibilityHint="カメラで撮影し、正方形に切り抜いて画像を設定します"
          />
          <Button
            label="画像を選択"
            variant="secondary"
            onPress={() => void handlePick('library')}
            busy={busy}
            disabled={disabled}
            testID="avatar-library"
            accessibilityHint="写真から画像を選んで正方形に切り抜きます"
          />
          <Button
            label="削除"
            variant="ghost"
            onPress={() => void handleDiscard()}
            busy={busy}
            disabled={disabled || !draftLoaded || draftRef === null}
            testID="avatar-remove"
            accessibilityHint="選択した画像を下書きから取り除きます"
          />
        </View>
      </View>
      <Text style={[styles.hint, { color: tokens.muted }]} allowFontScaling>
        10MBまでのJPEG・PNG・HEICを、白背景の最大1024×1024のJPEGに変換して保存します。
      </Text>
      {error !== null && <StatusNotice tone="error" title={error} testID="avatar-error" />}
      {composite.host}
    </View>
  );
}

const PREVIEW_SIZE = 72;

const styles = StyleSheet.create({
  block: {
    gap: spacing.s2,
  },
  label: {
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    flexWrap: 'wrap',
  },
  preview: {
    width: PREVIEW_SIZE,
    height: PREVIEW_SIZE,
    borderRadius: PREVIEW_SIZE / 2,
    borderWidth: 1,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  actions: {
    flexGrow: 1,
    gap: spacing.s2,
    minWidth: 180,
  },
  hint: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  // Always mounted, pushed completely off-layout: the native SVG view must
  // exist for toDataURL, but nothing may appear on screen.
  compositeScene: {
    position: 'absolute',
    left: -100000,
    top: -100000,
    width: AVATAR_MAX_DIMENSION,
    height: AVATAR_MAX_DIMENSION,
  },
});
