import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deleteAccountData, openAppDatabase, type AppStorage } from '../src/storage/database';
import { schemaMigrations, runMigrations, SCHEMA_VERSION } from '../src/storage/migrations';
import { saveDraft, readDraft } from '../src/storage/drafts';
import { countOperations, enqueueOperation, getOperation, listOperations, removeOperation, updateOperation } from '../src/storage/outbox';
import * as chat from '../src/storage/chat';
import { createImageStore } from '../src/storage/files';
import { readDeviceSetting, writeDeviceSetting } from '../src/storage/settings';
import { NodeSqliteDriver, createNodeFileSystemPort } from '../src/storage/testSupport/nodePorts';
import type { AcceptedMessage } from '../src/messages/types';

let root: string;
let handles: AppStorage[];
async function open(legacy = false) {
  const db = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')),
    ...(legacy ? { migrations: schemaMigrations.slice(0, 1) } : {}) });
  handles.push(db);
  return db;
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-chat-storage-')); handles = []; });
afterEach(async () => {
  for (const db of handles) await db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const operation = (operationId: string, extra = {}) => ({ accountId: 'alice', operationId,
  kind: 'send_message', payload: { body: '取りやめた内容' }, createdAt: 100, expiresAt: 86400100,
  state: 'pending', orderingKey: 'bob', ...extra });
const message = (extra: Partial<AcceptedMessage> = {}): AcceptedMessage => ({ accountId: 'alice',
  peerId: 'bob', messageId: 'm1', conversationId: 'c1', sequence: 1, senderId: 'bob',
  recipientId: 'alice', clientKey: 'client1', acceptedAt: '2026-10-28T00:00:00.000001Z',
  withdrawn: false, body: 'こんにちは', imagePaths: ['remote/image.png'], ...extra });

it('migrates v1 without changing opaque payloads, states, deadlines or old drafts', async () => {
  const old = await open(true);
  await saveDraft(old, 'alice', 'profile', { displayName: '夢' }, 7);
  for (const [id, state] of [['z', 'sending'], ['a', 'cancelled'], ['q', 'sent_unknown']]) {
    await old.runAsync(`INSERT INTO outbox (account_id, operation_id, kind, payload, base_version,
      created_at, expires_at, attempts, next_attempt_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['alice', id, 'profile.update', '{"old":true}', 3, 100, 200, 2, 150, state]);
  }
  await old.close();
  const db = await open();
  expect(await db.schemaVersion()).toBe(SCHEMA_VERSION);
  expect((await readDraft(db, 'alice', 'profile'))?.body).toEqual({ displayName: '夢' });
  const rows = await listOperations(db, 'alice');
  expect(rows.map(r => [r.operationId, r.state, r.queueSequence])).toEqual([
    ['a', 'cancelled', 1], ['q', 'sent_unknown', 2], ['z', 'sending', 3],
  ]);
  expect(rows[2]).toMatchObject({ payload: { old: true }, baseVersion: 3, attempts: 2,
    nextAttemptAt: 150, expiresAt: 200, orderingKey: null, claimGeneration: 0, reachStage: null, result: null });
  await enqueueOperation(db, operation('new'));
  expect((await getOperation(db, 'alice', 'new'))?.queueSequence).toBe(4);
});

it('rolls back the actual chat migration DDL, backfill and version together on SQL failure', async () => {
  const db = await open(true);
  await db.runAsync(`INSERT INTO outbox (account_id, operation_id, kind, payload, created_at, expires_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, ['alice', 'legacy', 'profile.update', '{"keep":1}', 10, 20, 'sending']);
  await db.execAsync(`CREATE TABLE chat_drafts (collision TEXT)`);
  await expect(runMigrations(db)).rejects.toThrow();
  expect(await db.schemaVersion()).toBe(1);
  const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(outbox)');
  expect(cols.map(c => c.name)).not.toContain('queue_sequence');
  expect(await db.getFirstAsync('SELECT payload, state FROM outbox')).toEqual({ payload: '{"keep":1}', state: 'sending' });
  expect(await db.getFirstAsync("SELECT name FROM sqlite_master WHERE name IN ('outbox_sequences', 'chat_messages')")).toBeNull();
  await db.execAsync('DROP TABLE chat_drafts');
  await db.close();
  const reopened = await open();
  expect(await reopened.schemaVersion()).toBe(SCHEMA_VERSION);
  expect(await getOperation(reopened, 'alice', 'legacy')).toMatchObject({ queueSequence: 1, state: 'sending', payload: { keep: 1 } });
  await chat.saveChatDraft(reopened, { accountId: 'alice', peerId: 'bob', body: 'recovered', attachments: [], updatedAt: 1 });
  expect((await chat.readChatDraft(reopened, 'alice', 'bob'))?.body).toBe('recovered');
});

it('restores peer/account drafts and ordered persistent attachments without replacing cancelled sends', async () => {
  const db = await open();
  const images = createImageStore({ fs: createNodeFileSystemPort(root) });
  const source = path.join(root, 'source.png'); fs.writeFileSync(source, 'image-bytes');
  const ref = await images.importImage('alice', source);
  const secondRef = await images.importImage('alice', source);
  await enqueueOperation(db, operation('cancelled', { state: 'cancelled' }));
  await chat.saveAttachmentReferences(db, 'alice', 'outbox', 'cancelled', [ref]);
  await chat.saveChatDraft(db, { accountId: 'alice', peerId: 'bob', body: '現在の入力🙂', attachments: [secondRef, ref], updatedAt: 20 });
  await chat.saveChatDraft(db, { accountId: 'alice', peerId: 'carol', body: '別の相手', attachments: [], updatedAt: 10 });
  await chat.saveChatDraft(db, { accountId: 'bob', peerId: 'bob', body: '別アカウント', attachments: [], updatedAt: 30 });
  await db.close();
  const next = await open();
  expect(await chat.readChatDraft(next, 'alice', 'bob')).toEqual({ accountId: 'alice', peerId: 'bob',
    body: '現在の入力🙂', attachments: [secondRef, ref], updatedAt: 20 });
  expect((await chat.readChatDraft(next, 'alice', 'carol'))?.body).toBe('別の相手');
  expect((await chat.readChatDraft(next, 'bob', 'bob'))?.body).toBe('別アカウント');
  expect(await chat.readChatDraft(next, 'carol', 'bob')).toBeNull();
  expect((await getOperation(next, 'alice', 'cancelled'))?.payload).toEqual({ body: '取りやめた内容' });
  expect(await chat.listAttachmentReferences(next, 'alice', 'outbox', 'cancelled')).toEqual([ref]);
  await chat.saveChatDraft(next, { accountId: 'alice', peerId: 'bob', body: '新入力', attachments: [], updatedAt: 40 });
  expect(await chat.listAttachmentReferences(next, 'alice', 'draft', 'bob')).toEqual([]);
  expect(await chat.listAttachmentReferences(next, 'alice', 'outbox', 'cancelled')).toEqual([ref]);
  expect(fs.existsSync(images.resolvePath(ref))).toBe(true);
});

it('stores accepted messages idempotently in server sequence order with account and peer isolation', async () => {
  const db = await open();
  await chat.storeAcceptedMessage(db, message({ messageId: 'm2', sequence: 2, acceptedAt: '2026-10-28T00:00:00.000001Z' }));
  await chat.storeAcceptedMessage(db, message());
  await chat.storeAcceptedMessage(db, message());
  await chat.storeAcceptedMessage(db, message({ accountId: 'bob', peerId: 'alice' }));
  await chat.storeAcceptedMessage(db, message({ peerId: 'carol', senderId: 'carol', conversationId: 'c2', messageId: 'other' }));
  await db.close();
  const next = await open();
  const rows = await chat.listLocalMessages(next, 'alice', 'bob');
  expect(rows.map(r => r.messageId)).toEqual(['m1', 'm2']);
  expect(rows[0]).toEqual(message());
  expect(await chat.listLocalMessages(next, 'nobody', 'bob')).toEqual([]);
  expect((await chat.listLocalMessages(next, 'bob', 'alice'))[0].messageId).toBe('m1');
});

it('redacts withdrawn content and never resurrects it from a stale refresh', async () => {
  const db = await open();
  await chat.storeAcceptedMessage(db, message());
  await chat.storeAcceptedMessage(db, message({ withdrawn: true }));
  await chat.storeAcceptedMessage(db, message());
  expect(await chat.listLocalMessages(db, 'alice', 'bob')).toEqual([
    message({ withdrawn: true, body: null, imagePaths: [] }),
  ]);
});

it('persists bounded read intents without widening a retried intent to newer messages', async () => {
  const db = await open();
  const intent = { accountId: 'alice', intentId: 'r1', peerId: 'bob', conversationId: 'c1',
    messageIds: ['m1', 'm3'], throughSequence: null, createdAt: 10 };
  expect(await chat.saveReadIntent(db, intent)).toBe(true);
  expect(await chat.saveReadIntent(db, { ...intent, messageIds: [], throughSequence: 99 })).toBe(false);
  const latest = { ...intent, intentId: 'r2', messageIds: [], throughSequence: 3, createdAt: 20 };
  await chat.saveReadIntent(db, latest);
  await db.close();
  const next = await open();
  expect(await chat.listReadIntents(next, 'alice')).toEqual([intent, latest]);
  expect(await chat.listReadIntents(next, 'bob')).toEqual([]);
  expect(await chat.removeReadIntent(next, 'bob', 'r1')).toBe(false);
  expect(await chat.removeReadIntent(next, 'alice', 'r1')).toBe(true);
  expect(await chat.listReadIntents(next, 'alice')).toEqual([latest]);
});

it('keeps monotonic outbox positions across deletion/reopen and persists guarded claim/result metadata', async () => {
  const db = await open();
  await Promise.all([enqueueOperation(db, operation('z')), enqueueOperation(db, operation('a', { createdAt: 1 }))]);
  const first = await getOperation(db, 'alice', 'z');
  expect(first?.queueSequence).toBe(1);
  expect((await getOperation(db, 'alice', 'a'))?.queueSequence).toBe(2);
  expect(await enqueueOperation(db, operation('a'))).toBe(false);
  await removeOperation(db, 'alice', 'a');
  await db.close();
  const next = await open();
  await enqueueOperation(next, operation('third'));
  expect((await getOperation(next, 'alice', 'third'))?.queueSequence).toBe(3);
  await enqueueOperation(next, operation('different', { orderingKey: 'carol' }));
  expect((await listOperations(next, 'alice', { orderingKey: 'bob' })).map(r => r.operationId)).toEqual(['z', 'third']);
  // Combined filters must apply equally to lists and counts, not expose the
  // number of unrelated peer operations as this conversation's queue size.
  expect(await countOperations(next, 'alice', { orderingKey: 'bob' })).toBe(2);
  expect(await countOperations(next, 'alice', { orderingKey: 'carol', state: 'sending' })).toBe(0);
  const receipt = { messageId: 'm1', conversationId: 'c1', sequence: 1, acceptedAt: '2026-10-28T00:00:00Z' };
  expect(await updateOperation(next, 'alice', 'z', { claimGeneration: 1, claimedAt: 200, reachStage: 'request_started' },
    { expectClaimGeneration: 0, expectState: 'pending' })).toBe(true);
  expect(await updateOperation(next, 'alice', 'z', { state: 'succeeded', result: receipt }, { expectClaimGeneration: 0 })).toBe(false);
  expect(await updateOperation(next, 'alice', 'z', { state: 'succeeded', result: receipt, reachStage: 'accepted' },
    { expectClaimGeneration: 1 })).toBe(true);
  await next.close();
  expect(await getOperation(await open(), 'alice', 'z')).toMatchObject({ queueSequence: 1, claimGeneration: 1,
    claimedAt: 200, reachStage: 'accepted', result: receipt });
});

it('rolls back draft and attachment changes together and rejects cross-account references', async () => {
  const db = await open();
  const draft = { accountId: 'alice', peerId: 'bob', body: 'old', attachments: [], updatedAt: 1 };
  await chat.saveChatDraft(db, draft);
  await expect(chat.saveChatDraft(db, { ...draft, body: 'bad', attachments: [{ accountId: 'bob',
    imageId: 'x', relativePath: 'images/bob/x.png', bytes: 1 }] })).rejects.toThrow();
  expect(await chat.readChatDraft(db, 'alice', 'bob')).toEqual(draft);
  await expect(db.withWriteTransaction(async tx => {
    await chat.saveChatDraft(tx, { ...draft, body: 'not committed' });
    await chat.storeAcceptedMessage(tx, message());
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect(await chat.readChatDraft(db, 'alice', 'bob')).toEqual(draft);
  expect(await chat.listLocalMessages(db, 'alice', 'bob')).toEqual([]);
});

it('purges all chat tables and attachment/cache files for only the removed account', async () => {
  const db = await open();
  const images = createImageStore({ fs: createNodeFileSystemPort(root) });
  const source = path.join(root, 'source.png'); fs.writeFileSync(source, 'bytes');
  for (const accountId of ['alice', 'bob']) {
    const attachment = await images.importImage(accountId, source);
    const cacheImage = await images.importImage(accountId, source);
    await chat.saveChatDraft(db, { accountId, peerId: 'carol', body: 'draft', attachments: [attachment], updatedAt: 1 });
    await enqueueOperation(db, operation('op', { accountId }));
    await chat.saveAttachmentReferences(db, accountId, 'outbox', 'op', [attachment]);
    await chat.storeAcceptedMessage(db, message({ accountId, peerId: 'carol', senderId: 'carol', recipientId: accountId }));
    await chat.saveReadIntent(db, { accountId, intentId: 'read', peerId: 'carol', conversationId: 'c1', messageIds: ['m1'], throughSequence: null, createdAt: 1 });
    await chat.saveImageCacheEntry(db, { accountId, remotePath: 'remote/image.png', image: cacheImage, lastAccessedAt: 100 });
  }
  await writeDeviceSetting(db, 'theme', 'dark');
  await db.close();
  const next = await open();
  expect((await chat.listImageCacheEntries(next, 'alice'))[0]).toMatchObject({ lastAccessedAt: 100, remotePath: 'remote/image.png' });
  await deleteAccountData(next, 'alice', { images });
  for (const table of ['chat_messages', 'chat_drafts', 'chat_read_intents', 'chat_attachment_refs', 'chat_image_cache', 'outbox_sequences']) {
    expect((await next.getFirstAsync<{ n: number }>(`SELECT count(*) n FROM ${table} WHERE account_id = ?`, ['alice']))?.n).toBe(0);
    expect((await next.getFirstAsync<{ n: number }>(`SELECT count(*) n FROM ${table} WHERE account_id = ?`, ['bob']))!.n).toBeGreaterThan(0);
  }
  expect(fs.existsSync(path.join(root, 'images', 'alice'))).toBe(false);
  expect(fs.readdirSync(path.join(root, 'images', 'bob'))).toHaveLength(2);
  expect(await readDeviceSetting(next, 'theme')).toBe('dark');
  expect(await chat.listImageCacheEntries(next, 'alice')).toEqual([]);
});
