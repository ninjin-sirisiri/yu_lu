import { requireNonEmpty, type Storage } from './database';
import { listImageCacheEntries, saveImageCacheEntry } from './chat';
import type { FileSystemPort, ImageReference, ImageStore } from './files';

export const CHAT_CACHE_MAX_BYTES = 100 * 1024 * 1024;
export interface ChatCacheOptions {
  db: Storage;
  fs: FileSystemPort;
  store: ImageStore;
  maxBytes?: number;
  now?: () => number;
}
export interface CacheTrimResult { bytes: number; overBudgetBytes: number }

/** Account-scoped viewing copies only. Authorization/download belongs to the
 * caller; this API never fetches URLs, stores credentials or deletes a server
 * object. Only files registered in chat_image_cache are eviction candidates.
 * Draft and ALL outbox references (even missing/unknown state rows) pin bytes.
 * A pin is released only by its owner's explicit reference removal, never by
 * an inferred delivery outcome. Pinned overflow is reported, not destroyed. */
export function createChatImageCache(options: ChatCacheOptions) {
  const { db,fs,store } = options;
  const maxBytes = options.maxBytes ?? CHAT_CACHE_MAX_BYTES;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid cache budget');
  async function dropPath(tx: Storage, accountId: string, relativePath: string) {
    await tx.runAsync('DELETE FROM chat_image_cache WHERE account_id = ? AND relative_path = ?', [accountId,relativePath]);
  }
  async function accessedAt(tx: Storage, accountId: string): Promise<number> {
    const row = await tx.getFirstAsync<{ latest:number | null }>(
      'SELECT MAX(last_accessed_at) AS latest FROM chat_image_cache WHERE account_id = ?',[accountId]);
    // Persist a logical access timestamp, so clock rollback/equal milliseconds
    // and reopening the process cannot invert LRU order.
    return Math.max(now(),(row?.latest ?? 0) + 1);
  }
  async function discardBroken(tx: Storage, accountId: string, image: ImageReference) {
    const pin = await tx.getFirstAsync(`SELECT 1 FROM chat_attachment_refs WHERE account_id = ? AND relative_path = ?
      AND owner_kind IN ('draft','outbox') LIMIT 1`,[accountId,image.relativePath]);
    await dropPath(tx,accountId,image.relativePath);
    if (!pin) await store.removeImage(image);
  }
  async function trimIn(tx: Storage, accountId: string): Promise<CacheTrimResult> {
    const entries = await listImageCacheEntries(tx,accountId);
    const pins = await tx.getAllAsync<{ relative_path: string }>(`SELECT DISTINCT relative_path FROM chat_attachment_refs
      WHERE account_id = ? AND owner_kind IN ('draft','outbox')`,[accountId]);
    const pinned = new Set(pins.map(p => p.relative_path));
    // Physical bytes, not URL aliases. Most recent alias determines recency.
    const files = new Map<string,{ image:ImageReference; accessed:number }>();
    for (const entry of entries) {
      const path = store.resolvePath(entry.image);
      if (!fs.exists(path) || fs.size(path) !== entry.image.bytes) {
        await discardBroken(tx,accountId,entry.image); continue;
      }
      const old = files.get(entry.image.relativePath);
      files.set(entry.image.relativePath,{ image:entry.image,accessed:Math.max(old?.accessed ?? -Infinity,entry.lastAccessedAt) });
    }
    let bytes = [...files.values()].reduce((n,f) => n + f.image.bytes,0);
    const ordered = [...files.values()].sort((a,b) => a.accessed - b.accessed || a.image.relativePath.localeCompare(b.image.relativePath));
    for (const file of ordered) {
      if (bytes <= maxBytes) break;
      if (pinned.has(file.image.relativePath)) continue;
      await dropPath(tx,accountId,file.image.relativePath);
      // Keep the reference check and delete inside the write lock: a draft/
      // outbox pin cannot be inserted between them. A commit failure can at
      // worst restore a disposable cache row, which get() detects as a miss;
      // no pinned source is ever removed. Deletion failure rolls back rows.
      await store.removeImage(file.image);
      bytes -= file.image.bytes;
    }
    return { bytes,overBudgetBytes:Math.max(0,bytes - maxBytes) };
  }
  return {
    async get(accountId: string, remotePath: string): Promise<ImageReference | null> {
      requireNonEmpty('accountId',accountId); requireNonEmpty('remotePath',remotePath);
      return db.withWriteTransaction(async tx => {
        const entry = (await listImageCacheEntries(tx,accountId)).find(e => e.remotePath === remotePath);
        if (!entry) return null;
        const path = store.resolvePath(entry.image);
        if (!fs.exists(path) || fs.size(path) !== entry.image.bytes) {
          await discardBroken(tx,accountId,entry.image); return null;
        }
        await tx.runAsync(`UPDATE chat_image_cache SET last_accessed_at = ?
          WHERE account_id = ? AND relative_path = ?`,[await accessedAt(tx,accountId),accountId,entry.image.relativePath]);
        return entry.image;
      });
    },
    /** Persist a completed, authorized download. Returns null if pins leave no
     * room for this viewing copy. Source remains caller-owned in all cases. */
    async put(accountId: string, remotePath: string, sourcePath: string): Promise<ImageReference | null> {
      requireNonEmpty('accountId',accountId); requireNonEmpty('remotePath',remotePath);
      const image = await store.importImage(accountId,sourcePath);
      let published = false;
      try {
        await db.withWriteTransaction(async tx => {
          // Existing immutable paths reuse their copy; avoid replacing a file
          // that a visible image/pin might still reference.
          const old = (await listImageCacheEntries(tx,accountId)).find(e => e.remotePath === remotePath);
          if (!old || !fs.exists(store.resolvePath(old.image)) || fs.size(store.resolvePath(old.image)) !== old.image.bytes) {
            if (old) await discardBroken(tx,accountId,old.image);
            await saveImageCacheEntry(tx,{ accountId,remotePath,image,lastAccessedAt:await accessedAt(tx,accountId) });
            published = true;
          }
          // Publish and trim in one transaction: interruption or eviction
          // failure must not leave an over-budget committed cache index.
          await trimIn(tx,accountId);
        });
      } catch (error) {
        await store.removeImage(image).catch(() => undefined); throw error;
      }
      if (!published) await store.removeImage(image);
      return this.get(accountId,remotePath);
    },
    async trim(accountId: string): Promise<CacheTrimResult> {
      requireNonEmpty('accountId',accountId);
      return db.withWriteTransaction(tx => trimIn(tx,accountId));
    },
  };
}
