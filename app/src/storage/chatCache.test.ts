import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openAppDatabase, type AppStorage } from './database';
import { createImageStore, type FileSystemPort, type ImageStore } from './files';
import { createNodeFileSystemPort, NodeSqliteDriver } from './testSupport/nodePorts';
import { listImageCacheEntries, saveAttachmentReferences, saveChatDraft, saveImageCacheEntry } from './chat';
import { CHAT_CACHE_MAX_BYTES, createChatImageCache } from './chatCache';
import { createSyncQueue } from '../sync/queue';
import { updateOperation } from './outbox';

let root: string, db: AppStorage, disk: FileSystemPort, images: ImageStore, seq: number, now: number;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(),'chat-cache-'));
  disk = createNodeFileSystemPort(path.join(root,'documents'));
  db = await openAppDatabase({ driver:new NodeSqliteDriver(path.join(root,'app.db')) });
  seq = 0; now = 1; images = createImageStore({ fs:disk,newId:() => `cache-${++seq}` });
});
afterEach(async () => { await db.close(); fs.rmSync(root,{ recursive:true,force:true }); });
function cache(maxBytes = 100) { return createChatImageCache({ db,fs:disk,store:images,maxBytes,now:() => now++ }); }
function source(bytes = 40) { const p = path.join(root,`source-${++seq}.png`); fs.writeFileSync(p,Buffer.alloc(bytes,1)); return p; }
it('uses 100MiB by default and evicts LRU viewing files, not sources or another account', async () => {
  expect(CHAT_CACHE_MAX_BYTES).toBe(100 * 1024 * 1024);
  const c = cache(), src = source();
  const a = await c.put('alice','remote/a',src), b = await c.put('alice','remote/b',src);
  const other = await c.put('other','remote/a',src);
  expect(await c.get('alice','remote/a')).toEqual(a);
  const d = await c.put('alice','remote/d',src);
  expect(await c.get('alice','remote/b')).toBeNull();
  expect(fs.existsSync(images.resolvePath(b!))).toBe(false);
  expect(await c.get('alice','remote/d')).toEqual(d);
  expect(await c.get('other','remote/a')).toEqual(other);
  expect(fs.existsSync(src)).toBe(true);
});
it('persists recency across cache instances and database reopen', async () => {
  const c = cache(), src = source();
  const a = await c.put('alice','a',src); await c.put('alice','b',src); await c.get('alice','a');
  await db.close(); db = await openAppDatabase({ driver:new NodeSqliteDriver(path.join(root,'app.db')) });
  const reopened = cache(); await reopened.put('alice','c',src);
  expect(await reopened.get('alice','a')).toEqual(a); expect(await reopened.get('alice','b')).toBeNull();
});
it.each(['pending','sending','sent_unknown','failed_permanent','needs_confirmation','future_state'])('pins %s outbox and draft references', async state => {
  const c = cache(), src = source();
  const a = (await c.put('alice','a',src))!, b = (await c.put('alice','b',src))!;
  await saveChatDraft(db,{ accountId:'alice',peerId:'bob',body:'x',attachments:[a],updatedAt:1 });
  const queue = createSyncQueue({ store:db,clock:{ now:() => now },random:() => 0.5,newOperationId:() => 'operation' });
  const item = await queue.enqueue({ accountId:'alice',kind:'send_message',payload:{ recipient_id:'bob' } });
  await updateOperation(db,'alice',item.operation.operationId,{ state,reachStage:state === 'sent_unknown' ? 'request_started' : null });
  await saveAttachmentReferences(db,'alice','outbox',item.operation.operationId,[b]);
  expect(await c.put('alice','c',src)).toBeNull(); // only new unpinned copy can go
  expect(fs.existsSync(images.resolvePath(a))).toBe(true); expect(fs.existsSync(images.resolvePath(b))).toBe(true);
  expect(await listImageCacheEntries(db,'alice')).toHaveLength(2);
});
it('never deletes pinned files even when their total exceeds budget', async () => {
  const c = cache(200), src = source(60);
  const a = (await c.put('alice','a',src))!, b = (await c.put('alice','b',src))!;
  await saveAttachmentReferences(db,'alice','outbox','unknown',[a,b]);
  const result = await cache(100).trim('alice');
  expect(result).toMatchObject({ bytes:120,overBudgetBytes:20 });
  expect(fs.existsSync(images.resolvePath(a))).toBe(true);
});
it('handles missing files and counts aliases once without deleting still-cached aliases', async () => {
  const c = cache(), a = (await c.put('alice','a',source()))!;
  await saveImageCacheEntry(db,{ accountId:'alice',remotePath:'alias',image:a,lastAccessedAt:9 });
  expect((await c.trim('alice')).bytes).toBe(40);
  fs.unlinkSync(images.resolvePath(a));
  expect(await c.get('alice','a')).toBeNull();
  await c.trim('alice'); expect(await listImageCacheEntries(db,'alice')).toEqual([]);
});
it('cache SQL failure never publishes broken entries or deletes old copies', async () => {
  const c = cache(), old = await c.put('alice','a',source());
  await db.execAsync("CREATE TRIGGER fail_cache BEFORE INSERT ON chat_image_cache BEGIN SELECT RAISE(ABORT,'full'); END;");
  await expect(c.put('alice','b',source())).rejects.toThrow();
  expect(await c.get('alice','a')).toEqual(old);
  expect(fs.existsSync(images.resolvePath(old!))).toBe(true);
});
it('filesystem eviction failure retains entries for retry; account purge removes viewing files', async () => {
  const c = cache(), a = (await c.put('alice','a',source()))!;
  const remove = disk.removeFile; disk.removeFile = () => { throw new Error('denied'); };
  await expect(cache(1).trim('alice')).rejects.toThrow();
  expect(await c.get('alice','a')).toEqual(a);
  disk.removeFile = remove;
  await images.removeAccountImages('alice'); expect(await c.get('alice','a')).toBeNull();
});
it('keeps LRU ordering when the device clock rolls backwards', async () => {
  const c = cache(), src = source();
  const a = await c.put('alice','a',src); await c.put('alice','b',src);
  now = -100;
  await c.get('alice','a'); await c.put('alice','c',src);
  expect(await c.get('alice','a')).toEqual(a);
  expect(await c.get('alice','b')).toBeNull();
  expect(await c.get('alice','c')).not.toBeNull();
});
it('reclaims corrupt unpinned viewing bytes but keeps pinned corrupt sources for recovery', async () => {
  const c = cache(), src = source();
  const a = (await c.put('alice','a',src))!, b = (await c.put('alice','b',src))!;
  await saveAttachmentReferences(db,'alice','outbox','unknown',[b]);
  fs.appendFileSync(images.resolvePath(a),'corruption'); fs.appendFileSync(images.resolvePath(b),'corruption');
  await c.trim('alice');
  expect(fs.existsSync(images.resolvePath(a))).toBe(false);
  expect(fs.existsSync(images.resolvePath(b))).toBe(true);
  expect(await c.get('alice','a')).toBeNull();
});
it('eviction failure during insertion cannot publish an over-budget cache index', async () => {
  const c = cache(), src = source();
  await c.put('alice','a',src); await c.put('alice','b',src);
  const remove = disk.removeFile;
  disk.removeFile = target => {
    if (target.includes('cache-2.')) throw new Error('file is locked');
    remove(target);
  };
  await expect(c.put('alice','c',src)).rejects.toThrow('file is locked');
  expect((await listImageCacheEntries(db,'alice')).map(e => e.remotePath)).toEqual(['a','b']);
  expect(await c.get('alice','c')).toBeNull();
});
