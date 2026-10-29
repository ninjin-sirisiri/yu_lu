import { createConversationRepository, createRepositorySession, stopObsoleteSends } from './repository';
import { createReadStateRepository } from './readState';
import { openAppDatabase, type AppStorage } from '../storage/database';
import { NodeSqliteDriver, createNodeFileSystemPort } from '../storage/testSupport/nodePorts';
import { listLocalMessages, listReadIntents } from '../storage/chat';
import { listOperations } from '../storage/outbox';
import { createSyncQueue } from '../sync/queue';
import { readCache } from '../storage/cache';
import { writeDeviceSetting } from '../storage/settings';
import { countUnsentOperations } from '../auth/logout';
import { createChatSendApi } from '../sync/chatPipeline';
import { createSyncWorker } from '../sync/worker';
import { createImageStore } from '../storage/files';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { A, B, C, E2, CONV, api, page, message, key, deferred } from './repositoryTestSupport';

let db: AppStorage;
let account: string | null;
let session: ReturnType<typeof createRepositorySession>;
beforeEach(async () => {
  db = await openAppDatabase({ driver: new NodeSqliteDriver(':memory:') }); account = A;
  session = createRepositorySession({ storage: db, accountId: A, getAccountId: async () => account });
});
afterEach(async () => { await db.close(); });
function setup(peerId = B, client = api()) {
  let id = 90;
  const reads = createReadStateRepository({ session, newId: () => key(id++), commandApi: { send: async () => ({ status: 'unknown' }) } });
  return { repo: createConversationRepository({ session, peerId, client, reads, now: () => 1000 }), client, reads };
}

it('pages in both directions, deduplicates overlaps and retains server order', async () => {
  const { repo, client } = setup();
  await repo.loadInitial();
  (client.getMessages as jest.Mock).mockResolvedValueOnce(page([message(1), message(2)], { before_cursor: null }));
  await repo.loadBefore();
  (client.getMessages as jest.Mock).mockResolvedValueOnce(page([message(3), message(4)], { latest_sequence: 4, after_cursor: null }));
  await repo.loadAfter();
  expect((await repo.snapshot()).messages.map(m => m.sequence)).toEqual([1, 2, 3, 4]);
  expect(client.getMessages).toHaveBeenNthCalledWith(2, B, 'before', 'before-2');
  expect(client.getMessages).toHaveBeenNthCalledWith(3, B, 'after', 'after-3');
});

it('rejects stale loads, old revisions, disposed peers and changed accounts before cache writes', async () => {
  const { repo, client } = setup();
  const old = deferred<ReturnType<typeof page>>();
  (client.getMessages as jest.Mock).mockReturnValueOnce(old.promise);
  const loading = repo.loadInitial();
  await repo.jumpLatest();
  old.resolve(page([message(99)])); await loading;
  expect((await repo.snapshot()).messages.map(m => m.sequence)).toEqual([2, 3]);
  session.observeRevision(9);
  expect(await repo.loadAfter()).toBe(false);
  const pending = deferred<ReturnType<typeof page>>();
  (client.getMessages as jest.Mock).mockReturnValueOnce(pending.promise);
  const late = repo.loadInitial(); account = C;
  pending.resolve(page([message(100)], { revision: 10 })); await late;
  expect((await listLocalMessages(db, A, B)).map(m => m.sequence)).toEqual([2, 3]);
  expect((await repo.snapshot()).messages).toEqual([]);
});

it('merges an optimistic row by sender/client key and reconciles a durable receipt', async () => {
  const { repo, client } = setup(); await repo.loadInitial();
  const id = await repo.enqueueMessage({ body: 'outgoing', attachments: [], clientKey: key(50) });
  expect((await repo.snapshot()).pending).toHaveLength(1);
  (client.getMessages as jest.Mock).mockResolvedValueOnce(page([message(4, { sender_id: A, recipient_id: B, client_key: key(50) })], { latest_sequence: 4 }));
  await repo.loadAfter();
  expect((await repo.snapshot()).pending).toHaveLength(0);
  expect((await repo.snapshot()).messages.map(m => m.sequence)).toEqual([2, 3, 4]);
  expect((await listOperations(db, A)).find(row => row.operationId === id)).toMatchObject({
    state: 'succeeded', reachStage: 'accepted', result: { sequence: 4, messageId: key(104), conversationId: CONV },
  });
});

it('stops old-epoch pending sends durably and never revives them after refriending', async () => {
  const { repo, client } = setup(); await repo.loadInitial();
  await repo.enqueueMessage({ body: 'old', attachments: [], clientKey: key(50) });
  (client.getMessages as jest.Mock).mockResolvedValueOnce(page([], { revision: 2, friendship_epoch: E2 }));
  await repo.loadInitial();
  const rows = await listOperations(db, A);
  expect(rows[0].state).toBe('needs_confirmation');
  expect(await createSyncQueue({ store: db, clock: { now: () => 1001 }, random: () => .5 }).claim(A)).toBeNull();
  await repo.loadInitial();
  expect((await listOperations(db, A))[0].state).toBe('needs_confirmation');
});

it('records only visible incoming IDs and fixes jump bound at the fetched destination', async () => {
  const { repo, client } = setup(); await repo.loadInitial();
  await repo.recordVisible([key(102), 'not-loaded']);
  expect((await listReadIntents(db, A))[0].messageIds).toEqual([key(102)]);
  (client.getMessages as jest.Mock).mockResolvedValueOnce(page([message(8)], { latest_sequence: 8 }));
  await repo.jumpLatest();
  expect((await listReadIntents(db, A)).map(i => i.throughSequence)).toContain(8);
  (client.getMessages as jest.Mock).mockResolvedValueOnce(page([message(9)], { latest_sequence: 9 }));
  await repo.loadAfter();
  expect((await listReadIntents(db, A)).some(i => i.throughSequence === 9)).toBe(false);
});

it('does not let an automatic recovery discard an in-flight explicit latest-read destination', async () => {
  const { repo, client } = setup(); await repo.loadInitial();
  const destination = deferred<ReturnType<typeof page>>();
  const requested = deferred<void>();
  (client.getMessages as jest.Mock).mockImplementationOnce(async () => {
    requested.resolve(); return destination.promise;
  });
  const jumping = repo.jumpLatest();
  await requested.promise;
  // Realtime/read acknowledgements can request recovery during this HTTP call.
  await repo.loadInitial();
  destination.resolve(page([message(8)], { latest_sequence: 8, after_cursor: null }));
  expect(await jumping).toBe(true);
  expect((await listReadIntents(db, A)).map(i => i.throughSequence)).toEqual([8]);
  (client.getMessages as jest.Mock).mockResolvedValueOnce(page([message(9)], { latest_sequence: 9 }));
  await repo.loadInitial();
  expect((await repo.snapshot()).messages.map(m => m.sequence)).toContain(9);
  expect((await listReadIntents(db, A)).map(i => i.throughSequence)).toEqual([8]);
});

it('reopens cached history without granting stale relationship permission', async () => {
  const { repo } = setup(); await repo.loadInitial();
  const reopened = setup().repo;
  expect((await reopened.snapshot()).messages).toHaveLength(2);
  await expect(reopened.enqueueMessage({ body: 'no', attachments: [], clientKey: key(51) })).rejects.toThrow();
  repo.dispose();
  expect(await repo.loadInitial()).toBe(false);
  expect((await listLocalMessages(db, A, B))[0].conversationId).toBe(CONV);
});

it('does not send with stale conversation permission after a home relationship refresh', async () => {
  const { repo } = setup(); await repo.loadInitial();
  await db.withWriteTransaction(tx => stopObsoleteSends(tx, A, page([], { revision: 2, can_send: false, friendship_epoch: null })));
  expect((await repo.snapshot()).canSend).toBe(false);
  await expect(repo.enqueueMessage({ body: 'stale', attachments: [], clientKey: key(52) })).rejects.toThrow();
  expect(await listOperations(db, A)).toEqual([]);
});

it('stops unknown sends without relabeling them as definitely unsent', async () => {
  const { repo, client } = setup(); await repo.loadInitial();
  const id = await repo.enqueueMessage({ body: 'uncertain', attachments: [], clientKey: key(55) });
  const queue = createSyncQueue({ store: db, clock: { now: () => 1001 }, random: () => .5 });
  const claim = await queue.claim(A);
  expect(claim?.operationId).toBe(id);
  await queue.applySendResult(claim!, { status: 'unknown' });
  (client.getMessages as jest.Mock).mockResolvedValueOnce(page([], { revision: 2, can_send: false, friendship_epoch: null }));
  await repo.loadInitial();
  expect((await listOperations(db, A))[0]).toMatchObject({ state: 'relationship_stopped', reachStage: 'request_started' });
  expect(await queue.claim(A)).toBeNull();
  expect(await countUnsentOperations(db, A)).toEqual({ unsent: 0, inFlight: 1 });
});

it('preserves safe local exclusion of a definitely rejected send after the relationship ends', async () => {
  const { repo, client } = setup(); await repo.loadInitial();
  const id = await repo.enqueueMessage({ body: 'rejected', attachments: [], clientKey: key(57) });
  const queue = createSyncQueue({ store: db, clock: { now: () => 1001 }, random: () => .5 });
  await queue.applySendResult((await queue.claim(A))!, { status: 'rejected', httpStatus: 403, message: 'cannot send' });
  (client.getMessages as jest.Mock).mockResolvedValueOnce(page([], { revision: 2, can_send: false, friendship_epoch: null }));
  await repo.loadInitial();
  expect((await listOperations(db, A))[0].state).toBe('failed_permanent');
  expect(await queue.cancelUnsent(A, id)).toBe(true);
});

it('reconciles an accepted receipt before fetch without inventing client-time history order', async () => {
  const { repo } = setup(); await repo.loadInitial();
  const id = await repo.enqueueMessage({ body: 'accepted', attachments: [], clientKey: key(56) });
  const queue = createSyncQueue({ store: db, clock: { now: () => 1001 }, random: () => .5 });
  const claim = await queue.claim(A);
  expect(claim?.operationId).toBe(id);
  await queue.applySendResult(claim!, { status: 'ok', data: { result: {
    message_id: key(156), conversation_id: CONV, sequence: 4, accepted_at: '2026-10-28T00:01:00.123456Z',
  } } });
  const view = await repo.snapshot();
  expect(view.pending).toEqual([]);
  expect(view.messages.map(m => m.sequence)).toEqual([2, 3, 4]);
  expect(view.messages[2].acceptedAt).toBe('2026-10-28T00:01:00.123456Z');
});

it('rolls back a fetch revoked during SQLite writes, including its cache and read intent', async () => {
  const { repo } = setup();
  const run = db.withWriteTransaction.bind(db);
  db.withWriteTransaction = fn => run(async tx => {
    const execute = tx.runAsync.bind(tx);
    tx.runAsync = async (sql, params) => {
      const result = await execute(sql, params);
      if (sql.includes('INSERT INTO chat_messages')) session.stop();
      return result;
    };
    return fn(tx);
  });
  expect(await repo.jumpLatest()).toBe(false);
  expect(await listLocalMessages(db, A, B)).toEqual([]);
  expect(await readCache(db, A, `chat.peer.${B}`)).toBeNull();
  expect(await listReadIntents(db, A)).toEqual([]);
});

it('does not recreate state after pending logout or a disposed peer callback', async () => {
  const { repo, client } = setup();
  const response = deferred<ReturnType<typeof page>>();
  (client.getMessages as jest.Mock).mockReturnValueOnce(response.promise);
  const pending = repo.loadInitial();
  repo.dispose(); response.resolve(page());
  expect(await pending).toBe(false);
  await writeDeviceSetting(db, 'logout.pending', JSON.stringify({ accountId: A }));
  expect(await setup().repo.loadInitial()).toBe(false);
  expect(await listLocalMessages(db, A, B)).toEqual([]);
});

it('allows a fresh provider after the existing logout lifecycle clears its marker to an empty string', async () => {
  await writeDeviceSetting(db, 'logout.pending', '');
  expect(await setup().repo.loadInitial()).toBe(true);
});

it('sends newly confirmed repository work through the shared pipeline after a cleared logout marker', async () => {
  await writeDeviceSetting(db, 'logout.pending', '');
  const { repo } = setup(); await repo.loadInitial();
  const operationId = await repo.enqueueMessage({ body: 'fresh confirmation', attachments: [], clientKey: key(58) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-send-'));
  try {
    const files = createNodeFileSystemPort(root);
    const transport = createChatSendApi({ send: async command => {
      await command.beforeRequest?.();
      return { status: 'ok', data: { result: { client_key: key(58), message_id: key(158), conversation_id: CONV,
        sequence: 4, accepted_at: '2026-10-28T00:01:00.123456Z' } } };
    } }, { storage: db, fs: files, store: createImageStore({ fs: files }), getAccountId: async () => A,
      now: () => 1001, uploadImage: async () => { throw new Error('Text must not upload.'); } });
    const queue = createSyncQueue({ store: db, clock: { now: () => 1001 }, random: () => .5 });
    expect(await createSyncWorker({ queue, api: transport, accountId: A }).runOnce())
      .toMatchObject({ operationId, state: 'succeeded', outcome: 'ok' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('rejects a revision invalidated during the final cache write', async () => {
  const { repo } = setup();
  const run = db.withWriteTransaction.bind(db);
  db.withWriteTransaction = fn => run(async tx => {
    const execute = tx.runAsync.bind(tx);
    tx.runAsync = async (sql, params) => {
      const result = await execute(sql, params);
      if (sql.includes('INSERT INTO cache') && params?.includes('chat.revision')) session.observeRevision(20);
      return result;
    };
    return fn(tx);
  });
  expect(await repo.loadInitial()).toBe(false);
  expect(await listLocalMessages(db, A, B)).toEqual([]);
});
