import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openAppDatabase, type AppStorage } from '../storage/database';
import { getOperation, listOperations, updateOperation } from '../storage/outbox';
import { readChatDraft, saveChatDraft } from '../storage/chat';
import { NodeSqliteDriver } from '../storage/testSupport/nodePorts';
import { createSyncQueue, PENDING_DEADLINE_MS, type SyncQueue } from '../sync/queue';

const T0 = 1_700_000_000_000;
const message = (peer = 'bob', body = 'hello') => ({
  kind: 'send_message',
  payload: { recipient_id: peer, client_key: `key-${body}`, friendship_epoch: 'epoch', body, media_ids: [] },
});
const receipt = {
  message_id: 'message-1', conversation_id: 'conversation-1', sequence: 7,
  accepted_at: '2026-10-28T03:01:02.123456+00:00',
};

let root: string;
let store: AppStorage;
let queue: SyncQueue;
let now: number;
let id: number;

function makeQueue(): SyncQueue {
  return createSyncQueue({ store, clock: { now: () => now }, random: () => 0.5,
    newOperationId: () => `operation-${String(++id).padStart(4, '0')}` });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-outbox-'));
  store = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')) });
  now = T0;
  id = 0;
  queue = makeQueue();
});

afterEach(async () => {
  await store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('conversation FIFO', () => {
  it('persists the peer and separate logical positions despite clock rollback and reopen', async () => {
    const a = await queue.enqueue({ accountId: 'alice', ...message() });
    now -= 10_000;
    const b = await queue.enqueue({ accountId: 'alice', ...message('bob', 'second') });
    expect([a.coalesced, b.coalesced]).toEqual([false, false]);
    expect([a.operation.orderingKey, b.operation.orderingKey]).toEqual(['bob', 'bob']);
    expect([a.operation.queueSequence, b.operation.queueSequence]).toEqual([1, 2]);
    expect(a.operation.reachStage).toBe('not_started');
    await store.close();
    store = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')) });
    queue = makeQueue();
    expect((await queue.claim('alice'))?.operationId).toBe(a.operation.operationId);
    expect(await queue.claim('alice')).toBeNull();
  });

  it.each([
    ['pending', 'not_started'], ['sending', 'preparing'], ['sending', 'request_started'],
    ['sent_unknown', 'request_started'], ['failed_permanent', 'rejected'],
    ['needs_confirmation', 'not_started'], ['future_nonterminal', null],
  ] as const)('a %s head blocks only its own peer', async (state, reachStage) => {
    const head = await queue.enqueue({ accountId: 'alice', ...message() });
    await updateOperation(store, 'alice', head.operation.operationId, {
      state, nextAttemptAt: now + 5_000, reachStage,
    });
    const later = await queue.enqueue({ accountId: 'alice', ...message('bob', 'later') });
    const other = await queue.enqueue({ accountId: 'alice', ...message('carol') });
    const profile = await queue.enqueue({ accountId: 'alice', kind: 'update_profile', payload: {} });
    expect((await queue.claim('alice'))?.operationId).toBe(other.operation.operationId);
    expect((await queue.claim('alice'))?.operationId).toBe(profile.operation.operationId);
    expect(await queue.claim('alice')).toBeNull();
    expect((await getOperation(store, 'alice', later.operation.operationId))?.state).toBe('pending');
    const isolated = await queue.enqueue({ accountId: 'other-account', ...message() });
    expect((await queue.claim('other-account'))?.operationId).toBe(isolated.operation.operationId);
  });

  it('expiry during claim still blocks a fresh successor until explicit confirmation', async () => {
    const old = await queue.enqueue({ accountId: 'alice', ...message() });
    now += PENDING_DEADLINE_MS;
    await queue.enqueue({ accountId: 'alice', ...message('bob', 'later') });
    expect(await queue.claim('alice')).toBeNull();
    expect((await getOperation(store, 'alice', old.operation.operationId))?.state).toBe('needs_confirmation');
  });

  it.each(['failed_permanent', 'needs_confirmation'])('confirmed %s retry retains its position with a fresh id', async state => {
    const old = await queue.enqueue({ accountId: 'alice', ...message() });
    await updateOperation(store, 'alice', old.operation.operationId, { state });
    const later = await queue.enqueue({ accountId: 'alice', ...message('bob', 'later') });
    now += 1_000;
    const fresh = await queue.retryAsNew({ accountId: 'alice', operationId: old.operation.operationId,
      payload: message('bob', 'confirmed').payload });
    expect(fresh.operationId).not.toBe(old.operation.operationId);
    expect(fresh.orderingKey).toBe('bob');
    expect(fresh.queueSequence).toBe(1);
    expect(fresh.reachStage).toBe('not_started');
    expect(fresh.expiresAt).toBe(now + PENDING_DEADLINE_MS);
    const claim = await queue.claim('alice');
    expect(claim?.operationId).toBe(fresh.operationId);
    await queue.applySendResult(claim!, { status: 'ok', data: { result: receipt } });
    expect((await queue.claim('alice'))?.operationId).toBe(later.operation.operationId);
  });

  it.each(['pending', 'needs_confirmation', 'failed_permanent'])('excluded %s content remains local and a confirmed resend joins the tail', async state => {
    await saveChatDraft(store, { accountId: 'alice', peerId: 'bob', body: 'current composer', attachments: [], updatedAt: now });
    const old = await queue.enqueue({ accountId: 'alice', ...message() });
    await updateOperation(store, 'alice', old.operation.operationId, {
      state, reachStage: state === 'failed_permanent' ? 'rejected' : 'not_started',
    });
    const later = await queue.enqueue({ accountId: 'alice', ...message('bob', 'later') });
    expect(await queue.cancelUnsent('alice', old.operation.operationId)).toBe(true);
    expect((await getOperation(store, 'alice', old.operation.operationId))?.payload).toEqual(message().payload);
    expect((await readChatDraft(store, 'alice', 'bob'))?.body).toBe('current composer');
    const fresh = await queue.retryAsNew({ accountId: 'alice', operationId: old.operation.operationId });
    expect(fresh.queueSequence).toBe(3);
    expect(fresh.orderingKey).toBe('bob');
    expect((await queue.claim('alice'))?.operationId).toBe(later.operation.operationId);
  });

  it('refuses recipient changes when confirming a retry without altering either row', async () => {
    const old = await queue.enqueue({ accountId: 'alice', ...message() });
    await updateOperation(store, 'alice', old.operation.operationId, { state: 'failed_permanent' });
    await expect(queue.retryAsNew({ accountId: 'alice', operationId: old.operation.operationId,
      payload: message('carol').payload })).rejects.toMatchObject({ code: 'invalid_payload' });
    expect((await listOperations(store, 'alice')).map(row => row.state)).toEqual(['failed_permanent']);
  });

  it('rolls back supersession if a replacement id collides, leaving the original FIFO blocker', async () => {
    const old = await queue.enqueue({ accountId: 'alice', ...message() });
    await updateOperation(store, 'alice', old.operation.operationId, { state: 'failed_permanent' });
    const later = await queue.enqueue({ accountId: 'alice', ...message('bob', 'later') });
    const colliding = createSyncQueue({ store, clock: { now: () => now }, random: () => 0.5,
      newOperationId: () => later.operation.operationId });
    await expect(colliding.retryAsNew({ accountId: 'alice', operationId: old.operation.operationId }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await listOperations(store, 'alice')).map(row => row.state)).toEqual(['failed_permanent', 'pending']);
    expect(await queue.claim('alice')).toBeNull();
    expect((await queue.enqueue({ accountId: 'alice', ...message('carol') })).operation.queueSequence).toBe(3);
  });

  it.each([undefined, '', 42])('rejects a missing/invalid recipient %p before persisting a message', async recipient_id => {
    await expect(queue.enqueue({ accountId: 'alice', kind: 'send_message', payload: { recipient_id } }))
      .rejects.toMatchObject({ code: 'invalid_payload' });
    expect(await listOperations(store, 'alice')).toHaveLength(0);
  });

  it.each([['claim', false], ['cancel', true]] as const)('resolves %s-first cancellation against another queue in one transaction', async (first, cancelled) => {
    const old = await queue.enqueue({ accountId: 'alice', ...message() });
    const other = makeQueue();
    const cancel = () => other.cancelUnsent('alice', old.operation.operationId);
    const claim = () => queue.claim('alice');
    const results = await Promise.all(first === 'claim' ? [claim(), cancel()] : [cancel(), claim()]);
    expect(results[first === 'claim' ? 1 : 0]).toBe(cancelled);
    expect(results[first === 'claim' ? 0 : 1] === null).toBe(cancelled);
    expect((await getOperation(store, 'alice', old.operation.operationId))?.state).toBe(cancelled ? 'cancelled' : 'sending');
  });

  it.each(['request_started', null] as const)('does not allow cancellation without positive unsent evidence (%s)', async reachStage => {
    const old = await queue.enqueue({ accountId: 'alice', ...message() });
    await updateOperation(store, 'alice', old.operation.operationId, { reachStage });
    expect(await queue.cancelUnsent('alice', old.operation.operationId)).toBe(false);
  });

  it('persists the accepted receipt unchanged across restart and ignores duplicate callbacks', async () => {
    const old = await queue.enqueue({ accountId: 'alice', ...message() });
    const claimed = await queue.claim('alice');
    expect(await queue.applySendResult(claimed!, { status: 'ok', data: { result: receipt } })).toBe('succeeded');
    await queue.applySendResult(claimed!, { status: 'unknown' });
    await store.close();
    store = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')) });
    expect(await getOperation(store, 'alice', old.operation.operationId)).toMatchObject({
      state: 'succeeded', reachStage: 'accepted', result: {
        messageId: 'message-1', conversationId: 'conversation-1', sequence: 7,
        acceptedAt: '2026-10-28T03:01:02.123456+00:00',
      },
    });
  });

  it('never releases the head if persisting its accepted receipt fails', async () => {
    const old = await queue.enqueue({ accountId: 'alice', ...message() });
    await queue.enqueue({ accountId: 'alice', ...message('bob', 'later') });
    const claimed = await queue.claim('alice');
    await store.execAsync(`CREATE TRIGGER reject_receipt BEFORE UPDATE OF result ON outbox
      BEGIN SELECT RAISE(ABORT, 'receipt disk failure'); END`);
    await expect(queue.applySendResult(claimed!, { status: 'ok', data: { result: receipt } }))
      .rejects.toThrow('receipt disk failure');
    expect(await getOperation(store, 'alice', old.operation.operationId)).toMatchObject({ state: 'sending', result: null });
    expect(await queue.claim('alice')).toBeNull();
    await store.execAsync('DROP TRIGGER reject_receipt');
    expect(await queue.applySendResult(claimed!, { status: 'ok', data: { result: receipt } })).toBe('succeeded');
  });

  it.each([undefined, {}, { result: { ...receipt, sequence: 0 } }])('keeps a success without a usable receipt unresolved (%p)', async data => {
    await queue.enqueue({ accountId: 'alice', ...message() });
    const claimed = await queue.claim('alice');
    expect(await queue.applySendResult(claimed!, { status: 'ok', data })).toBe('sent_unknown');
    expect(await queue.claim('alice')).toBeNull();
  });
});
