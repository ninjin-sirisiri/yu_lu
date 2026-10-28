import { getAppClient, readSupabaseConfig } from '../backend/client';
import { listLocalMessages } from '../storage/chat';
import { createChatImageCache } from '../storage/chatCache';
import { randomId, safeSegment } from '../storage/database';
import { createImageStore, expoFileSystemPort, type FileSystemPort, type ImageReference, type ImageStore } from '../storage/files';
import type { RepositorySession } from './repository';

export type ConversationImageLoader = (peerId: string, messageId: string, remotePath: string) => Promise<string>;
export function createConversationImageLoader(deps: {
  session: RepositorySession; fs: FileSystemPort; store: ImageStore;
  getSession(): Promise<{ accountId: string; token: string } | null>;
  baseUrl: string; anonKey: string; request?: typeof fetch;
}): ConversationImageLoader {
  const { session, fs, store } = deps;
  const request = deps.request ?? fetch;
  return async (peerId, messageId, remotePath) => {
    // A server path is NOT a URL. Encode each segment and reject traversal,
    // schemes, query strings and encoded separators before touching the network.
    if (!remotePath.split('/').every(p => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p) && p !== '..') ||
        !/\.(png|jpe?g)$/i.test(remotePath)) throw new Error('Invalid image path.');
    async function authorized() {
      if (!await session.active()) throw new Error('Image owner unavailable.');
      const message = (await listLocalMessages(session.storage, session.accountId, peerId)).find(m => m.messageId === messageId);
      if (!message || message.withdrawn || !message.imagePaths.includes(remotePath)) throw new Error('Image unavailable.');
      const auth = await deps.getSession();
      if (!auth?.token || auth.accountId !== session.accountId || !await session.active()) throw new Error('Image owner unavailable.');
      return auth;
    }
    await authorized();
    const cached = await session.commit(session.token(), null, tx => createChatImageCache({ db: tx, fs, store }).get(session.accountId, remotePath));
    if (cached) { await authorized(); return store.resolvePath(cached); }
    // Cache IO can yield to logout/account switching. Recheck immediately
    // before dispatch and pin THAT verified actor's token explicitly.
    const auth = await authorized();
    const response = await request(`${deps.baseUrl.replace(/\/$/, '')}/storage/v1/object/authenticated/chat-images/${remotePath.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${auth.token}`, apikey: deps.anonKey }, redirect: 'error',
    });
    if (!response.ok || Number(response.headers.get('content-length')) > 10 * 1024 * 1024) throw new Error('Image download failed.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new Error('Image download failed.');
    await authorized();
    const temporary = fs.join(fs.documentRoot, 'images', safeSegment(session.accountId), `.view-${randomId()}.${remotePath.endsWith('.png') ? 'png' : 'jpg'}`);
    let published: ImageReference | null = null;
    try {
      const image = await session.commit(session.token(), null, async tx => {
        // Guarded write lock prevents logout purge racing a late download.
        const cache = createChatImageCache({ db: tx, fs, store });
        const existing = await cache.get(session.accountId, remotePath);
        if (existing) return existing;
        fs.writeBytes(temporary, bytes);
        published = await cache.put(session.accountId, remotePath, temporary);
        if (!published) throw new Error('Image cache is full.');
        return published;
      });
      if (!image) throw new Error('Image owner unavailable.');
      await authorized();
      return store.resolvePath(image);
    } catch (error) {
      // This is only OUR new disposable viewing copy, never an existing cache
      // alias/pinned source. Generation invalidation can roll back publication
      // even while the account remains active; do not leave unindexed bytes.
      if (published) await store.removeImage(published).catch(() => undefined);
      throw error;
    } finally { fs.removeFile(temporary); }
  };
}

export function deviceConversationImageLoader(session: RepositorySession): ConversationImageLoader {
  const client = getAppClient();
  const config = readSupabaseConfig();
  return createConversationImageLoader({ session, fs: expoFileSystemPort, store: createImageStore({ fs: expoFileSystemPort }),
    baseUrl: config.url, anonKey: config.anonKey, getSession: async () => {
      const { data, error } = await client.auth.getSession();
      return !error && data.session ? { accountId: data.session.user.id, token: data.session.access_token } : null;
    } });
}
