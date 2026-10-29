import { mergeReadState, optimisticUnread, createReadStateRepository } from './readState';
import { A, B, C, CONV, key, message, deferred } from './repositoryTestSupport';
import type { CommandOutcome } from '../sync/api';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSyncQueue } from '../sync/queue';
import { openAppDatabase, type AppStorage } from '../storage/database';
import { NodeSqliteDriver } from '../storage/testSupport/nodePorts';
import { createRepositorySession } from './repository';
import { listReadIntents } from '../storage/chat';

it('unions sparse holes and max bounds without turning visibility into a prefix', () => {
  const merged = mergeReadState({ throughSequence: 0, messageIds: [key(102)] },
    { throughSequence: 1, messageIds: [key(103), key(102)] });
  expect(merged).toEqual({ throughSequence: 1, messageIds: [key(102), key(103)] });
  const baseline = { unread_count: 3, first_unread_sequence: 1, latest_sequence: 3 };
  expect(optimisticUnread(baseline, [message(1), message(2), message(3)], merged)).toEqual({ count: 0, exact: true });
  expect(optimisticUnread(baseline, [message(1), message(2), message(3)],
    { throughSequence: 0, messageIds: [key(103)] })).toEqual({ count: 2, exact: true });
});

it('does not invent unread membership for a server sparse hole', () => {
  expect(optimisticUnread({ unread_count: 2, first_unread_sequence: 1, latest_sequence: 3 },
    [message(1), message(2), message(3)], { throughSequence: 0, messageIds: [key(102)] }))
    .toEqual({ count: 2, exact: false });
});

it('does not confuse a partial page containing a read hole with a complete unread set', () => {
  // 1 and unseen 3 are unread; 2 was read on another device.
  expect(optimisticUnread({ unread_count: 2, first_unread_sequence: 1, latest_sequence: 3 },
    [message(1), message(2)], { throughSequence: 0, messageIds: [key(102)] }))
    .toEqual({ count: 2, exact: false });
});

it('labels a sparse overlay with unknown local membership as inexact', () => {
  expect(optimisticUnread({ unread_count: 2, first_unread_sequence: 1, latest_sequence: 3 },
    [message(1)], { throughSequence: 0, messageIds: [key(102)] })).toEqual({ count: 2, exact: false });
});

let db: AppStorage;
beforeEach(async () => { db = await openAppDatabase({ driver: new NodeSqliteDriver(':memory:') }); });
afterEach(async () => { await db.close(); });

it('persists immutable intents beyond 24h and sends them independently of message FIFO', async () => {
  let now = 0;
  const session = createRepositorySession({ storage: db, accountId: A, getAccountId: async () => A });
  const sent: any[] = [];
  let online = false;
  const reads = createReadStateRepository({ session, now: () => now, newId: () => key(10),
    commandApi: { send: async command => { sent.push(command); return online ? { status: 'ok', data: {
      result: { conversation_id: CONV, message_ids: [key(102)], through_sequence: 0 },
    } } : { status: 'unknown' }; } } });
  const queue = createSyncQueue({ store: db, clock: { now: () => now }, random: () => .5 });
  await queue.enqueue({ accountId: A, kind: 'send_message', payload: { recipient_id: B, client_key: key(1) } });
  const claim = await queue.claim(A);
  await queue.applySendResult(claim!, { status: 'rejected', httpStatus: 403, message: 'cannot send' });
  await queue.enqueue({ accountId: A, kind: 'send_message', payload: { recipient_id: B, client_key: key(2) } });
  expect(await queue.claim(A)).toBeNull();
  await reads.record(B, CONV, [key(102)], null);
  now = 49 * 3600_000;
  await reads.sync();
  expect(await listReadIntents(db, A)).toHaveLength(1);
  online = true;
  await reads.sync();
  expect(sent[1].operationId).toBe(sent[0].operationId);
  expect(sent[1].payload).toEqual({ conversation_id: CONV, message_ids: [key(102)], through_sequence: null });
  expect(await listReadIntents(db, A)).toHaveLength(0);
  expect(await queue.claim(A)).toBeNull();
  expect(await reads.state(B, CONV)).toEqual({ throughSequence: 0, messageIds: [key(102)] });
});

it('keeps another peer progressing when the first read fails and never expires intents', async () => {
  const session = createRepositorySession({ storage: db, accountId: A, getAccountId: async () => A });
  let id = 10;
  const reads = createReadStateRepository({ session, newId: () => key(id++), commandApi: {
    send: async command => command.payload.message_ids && (command.payload.message_ids as string[]).includes(key(102))
      ? { status: 'transient' } : { status: 'ok', data: { result: {
        conversation_id: CONV, message_ids: [key(103)], through_sequence: 0,
      } } },
  } });
  await reads.record(B, CONV, [key(102)], null);
  await reads.record(C, CONV, [key(103)], null);
  await reads.sync();
  expect((await listReadIntents(db, A)).map(i => i.peerId)).toEqual([B]);
});

it('unions old operation receipts without undoing newer reads or reviving a stopped account', async () => {
  let account: string | null = A;
  const session = createRepositorySession({ storage: db, accountId: A, getAccountId: async () => account });
  const response = deferred<CommandOutcome>();
  const reads = createReadStateRepository({ session, newId: () => key(10), commandApi: { send: () => response.promise } });
  await reads.record(B, CONV, [], 3);
  const sync = reads.sync();
  account = C; session.stop();
  response.resolve({ status: 'ok', data: { result: { conversation_id: CONV, message_ids: [], through_sequence: 3 } } });
  await sync;
  expect(await listReadIntents(db, A)).toHaveLength(1);
  expect(await reads.state(B, CONV)).toEqual({ throughSequence: 0, messageIds: [] });
});

it('does not allocate duplicate intents for already locally read visible IDs or weaker bounds', async () => {
  const session = createRepositorySession({ storage: db, accountId: A, getAccountId: async () => A });
  let id = 20;
  const reads = createReadStateRepository({ session, newId: () => key(id++), commandApi: { send: async () => ({ status: 'unknown' }) } });
  await reads.record(B, CONV, [key(102), key(102)], null);
  await reads.record(B, CONV, [key(102)], null);
  expect(await listReadIntents(db, A)).toHaveLength(1);
  await reads.record(B, CONV, [], 3);
  await reads.record(B, CONV, [], 2);
  expect(await listReadIntents(db, A)).toHaveLength(2);
  expect(await reads.state(B, CONV)).toEqual({ throughSequence: 3, messageIds: [key(102)] });
});

it('does not discard an intent when a malformed success does not cover its immutable read set', async () => {
  const session = createRepositorySession({ storage: db, accountId: A, getAccountId: async () => A });
  const reads = createReadStateRepository({ session, newId: () => key(10), commandApi: { send: async () => ({ status: 'ok',
    data: { result: { conversation_id: CONV, message_ids: [], through_sequence: 0 } } }) } });
  await reads.record(B, CONV, [key(102)], 3); await reads.sync();
  expect(await listReadIntents(db, A)).toHaveLength(1);
});

it('reopens durable read union and replays the original bound, independent of wall-clock age', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-reads-'));
  const filename = path.join(root, 'app.db');
  let durable = await openAppDatabase({ driver: new NodeSqliteDriver(filename) });
  try {
    let session = createRepositorySession({ storage: durable, accountId: A, getAccountId: async () => A });
    const reads = createReadStateRepository({ session, now: () => 0, newId: () => key(30), commandApi: { send: async () => ({ status: 'unknown' }) } });
    await reads.record(B, CONV, [], 3);
    await durable.close();
    durable = await openAppDatabase({ driver: new NodeSqliteDriver(filename) });
    session = createRepositorySession({ storage: durable, accountId: A, getAccountId: async () => A });
    const replay = createReadStateRepository({ session, now: () => 72 * 3600_000, commandApi: { send: async command => {
      expect(command.operationId).toBe(key(30));
      expect(command.payload.through_sequence).toBe(3);
      return { status: 'ok', data: { result: { conversation_id: CONV, message_ids: [], through_sequence: 3 } } };
    } } });
    expect(await replay.state(B, CONV)).toEqual({ throughSequence: 3, messageIds: [] });
    await replay.sync();
    expect(await listReadIntents(durable, A)).toEqual([]);
  } finally {
    await durable.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
