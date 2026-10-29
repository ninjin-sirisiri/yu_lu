import { randomId, requireNonEmpty, safeSegment, type Storage } from '../storage/database';
import { readChatDraft, saveChatDraft } from '../storage/chat';
import type { FileSystemPort, ImageReference, ImageStore } from '../storage/files';
import type { ChatDraft } from '../messages/types';
import { stripChatImageMetadata, type ChatImageFormat } from './chatImageBytes';

export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_IMAGE_MAX_DIMENSION = 2048;
export const CHAT_IMAGE_LIMIT = 4;
export const CHAT_IMAGE_JPEG_QUALITY = 0.8;
export const CHAT_IMAGE_FAILED = '画像を保存できませんでした。元の入力はそのままです。もう一度お試しください。';

export interface PickedChatImage {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  type?: string | null;
}
export interface ChatImageSize { width: number; height: number }
export interface ChatRaster extends ChatImageSize { uri: string }
/** Native-only image processing, independent of the square/white avatar flow.
 * decode MUST normalize orientation into pixels and return actual dimensions.
 * encode resizes without a crop or background composite; PNG retains alpha. */
export interface ChatImageOps {
  decode(uri: string): Promise<ChatRaster>;
  encode(image: ChatRaster, size: ChatImageSize, format: ChatImageFormat, quality: number): Promise<ChatRaster>;
}
export interface ChatImageDeps {
  ops: ChatImageOps;
  fs: FileSystemPort;
  store: ImageStore;
  /** Scope/lease guard supplied by the mounted account/peer composer. */
  isCurrent?: () => boolean;
}
export interface PreparedChatImage extends ChatImageSize {
  reference: ImageReference;
  mimeType: 'image/jpeg' | 'image/png';
}
export type ChatImageApplyResult = { status: 'canceled' } | { status: 'failed'; message: string } |
  { status: 'committed'; draft: ChatDraft };

export function fitChatImage(width: number, height: number): ChatImageSize {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('invalid image dimensions');
  }
  const scale = Math.min(1, CHAT_IMAGE_MAX_DIMENSION / Math.max(width,height));
  return { width:Math.max(1,Math.round(width * scale)), height:Math.max(1,Math.round(height * scale)) };
}
function checkSize(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > CHAT_IMAGE_MAX_BYTES) throw new Error('image must be 10MiB or smaller');
}
function sourceFormat(b: Uint8Array): ChatImageFormat | 'heic' {
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'jpeg';
  if ([137,80,78,71,13,10,26,10].every((v,i) => b[i] === v)) return 'png';
  // HEIC's ISO-BMFF ftyp brands, not an extension or caller-asserted MIME.
  if (b.length >= 16) {
    const size = new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0);
    if (size >= 16 && size <= b.length && String.fromCharCode(...b.subarray(4,8)) === 'ftyp') {
      const brands = [String.fromCharCode(...b.subarray(8,12))];
      for (let p = 16; p + 4 <= size; p += 4) brands.push(String.fromCharCode(...b.subarray(p,p+4)));
      if (!brands.includes('avif') && !brands.includes('avis') && brands.some(v => ['heic','heix'].includes(v))) return 'heic';
    }
  }
  throw new Error('only JPEG, PNG and HEIC images are supported');
}
function guard(deps: ChatImageDeps) {
  if (deps.isCurrent && !deps.isCurrent()) throw new Error('image selection scope expired');
}
function cleanup(fs: FileSystemPort, uri: string) {
  try { if (fs.exists(uri)) fs.removeFile(uri); } catch { /* orphan, never a broken draft */ }
}

/** orient → aspect-fit → encode → inspect/scrub bytes → stage/verify/move.
 * A returned reference always has durable bytes. Caller owns it until a draft
 * or outbox reference is saved. No source file or remote object is deleted. */
export async function prepareChatImage(accountId: string, source: PickedChatImage, deps: ChatImageDeps): Promise<PreparedChatImage> {
  requireNonEmpty('accountId',accountId); requireNonEmpty('uri',source.uri); guard(deps);
  if (source.type && source.type !== 'image') throw new Error('not a still image');
  checkSize(deps.fs.size(source.uri));
  if (source.fileSize != null) checkSize(source.fileSize);
  const original = deps.fs.readBytes(source.uri); checkSize(original.length);
  const format = sourceFormat(original);
  const mime = source.mimeType?.split(';')[0].trim().toLowerCase();
  if (mime && !['image/jpeg','image/jpg','image/png','image/heic','image/heif'].includes(mime)) throw new Error('unsupported image MIME');
  const outputFormat = format === 'png' ? 'png' : 'jpeg';
  const created = new Set<string>();
  const track = (image: ChatRaster) => { if (image.uri !== source.uri) created.add(image.uri); return image; };
  try {
    const decoded = track(await deps.ops.decode(source.uri));
    const size = fitChatImage(decoded.width,decoded.height); guard(deps);
    const encoded = track(await deps.ops.encode(decoded,size,outputFormat,outputFormat === 'jpeg' ? CHAT_IMAGE_JPEG_QUALITY : 1));
    checkSize(deps.fs.size(encoded.uri));
    const scrubbed = stripChatImageMetadata(deps.fs.readBytes(encoded.uri),outputFormat);
    if (scrubbed.width !== size.width || scrubbed.height !== size.height ||
        encoded.width !== size.width || encoded.height !== size.height) throw new Error('encoder changed dimensions');
    const clean = deps.fs.join(deps.fs.documentRoot,'images',safeSegment(accountId),`.chat-${randomId()}.part`);
    created.add(clean);
    deps.fs.writeBytes(clean,scrubbed.bytes);
    // Detect short/corrupted writes before ImageStore imports (which verifies
    // its own stage and move too). Save metadata is never trusted.
    const stored = deps.fs.readBytes(clean);
    if (stored.length !== scrubbed.bytes.length || !stored.every((v,i) => v === scrubbed.bytes[i])) throw new Error('incomplete image write');
    guard(deps);
    const reference = await deps.store.importImage(accountId,clean,{ extension:outputFormat === 'png' ? 'png' : 'jpg' });
    return { reference,width:size.width,height:size.height,mimeType:outputFormat === 'png' ? 'image/png' : 'image/jpeg' };
  } finally {
    for (const uri of created) cleanup(deps.fs,uri);
  }
}

/** Add a library selection as one atomic composer change. Cancel is a no-op.
 * All new files are durable BEFORE the current draft is read/replaced in a
 * transaction; text edited during processing is preserved. Any failure rolls
 * back only the new imports, leaving prior draft/outbox sources untouched. */
export async function applyChatImageSelection(db: Storage, accountId: string, peerId: string,
  sources: readonly PickedChatImage[] | null, deps: ChatImageDeps): Promise<ChatImageApplyResult> {
  if (sources === null || sources.length === 0) return { status:'canceled' };
  const prepared: PreparedChatImage[] = [];
  try {
    requireNonEmpty('accountId',accountId); requireNonEmpty('peerId',peerId); guard(deps);
    const previous = await readChatDraft(db,accountId,peerId);
    if (sources.length + (previous?.attachments.length ?? 0) > CHAT_IMAGE_LIMIT) throw new Error('maximum four images');
    for (const source of sources) prepared.push(await prepareChatImage(accountId,source,deps));
    const draft = await db.withWriteTransaction(async tx => {
      guard(deps);
      const current = await readChatDraft(tx,accountId,peerId);
      const attachments = [...(current?.attachments ?? []),...prepared.map(p => p.reference)];
      if (attachments.length > CHAT_IMAGE_LIMIT) throw new Error('maximum four images');
      const next = { accountId,peerId,body:current?.body ?? '',attachments,updatedAt:Date.now() };
      guard(deps); await saveChatDraft(tx,next); return next;
    });
    return { status:'committed',draft };
  } catch {
    for (const image of prepared) {
      try { await deps.store.removeImage(image.reference); } catch { /* best effort orphan cleanup */ }
    }
    return { status:'failed',message:CHAT_IMAGE_FAILED };
  }
}

/** Unselect, not sent-message withdrawal. Only this composer's reference is
 * removed: an independent queued/unknown send may still need the file. */
export async function removeChatDraftImage(db: Storage, accountId: string, peerId: string, imageId: string): Promise<ChatDraft | null> {
  return db.withWriteTransaction(async tx => {
    const current = await readChatDraft(tx,accountId,peerId);
    if (!current) return null;
    const next = { ...current,attachments:current.attachments.filter(i => i.imageId !== imageId),updatedAt:Date.now() };
    await saveChatDraft(tx,next); return next;
  });
}
