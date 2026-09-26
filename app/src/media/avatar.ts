import { requireNonEmpty, type Storage } from '../storage/database';
import { readDraft, saveDraft } from '../storage/drafts';
import type { FileSystemPort, ImageReference, ImageStore } from '../storage/files';
import { MAX_IMAGE_BYTES, validImageSize } from './images';

/**
 * Profile avatar pipeline (Task 16): pick result → validate → orient →
 * square-fit → 1024 cap → white composite → JPEG → persistent commit → draft.
 *
 * The pipeline is pure orchestration: every native stage arrives through
 * {@link AvatarOps} and storage through the existing {@link ImageStore} /
 * {@link FileSystemPort} ports, so `avatar.test.ts` exercises the whole flow
 * over a real SQLite database and a real file system without touching a
 * native module. `AvatarPicker.tsx` supplies the device implementation
 * (expo-image-manipulator + an SVG white-composite render).
 *
 * Invariants:
 * - The 10MB / JPEG・PNG・HEIC rule applies to the PICKED SOURCE file
 *   (`media/images.ts`); the output is always a ≤1024×1024 JPEG.
 * - Orientation is normalized by the platform decoder in the `decode` stage
 *   (see `AvatarOps.decode`), before any geometry is computed, so an EXIF
 *   rotation can never change the square crop.
 * - JPEG encoding never sees transparency: `flattenOntoWhite` composites the
 *   image over an opaque white background FIRST (JPEG conversion alone is
 *   platform-defined — typically black — and is explicitly not assumed).
 * - The file is committed by `ImageStore.importImage` (stage-then-move, no
 *   partial file, no reference without its bytes) BEFORE the draft may
 *   reference it; if the draft write then fails, the committed file is
 *   rolled back. A processing or disk failure therefore leaves the previous
 *   draft and its image untouched (ディスク不足・処理失敗では旧下書きを保持).
 * - An OS cancel (`source === null`) is a result value, never an error, and
 *   performs no read, write or delete at all.
 */

/** Output cap: the JPEG is never larger than 1024×1024 on either side. */
export const AVATAR_MAX_DIMENSION = 1024;
/** JPEG quality for the committed avatar (implementation parameter, not a spec value). */
export const AVATAR_JPEG_QUALITY = 0.9;
/** Extension forced on the committed file (the pipeline always emits JPEG). */
export const AVATAR_JPEG_EXTENSION = 'jpg';
/** Draft key holding the UNPUBLISHED avatar selection of the profile editor. */
export const AVATAR_DRAFT_KEY = 'profile.avatar';
/** Working directory (under the document root) for composite output files. */
export const AVATAR_WORK_SEGMENTS = ['images', '.avatar-work'] as const;

export const AVATAR_PROCESSING_FAILED =
  '画像の処理に失敗しました。もう一度お試しください。';
export const AVATAR_DRAFT_FAILED =
  '下書きを保存できなかったため、画像は保存されませんでした。もう一度お試しください。';

/** Formats accepted for the picked source (mirrors the server's upload rule). */
export type AvatarSourceFormat = 'jpeg' | 'png' | 'heic';

export type AvatarRejectionCode = 'format' | 'size' | 'unreadable';

export interface PickedAvatarSource {
  /** URI of the file the picker returned (already square-cropped by the OS). */
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
  /** Size of the SOURCE file; when absent the file system is asked. */
  fileSize?: number | null;
}

/** An intermediate (or final) image produced by a pipeline stage. */
export interface AvatarImage {
  uri: string;
  width: number;
  height: number;
}

/**
 * Centered square crop + output size that keeps the image within
 * {@link AVATAR_MAX_DIMENSION}. Never upscales; the crop stays inside the
 * source because the origin is derived from the same `min(width, height)`.
 */
export interface AvatarGeometry {
  originX: number;
  originY: number;
  /** Side length of the square crop (the smaller source edge). */
  cropSize: number;
  outWidth: number;
  outHeight: number;
}

export function fitAvatarGeometry(
  width: number,
  height: number,
  maxDimension: number = AVATAR_MAX_DIMENSION,
): AvatarGeometry {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('image dimensions must be positive');
  }
  const cropSize = Math.min(width, height);
  return {
    originX: Math.floor((width - cropSize) / 2),
    originY: Math.floor((height - cropSize) / 2),
    cropSize,
    outWidth: Math.min(cropSize, maxDimension),
    outHeight: Math.min(cropSize, maxDimension),
  };
}

/**
 * Native image stages. Implementations MUST:
 * - `decode`: load through the platform decoder, which normalizes EXIF
 *   orientation into pixel data (iOS: expo-image-manipulator's
 *   ImageFixOrientationTransformer; Android: the picker already baked the
 *   rotation and stripped the Orientation tag, and Glide — the loader behind
 *   loadImageForManipulationFromURL — applies any remaining EXIF rotation),
 *   then save as PNG and report the REAL resulting dimensions. Everything
 *   downstream derives geometry from these numbers, never from the picker's
 *   reported size.
 * - `fit`: center-crop with the given geometry and resize to its output size.
 * - `flattenOntoWhite`: composite the (possibly transparent) image over an
 *   opaque WHITE background — this is the only stage allowed to make the
 *   image opaque, and it must run before JPEG encoding.
 * - `encodeJpeg`: encode to JPEG at the requested quality.
 * Every stage that creates a file must return its URI so the pipeline can
 * delete intermediates on success AND on failure.
 */
export interface AvatarOps {
  decode(sourceUri: string): Promise<AvatarImage>;
  fit(image: AvatarImage, geometry: AvatarGeometry): Promise<AvatarImage>;
  flattenOntoWhite(image: AvatarImage): Promise<AvatarImage>;
  encodeJpeg(image: AvatarImage, quality: number): Promise<AvatarImage>;
}

export interface AvatarProcessDeps {
  ops: AvatarOps;
  store: ImageStore;
  fs: FileSystemPort;
}

export interface AvatarDraftBody {
  /** The staged, unpublished image; `null` means "no image selected". */
  avatar: ImageReference | null;
}

export type AvatarApplyResult =
  /** OS cancel: not an error, nothing was read, written or deleted. */
  | { status: 'canceled' }
  /** Source rejected before any processing (format / size / unreadable). */
  | { status: 'rejected'; code: AvatarRejectionCode; message: string }
  /** Processing, disk or draft failure; the previous draft is intact. */
  | { status: 'failed'; message: string }
  /** File committed AND the draft now references it (both or neither). */
  | { status: 'committed'; reference: ImageReference; width: number; height: number };

// ---------------------------------------------------------------------------
// Source validation (format + 10MB boundary on the picked file)
// ---------------------------------------------------------------------------

const MIME_FORMATS: Record<string, AvatarSourceFormat> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/png': 'png',
  'image/x-png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/heic-sequence': 'heic',
  'image/heif-sequence': 'heic',
};

const EXTENSION_FORMATS: Record<string, AvatarSourceFormat> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  heic: 'heic',
  heif: 'heic',
};

function normalizeMime(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const mime = value.split(';')[0].trim().toLowerCase();
  return mime.length > 0 ? mime : null;
}

function extensionOf(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const clean = value.split('?')[0].split('#')[0];
  const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const name = clean.slice(lastSlash + 1);
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Accepts JPEG/PNG/HEIC by MIME type; when the picker reports no MIME type
 * the file name (then the URI) extension decides. A reported-but-unknown MIME
 * type is authoritative — a `.gif` renamed to `.jpg` is still not accepted.
 */
export function detectAvatarFormat(
  source: Pick<PickedAvatarSource, 'mimeType' | 'fileName' | 'uri'>,
): AvatarSourceFormat | null {
  const mime = normalizeMime(source.mimeType);
  if (mime !== null) return MIME_FORMATS[mime] ?? null;
  return EXTENSION_FORMATS[extensionOf(source.fileName)] ??
    EXTENSION_FORMATS[extensionOf(source.uri)] ??
    null;
}

export interface AvatarSourceProblem {
  code: AvatarRejectionCode;
  message: string;
}

/**
 * Format and size checks against the SOURCE file. The 10MB boundary is
 * inclusive (exactly 10MB passes, one byte more fails) and mirrors
 * `validImageSize` so client wording and server rule stay one number.
 */
export function validateAvatarSource(
  source: Pick<PickedAvatarSource, 'mimeType' | 'fileName' | 'uri'>,
  sizeBytes: number,
): AvatarSourceProblem | null {
  if (detectAvatarFormat(source) === null) {
    return {
      code: 'format',
      message: 'プロフィール画像はJPEG・PNG・HEIC形式の画像を選べます。',
    };
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return {
      code: 'unreadable',
      message: '画像ファイルを読み込めませんでした。もう一度選択してください。',
    };
  }
  if (!validImageSize(sizeBytes) || sizeBytes > MAX_IMAGE_BYTES) {
    return {
      code: 'size',
      message: 'プロフィール画像は10MB以下にしてください。',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Draft (下書き) access — the avatar reference the profile editor restores
// ---------------------------------------------------------------------------

function avatarWorkDirectory(fs: FileSystemPort): string {
  return fs.join(fs.documentRoot, ...AVATAR_WORK_SEGMENTS);
}

/** Removes leftover composite files of previously failed runs. */
export function clearAvatarWork(fs: FileSystemPort): void {
  const directory = avatarWorkDirectory(fs);
  if (fs.exists(directory)) fs.removeDirectory(directory);
}

/** Writes the draft so it can only ever reference an already-committed file. */
export async function saveAvatarDraft(
  db: Storage,
  accountId: string,
  reference: ImageReference | null,
  updatedAt?: number,
): Promise<void> {
  const body: AvatarDraftBody = { avatar: reference };
  await saveDraft(db, accountId, AVATAR_DRAFT_KEY, body, updatedAt);
}

/**
 * Reads the staged avatar. A corrupt/unexpected body degrades to `null`
 * (no image staged) instead of crashing the editor, and never invents a
 * reference that is not in the draft.
 */
export async function readAvatarDraft(
  db: Storage,
  accountId: string,
): Promise<ImageReference | null> {
  const record = await readDraft<AvatarDraftBody>(db, accountId, AVATAR_DRAFT_KEY);
  const avatar = record?.body?.avatar;
  if (
    avatar === null || avatar === undefined ||
    typeof avatar !== 'object' ||
    typeof (avatar as ImageReference).relativePath !== 'string'
  ) {
    return null;
  }
  return avatar as ImageReference;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function sourceSizeBytes(source: PickedAvatarSource, fs: FileSystemPort): number {
  if (typeof source.fileSize === 'number' && source.fileSize > 0) {
    return source.fileSize;
  }
  return fs.size(source.uri);
}

/**
 * Runs pick result → validate → decode/orient → square-fit → white composite
 * → JPEG → persistent commit → draft save. See the module comment for the
 * ordering guarantees (commit before draft, rollback on draft failure, temps
 * cleaned in every path, cancel touches nothing).
 */
export async function applyAvatarSelection(
  db: Storage,
  accountId: string,
  source: PickedAvatarSource | null,
  deps: AvatarProcessDeps,
): Promise<AvatarApplyResult> {
  requireNonEmpty('accountId', accountId);

  // OS cancel: no error, no deletion, previous draft untouched (all of which
  // follows from returning before any read/write/delete below).
  if (source === null) return { status: 'canceled' };

  const problem = validateAvatarSource(source, sourceSizeBytes(source, deps.fs));
  if (problem !== null) {
    return { status: 'rejected', code: problem.code, message: problem.message };
  }

  const created: string[] = [];
  const track = (image: AvatarImage): AvatarImage => {
    created.push(image.uri);
    return image;
  };

  try {
    // Remember the previously staged image so a successful replacement can
    // reclaim its file (only after the new draft is saved — see below).
    const previous = await readAvatarDraft(db, accountId);

    // Orientation first: every later measurement comes from this result.
    const decoded = track(await deps.ops.decode(source.uri));
    const geometry = fitAvatarGeometry(decoded.width, decoded.height);
    const fitted = track(await deps.ops.fit(decoded, geometry));
    // White composite BEFORE JPEG: transparency must never reach the encoder.
    const flattened = track(await deps.ops.flattenOntoWhite(fitted));
    const jpeg = track(await deps.ops.encodeJpeg(flattened, AVATAR_JPEG_QUALITY));
    if (jpeg.width > AVATAR_MAX_DIMENSION || jpeg.height > AVATAR_MAX_DIMENSION) {
      return { status: 'failed', message: AVATAR_PROCESSING_FAILED };
    }

    // Commit first: importImage stages, verifies and moves the bytes, so the
    // reference only exists when the file does (no dangling reference).
    const reference = await deps.store.importImage(accountId, jpeg.uri, {
      extension: AVATAR_JPEG_EXTENSION,
    });
    try {
      await saveAvatarDraft(db, accountId, reference);
    } catch {
      // Draft write failed: roll the committed file back so the state stays
      // "old draft + old image" with no orphan the draft could reference.
      try {
        await deps.store.removeImage(reference);
      } catch {
        // Best effort; an orphan file is tolerable, a dangling draft is not.
      }
      return { status: 'failed', message: AVATAR_DRAFT_FAILED };
    }
    // The draft now points at the new file; the old staged file (if any) is
    // no longer referenced and can be reclaimed. Best effort: a leftover
    // file is storage noise, not a consistency problem.
    if (previous !== null && previous.imageId !== reference.imageId) {
      try {
        await deps.store.removeImage(previous);
      } catch {
        // Ignore; account deletion removes the whole directory anyway.
      }
    }
    return { status: 'committed', reference, width: jpeg.width, height: jpeg.height };
  } catch {
    // Processing/disk failure (disk full, decoder error, truncated copy…):
    // nothing was written to the draft, so the previous draft and its image
    // remain exactly as they were.
    return { status: 'failed', message: AVATAR_PROCESSING_FAILED };
  } finally {
    // Temp cleanup on success and failure alike; the committed file is a
    // COPY, so removing the JPEG temp never touches the stored reference.
    for (const uri of created) {
      try {
        if (deps.fs.exists(uri)) deps.fs.removeFile(uri);
      } catch {
        // Leftovers are reclaimed by clearAvatarWork on the next run.
      }
    }
  }
}

export interface AvatarDiscardResult {
  status: 'cleared';
  /** The staged image that was removed — never the published one. */
  removed: ImageReference | null;
}

/**
 * 削除: drops the staged (unpublished) image from the draft without touching
 * the previously published image. The draft row is cleared BEFORE the file is
 * deleted, so a deletion failure can at worst leave an orphan file — never a
 * draft that points at a missing file.
 */
export async function discardAvatarDraft(
  db: Storage,
  accountId: string,
  store: ImageStore,
): Promise<AvatarDiscardResult> {
  requireNonEmpty('accountId', accountId);
  const current = await readAvatarDraft(db, accountId);
  if (current === null) return { status: 'cleared', removed: null };
  await saveAvatarDraft(db, accountId, null);
  try {
    await store.removeImage(current);
  } catch {
    // Orphan file at worst; the draft no longer references it.
  }
  return { status: 'cleared', removed: current };
}
