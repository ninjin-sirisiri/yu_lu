import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { deleteAccountData, openAppDatabase, type AppStorage } from '../src/storage/database';
import { createImageStore, expoFileSystemPort, type FileSystemPort, type ImageReference, type ImageStore } from '../src/storage/files';
import { createNodeFileSystemPort, NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { getOperation, listOperations, updateOperation } from '../src/storage/outbox';
import { listAttachmentReferences } from '../src/storage/chat';
import { writeDeviceSetting } from '../src/storage/settings';
import { createSyncQueue, PENDING_DEADLINE_MS, SEND_LEASE_MS, type SyncQueue } from '../src/sync/queue';
import { createSyncWorker } from '../src/sync/worker';
import { createChatSendApi, type ChatSendApiDeps } from '../src/sync/chatPipeline';
import { createProfileSendApi } from '../src/profiles/editor';
import { createCommandApi, type CommandApi, type CommandEnvelope, type CommandOutcome } from '../src/sync/api';
import { createDeviceSyncApi } from '../src/sync/deviceApi';
import { createSyncLifecycle } from '../src/sync/lifecycle';
import { sendMessage } from '../src/messages/send';
import { stripChatImageMetadata } from '../src/media/chatImageBytes';
import { PROBE_EXIF_JPEG_BASE64 } from '../src/media/avatarProbeFixtures';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACCOUNT = uuid(1), PEER = uuid(2), KEY = uuid(3), EPOCH = uuid(4);
const receipt = { message_id: uuid(5), client_key: KEY, conversation_id: uuid(6), sequence: 7,
  accepted_at: '2026-10-28T03:01:02.123456+00:00' };
let root: string, db: AppStorage, disk: FileSystemPort, images: ImageStore, queue: SyncQueue;
let now: number, id: number, account: string | null;
let calls: CommandEnvelope[], uploads: string[], transport: CommandApi;
let respond: (command: CommandEnvelope) => Promise<CommandOutcome>;
let upload: ChatSendApiDeps['uploadImage'];
const message = (attachments: ImageReference[] = []) => ({ recipient_id: PEER, client_key: KEY,
  friendship_epoch: EPOCH, body: 'hello\r\nworld', images_staged: attachments });
const wire = (media_ids: string[] = []) => ({ recipient_id: PEER, client_key: KEY,
  friendship_epoch: EPOCH, body: 'hello\nworld', media_ids });
function makeQueue() {
  return createSyncQueue({ store: db, clock: { now: () => now }, random: () => 0.5,
    newOperationId: () => uuid(++id) });
}
function pipeline() {
  return createChatSendApi(transport, { storage: db, fs: disk, store: images,
    getAccountId: async () => account, now: () => now, newPreparationId: () => uuid(++id),
    uploadImage: (...args) => upload(...args) });
}
function worker(api = pipeline()) { return createSyncWorker({ queue, accountId: ACCOUNT, api }); }
async function enqueue(attachments: ImageReference[] = []) {
  return (await queue.enqueue({ accountId: ACCOUNT, kind: 'send_message', payload: message(attachments) })).operation;
}
async function image() {
  const source = path.join(root, `source-${++id}.jpg`);
  fs.writeFileSync(source, stripChatImageMetadata(Buffer.from(PROBE_EXIF_JPEG_BASE64, 'base64'), 'jpeg').bytes);
  return images.importImage(ACCOUNT, source);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-send-'));
  db = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')) });
  disk = createNodeFileSystemPort(path.join(root, 'documents'));
  id = 100; now = 1_700_000_000_000; account = ACCOUNT;
  images = createImageStore({ fs: disk, newId: () => uuid(++id) });
  queue = makeQueue(); calls = []; uploads = [];
  upload = async stagingPath => { uploads.push(stagingPath); };
  respond = async command => command.kind === 'prepare_chat_media'
    ? { status: 'ok', data: { result: { media: (command.payload.images as { staging_path: string }[]).map((item, i) => ({
      media_id: uuid(700 + i), image_order: i, sha256: 'a'.repeat(64), mime_type: 'image/jpeg',
      width: 240, height: 320, byte_size: 100, final_path: `${ACCOUNT}/${command.payload.client_key}/${i}/${'a'.repeat(64)}.jpg`,
      ...item,
    })) } } }
    : { status: 'ok', data: { result: { ...receipt, client_key: command.payload.client_key } } };
  transport = { async send(command) {
    await command.beforeRequest?.();
    calls.push(JSON.parse(JSON.stringify(command))); return respond(command);
  } };
});
afterEach(async () => { await db.close(); fs.rmSync(root, { recursive: true, force: true }); });

it('prepares every image before sending one complete immutable payload and persists the receipt', async () => {
  const row = await enqueue([await image(), await image()]);
  await worker().runUntilIdle();
  expect(uploads).toEqual([`${ACCOUNT}/${KEY}/0.jpg`, `${ACCOUNT}/${KEY}/1.jpg`]);
  expect(calls.map(c => c.kind)).toEqual(['prepare_chat_media', 'send_message']);
  expect(calls[1].payload).toEqual(wire([uuid(700), uuid(701)]));
  expect(calls[1].operationId).toBe(row.operationId);
  const saved = await getOperation(db, ACCOUNT, row.operationId);
  expect(saved).toMatchObject({ state: 'succeeded', reachStage: 'accepted', result: {
    messageId: uuid(5), conversationId: uuid(6), sequence: 7, acceptedAt: receipt.accepted_at,
  } });
  expect(saved?.payload).toMatchObject({ chat_prepared: { operation_id: row.operationId,
    send_payload: wire([uuid(700), uuid(701)]), media: [{ media_id: uuid(700) }, { media_id: uuid(701) }] } });
});

it.each(['upload', 'prepare', 'malformed', 'partial'])(
  '%s failure never sends text or a partial image batch and retains the deadline', async failure => {
    const row = await enqueue([await image(), await image()]);
    const normal = respond;
    if (failure === 'upload') upload = async () => { throw new Error('offline'); };
    else respond = async command => {
      if (command.kind !== 'prepare_chat_media') return normal(command);
      if (failure === 'prepare') throw new Error('lost preparation response');
      if (failure === 'malformed') return { status: 'ok', data: {} };
      const result = await normal(command);
      if (result.status === 'ok') (result.data!.result as { media: unknown[] }).media.pop();
      return result;
    };
    await worker().runOnce();
    const saved = await getOperation(db, ACCOUNT, row.operationId);
    expect(saved).toMatchObject({ state: 'pending', reachStage: 'not_started', expiresAt: row.expiresAt,
      nextAttemptAt: now + 5_000 });
    expect(calls.filter(c => c.kind === 'send_message')).toHaveLength(0);
  });

it.each(['throw', 'transient', 'wrong-key'])(
  '%s after request start remains unknown and restart confirms the exact same ID/key/payload without files', async failure => {
    const ref = await image(); const row = await enqueue([ref]);
    const normal = respond;
    let first = true;
    respond = async command => {
      if (command.kind === 'send_message' && first) {
        first = false;
        expect((await getOperation(db, ACCOUNT, row.operationId))?.reachStage).toBe('request_started');
        if (failure === 'throw') throw new Error('accepted then response lost');
        if (failure === 'transient') return { status: 'transient' };
        return { status: 'ok', data: { result: { ...receipt, client_key: uuid(999) } } };
      }
      return normal(command);
    };
    await worker().runOnce();
    expect((await getOperation(db, ACCOUNT, row.operationId))?.state).toBe('sent_unknown');
    fs.unlinkSync(images.resolvePath(ref));
    await db.close(); db = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')) });
    queue = makeQueue(); now += PENDING_DEADLINE_MS + 1;
    await worker().runUntilIdle();
    const sends = calls.filter(c => c.kind === 'send_message');
    expect(sends.map(c => [c.operationId, c.payload])).toEqual([
      [row.operationId, wire([uuid(700)])], [row.operationId, wire([uuid(700)])],
    ]);
    expect(uploads).toHaveLength(1);
    expect((await getOperation(db, ACCOUNT, row.operationId))?.state).toBe('succeeded');
  });

it('a crash during preparation recovers as proven unsent, never escapes expiry', async () => {
  const row = await enqueue([await image()]);
  await queue.claim(ACCOUNT);
  now += PENDING_DEADLINE_MS + SEND_LEASE_MS;
  await worker().runUntilIdle();
  expect(calls).toHaveLength(0);
  expect(await getOperation(db, ACCOUNT, row.operationId)).toMatchObject({ state: 'needs_confirmation', reachStage: 'not_started' });
});

it('expiry reached while uploading stops before preparation/send', async () => {
  const row = await enqueue([await image()]);
  upload = async () => { now = row.expiresAt; };
  await worker().runUntilIdle();
  expect(calls).toHaveLength(0);
  expect(await getOperation(db, ACCOUNT, row.operationId)).toMatchObject({ state: 'needs_confirmation', reachStage: 'not_started' });
});

it.each(['switch', 'logout-marker', 'purge'])(
  '%s during upload revokes preprocessing without sending or recreating account state', async action => {
    const row = await enqueue([await image()]);
    upload = async () => {
      if (action === 'switch') account = uuid(99);
      if (action === 'logout-marker') await writeDeviceSetting(db, 'logout.pending', JSON.stringify({ accountId: ACCOUNT }));
      if (action === 'purge') await deleteAccountData(db, ACCOUNT);
    };
    await worker().runOnce();
    expect(calls).toHaveLength(0);
    const saved = await getOperation(db, ACCOUNT, row.operationId);
    if (action === 'purge') expect(saved).toBeNull();
    else expect(saved?.reachStage).not.toBe('request_started');
    expect(await listAttachmentReferences(db, ACCOUNT, 'outbox', row.operationId)).toEqual([]);
  });

it('a stale preparation callback cannot overwrite a newer generation or dispatch send', async () => {
  const row = await enqueue([await image()]);
  const entered = deferred<void>(), late = deferred<CommandOutcome>(); const normal = respond;
  let first = true;
  respond = async command => {
    if (command.kind === 'prepare_chat_media' && first) { first = false; entered.resolve(); return late.promise; }
    return normal(command);
  };
  const old = worker().runOnce(); await entered.promise;
  now += SEND_LEASE_MS;
  await worker().runUntilIdle();
  const settled = await getOperation(db, ACCOUNT, row.operationId);
  expect(settled?.state).toBe('succeeded');
  late.resolve({ status: 'ok', data: { result: { media: [] } } });
  await old;
  expect(await getOperation(db, ACCOUNT, row.operationId)).toEqual(settled);
  expect(calls.filter(c => c.kind === 'send_message')).toHaveLength(1);
});

it('a definite relationship rejection stops retries without refreshing the original epoch', async () => {
  const row = await enqueue();
  respond = async () => ({ status: 'rejected', httpStatus: 403, message: '現在この相手には送信できません' });
  await worker().runOnce(); now += 60_000; await worker().runUntilIdle();
  expect(calls).toHaveLength(1);
  expect(calls[0].payload).toEqual(wire());
  expect(await getOperation(db, ACCOUNT, row.operationId)).toMatchObject({ state: 'failed_permanent', reachStage: 'rejected' });
});

it('profile and chat decorators compose without losing either all-fields pipeline', async () => {
  await enqueue([await image()]);
  await queue.enqueue({ accountId: ACCOUNT, kind: 'update_profile', payload: { display_name: 'New', base_version: 1,
    avatar_staged: { upload_id: uuid(91), relative_path: 'images/avatar.jpg', image_id: uuid(92),
      file_name: 'avatar.jpg', content_type: 'image/jpeg', size_bytes: 2 } } });
  const composed = createChatSendApi(createProfileSendApi(transport, { storage: db,
    resolvePath: () => 'avatar', readFile: async () => new Uint8Array([1, 2]),
    uploadImage: async () => `${ACCOUNT}/avatar.jpg` }), { storage: db, fs: disk, store: images,
    getAccountId: async () => account, now: () => now, uploadImage: (...args) => upload(...args) });
  await worker(composed).runUntilIdle();
  expect((await listOperations(db, ACCOUNT)).map(r => r.state)).toEqual(['succeeded', 'succeeded']);
  expect(calls.find(c => c.kind === 'update_profile')?.payload).toEqual({
    display_name: 'New', base_version: 1, avatar_path: `${ACCOUNT}/avatar.jpg`,
  });
});

it('sendMessage reserves validated text and persistent images atomically through the durable queue', async () => {
  const ref = await image();
  const operationId = await sendMessage({ accountId: ACCOUNT, recipientId: PEER, friendshipEpoch: EPOCH,
    clientKey: KEY, body: 'hello\r\nworld', attachments: [ref] }, { storage: db, now: () => now });
  expect(await getOperation(db, ACCOUNT, operationId)).toMatchObject({ state: 'pending',
    orderingKey: PEER, payload: { ...message([ref]), body: 'hello\nworld' } });
  expect(await listAttachmentReferences(db, ACCOUNT, 'outbox', operationId)).toEqual([ref]);
  expect(calls).toHaveLength(0);
});

it('rejects excess/foreign images without truncating, enqueuing, or leaving attachment references', async () => {
  const ref = await image();
  for (const attachments of [Array(5).fill(ref), [{ ...ref, accountId: uuid(99) }]]) {
    await expect(sendMessage({ accountId: ACCOUNT, recipientId: PEER, friendshipEpoch: EPOCH,
      clientKey: KEY, body: 'hello', attachments }, { storage: db, now: () => now })).rejects.toThrow();
  }
  expect(await listOperations(db, ACCOUNT)).toEqual([]);
  expect(await db.getAllAsync('SELECT * FROM chat_attachment_refs')).toEqual([]);
});

it('the command transport treats a chat connection failure as unknown, not evidence of non-delivery', async () => {
  const api = createCommandApi({ client: { auth: { getSession: async () => ({ data: { session: { user: { id: ACCOUNT }, access_token: 'synthetic-session' } } }) },
    functions: { invoke: async () => ({ data: null, error: new TypeError('response lost') }) } } as never });
  expect((await api.send({ accountId: ACCOUNT, operationId: uuid(50), kind: 'send_message', payload: wire() })).status).toBe('unknown');
});

it('rechecks expiry after transport authentication and before actual HTTP dispatch', async () => {
  const row = await enqueue();
  const entered = deferred<void>(), session = deferred<unknown>();
  const requests: unknown[] = [];
  transport = createCommandApi({ client: { auth: { getSession: async () => {
    entered.resolve(); return session.promise;
  } }, functions: { invoke: async (_name: string, options: unknown) => {
    requests.push(options); return { data: { result: receipt }, error: null };
  } } } as never });
  const running = worker().runOnce(); await entered.promise;
  now = row.expiresAt;
  session.resolve({ data: { session: { user: { id: ACCOUNT }, access_token: 'synthetic-session' } } });
  await running;
  expect(requests).toHaveLength(0);
  expect(await getOperation(db, ACCOUNT, row.operationId)).toMatchObject({ state: 'needs_confirmation', reachStage: 'not_started' });
});

it('confirmed retry drops old media preparation and uses a fresh client key, preserving explicit epoch', async () => {
  const row = await enqueue([await image()]);
  const normal = respond;
  respond = async command => command.kind === 'send_message'
    ? { status: 'rejected', httpStatus: 403, message: '現在この相手には送信できません' } : normal(command);
  await worker().runOnce();
  const replacement = await queue.retryAsNew({ accountId: ACCOUNT, operationId: row.operationId });
  expect(replacement.payload).toMatchObject({ client_key: replacement.operationId, friendship_epoch: EPOCH });
  expect(replacement.payload).not.toHaveProperty('chat_prepared');
  expect(replacement.payload).not.toHaveProperty('chat_preparation_id');
  expect(await listAttachmentReferences(db, ACCOUNT, 'outbox', replacement.operationId)).toEqual(
    (replacement.payload as { images_staged: ImageReference[] }).images_staged);
  respond = normal;
  await worker().runUntilIdle();
  expect(calls.filter(c => c.kind === 'send_message').map(c => c.payload.client_key)).toEqual([KEY, replacement.operationId]);
  expect((await getOperation(db, ACCOUNT, replacement.operationId))?.state).toBe('succeeded');
});

it('a failed durable payload write never dispatches send and remains safely retryable', async () => {
  const row = await enqueue([await image()]);
  await db.execAsync(`CREATE TRIGGER fail_prepared BEFORE UPDATE OF payload ON outbox
    WHEN NEW.payload LIKE '%chat_prepared%' BEGIN SELECT RAISE(ABORT, 'injected payload failure'); END;`);
  await worker().runOnce();
  expect(calls.map(c => c.kind)).toEqual(['prepare_chat_media']);
  expect(await getOperation(db, ACCOUNT, row.operationId)).toMatchObject({ state: 'pending', reachStage: 'not_started' });
  expect((await getOperation(db, ACCOUNT, row.operationId))?.payload).not.toHaveProperty('chat_prepared');
});

it.each(['foreign-path', 'wrong-order', 'duplicate-id'])(
  'rejects %s in prepared media without dispatching any part of the message', async mutation => {
    const row = await enqueue([await image(), await image()]); const normal = respond;
    respond = async command => {
      const outcome = await normal(command);
      if (command.kind === 'prepare_chat_media' && outcome.status === 'ok') {
        const media = (outcome.data!.result as { media: Record<string, unknown>[] }).media;
        if (mutation === 'foreign-path') media[0].final_path = `${uuid(99)}/${KEY}/0/${'a'.repeat(64)}.jpg`;
        if (mutation === 'wrong-order') media[0].image_order = 1;
        if (mutation === 'duplicate-id') media[1].media_id = media[0].media_id;
      }
      return outcome;
    };
    await worker().runOnce();
    expect(calls.map(c => c.kind)).toEqual(['prepare_chat_media']);
    expect(await getOperation(db, ACCOUNT, row.operationId)).toMatchObject({ state: 'pending', reachStage: 'not_started' });
  });

it('legacy unknown rows without an immutable payload are never reconstructed or sent after expiry', async () => {
  const row = await enqueue([await image()]);
  await updateOperation(db, ACCOUNT, row.operationId, { state: 'sent_unknown', reachStage: null });
  now += PENDING_DEADLINE_MS + 1;
  await worker().runOnce();
  expect(calls).toEqual([]); expect(uploads).toEqual([]);
  expect((await getOperation(db, ACCOUNT, row.operationId))?.state).toBe('sent_unknown');
});

it('a prepared payload survives a pre-dispatch session failure and retries without touching source files', async () => {
  const ref = await image(); const row = await enqueue([ref]);
  const normal = transport;
  // Media preparation uses the same transport; only actual send authentication
  // fails here, positively before its beforeRequest capability is invoked.
  const unauthenticated = createCommandApi({ client: { auth: { getSession: async () => { throw new Error('unreadable session'); } } } as never });
  transport = { send: command => command.kind === 'send_message' ? unauthenticated.send(command) : normal.send(command) };
  await worker().runOnce();
  expect(await getOperation(db, ACCOUNT, row.operationId)).toMatchObject({ state: 'pending', reachStage: 'not_started' });
  fs.unlinkSync(images.resolvePath(ref)); transport = normal; now += 5_000;
  await worker().runUntilIdle();
  expect(uploads).toHaveLength(1);
  expect((await getOperation(db, ACCOUNT, row.operationId))?.state).toBe('succeeded');
});

it('restart recovers a dropped request-started claim and replays its payload beyond the unsent deadline', async () => {
  const ref = await image(); const row = await enqueue([ref]);
  const claim = await queue.claim(ACCOUNT);
  const normal = respond;
  respond = async command => {
    if (command.kind === 'send_message') throw new Error('accepted, process lost the response');
    return normal(command);
  };
  // Simulate process death BEFORE queue.applySendResult, not a fresh enqueue.
  await pipeline().send({ accountId: ACCOUNT, operationId: row.operationId, kind: 'send_message',
    payload: claim!.payload as Record<string, unknown>, claimGeneration: claim!.claimGeneration });
  expect(await getOperation(db, ACCOUNT, row.operationId)).toMatchObject({ state: 'sending', reachStage: 'request_started' });
  fs.unlinkSync(images.resolvePath(ref)); await db.close();
  db = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')) });
  queue = makeQueue(); now += PENDING_DEADLINE_MS + SEND_LEASE_MS; respond = normal;
  await worker().runUntilIdle();
  expect(calls.filter(c => c.kind === 'send_message').map(c => [c.operationId, c.payload])).toEqual([
    [row.operationId, wire([uuid(700)])], [row.operationId, wire([uuid(700)])],
  ]);
  expect((await getOperation(db, ACCOUNT, row.operationId))?.state).toBe('succeeded');
});

it('foreground retry timer resumes the real image pipeline at its persisted next attempt', async () => {
  jest.useFakeTimers();
  const row = await enqueue([await image()]);
  let offline = true;
  upload = async stagingPath => { if (offline) throw new Error('offline'); uploads.push(stagingPath); };
  const lifecycle = createSyncLifecycle({ getAccountId: async () => account, openStorage: async () => db,
    createApi: () => pipeline(), clock: { now: () => now }, random: () => 0.5, appState: null, network: null });
  try {
    const detach = lifecycle.start(); await lifecycle.drain('foreground');
    expect((await getOperation(db, ACCOUNT, row.operationId))?.nextAttemptAt).toBe(now + 5_000);
    offline = false; now += 5_000; await jest.advanceTimersByTimeAsync(5_000);
    expect((await getOperation(db, ACCOUNT, row.operationId))?.state).toBe('succeeded');
    expect(calls.map(c => c.kind)).toEqual(['prepare_chat_media', 'send_message']);
    detach(); expect(jest.getTimerCount()).toBe(0);
  } finally { lifecycle.stop(); jest.useRealTimers(); }
});

it('a corrupted saved media-ID binding fails closed instead of changing an unknown send', async () => {
  const row = await enqueue([await image()]); const normal = respond;
  respond = async command => command.kind === 'send_message' ? { status: 'unknown' } : normal(command);
  await worker().runOnce();
  const saved = await getOperation(db, ACCOUNT, row.operationId);
  const payload = saved!.payload as { chat_prepared: { send_payload: { media_ids: string[] } } };
  payload.chat_prepared.send_payload.media_ids = [uuid(799)];
  await updateOperation(db, ACCOUNT, row.operationId, { payload });
  now += 5_000; await worker().runOnce();
  expect(calls.filter(c => c.kind === 'send_message')).toHaveLength(1);
  expect((await getOperation(db, ACCOUNT, row.operationId))?.state).toBe('sent_unknown');
});

it('logout during media-command authentication stops even the private preparation request', async () => {
  await enqueue([await image()]);
  const entered = deferred<void>(), session = deferred<unknown>(); const requests: unknown[] = [];
  transport = createCommandApi({ client: { auth: { getSession: async () => { entered.resolve(); return session.promise; } },
    functions: { invoke: async (_name: string, options: unknown) => {
      requests.push(options); return { data: {}, error: null };
    } } } as never });
  const running = worker().runOnce(); await entered.promise;
  await deleteAccountData(db, ACCOUNT);
  session.resolve({ data: { session: { user: { id: ACCOUNT }, access_token: 'synthetic-session' } } });
  await running;
  expect(requests).toEqual([]);
  expect(await listOperations(db, ACCOUNT)).toEqual([]);
});

it('pins the verified account credential at the command transport boundary instead of rereading a switched session', async () => {
  const headers: unknown[] = [];
  let currentToken = 'synthetic-account-a-session';
  const api = createCommandApi({ client: { auth: { getSession: async () => ({ data: { session: {
    user: { id: ACCOUNT }, access_token: currentToken,
  } } }) }, functions: { invoke: async (_name: string, options: { headers?: unknown }) => {
    headers.push(options.headers ?? { Authorization: `Bearer ${currentToken}` });
    return { data: { result: receipt }, error: null };
  } } } as never });
  await api.send({ accountId: ACCOUNT, operationId: uuid(50), kind: 'send_message', payload: wire(),
    async beforeRequest() { currentToken = 'synthetic-account-b-session'; },
  });
  expect(headers).toEqual([{ Authorization: 'Bearer synthetic-account-a-session' }]);
});

it('device staging uploads are also bound to the verified account credential', async () => {
  const ref = await image(); const bytes = disk.readBytes(images.resolvePath(ref));
  const row = await enqueue([ref]); const uploadOptions: unknown[] = [];
  const client = { auth: { getSession: async () => ({ data: { session: {
    user: { id: ACCOUNT }, access_token: 'synthetic-account-a-session',
  } } }) }, storage: { from: () => ({ upload: async (_path: string, _data: unknown, options: unknown) => {
    uploadOptions.push(options); return { error: null };
  } }) }, functions: { invoke: async (_name: string, options: { body: CommandEnvelope }) => {
    const outcome = await respond(options.body);
    return { data: outcome.status === 'ok' ? outcome.data : null, error: null };
  } } };
  const filePort = jest.spyOn(expoFileSystemPort, 'readBytes').mockReturnValue(bytes);
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try { await worker(createDeviceSyncApi(db, client as never)).runUntilIdle(); }
  finally { filePort.mockRestore(); clock.mockRestore(); }
  expect(uploadOptions).toEqual([{ contentType: 'image/jpeg', upsert: true,
    headers: { Authorization: 'Bearer synthetic-account-a-session' } }]);
  expect((await getOperation(db, ACCOUNT, row.operationId))?.state).toBe('succeeded');
});

it.each(['blank', 'too-long'])('sendMessage rejects %s text before enqueueing', async invalid => {
  await expect(sendMessage({ accountId: ACCOUNT, recipientId: PEER, friendshipEpoch: EPOCH,
    clientKey: KEY, body: invalid === 'blank' ? ' \n\t' : 'a'.repeat(10001), attachments: [] },
  { storage: db, now: () => now })).rejects.toThrow();
  expect(await listOperations(db, ACCOUNT)).toEqual([]);
});

it('the shared device API used by existing foreground pumps strips local fields and marks actual dispatch', async () => {
  const row = await enqueue();
  const requests: unknown[] = [];
  const client = { auth: { getSession: async () => ({ data: { session: { user: { id: ACCOUNT }, access_token: 'synthetic-session' } } }) },
    functions: { invoke: async (_name: string, options: unknown) => {
      expect((await getOperation(db, ACCOUNT, row.operationId))?.reachStage).toBe('request_started');
      requests.push(options); return { data: { result: receipt }, error: null };
    } } };
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try { await worker(createDeviceSyncApi(db, client as never)).runUntilIdle(); }
  finally { clock.mockRestore(); }
  expect(requests).toEqual([{ headers: { Authorization: 'Bearer synthetic-session' },
    body: { operation_id: row.operationId, kind: 'send_message', payload: wire() } }]);
  expect((await getOperation(db, ACCOUNT, row.operationId))?.state).toBe('succeeded');
});
