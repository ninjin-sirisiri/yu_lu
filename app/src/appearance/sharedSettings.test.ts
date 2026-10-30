import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CommandEnvelope, CommandOutcome } from '../sync/api';
import { deleteAccountData, openAppDatabase, type AppStorage } from '../storage/database';
import { readCache, writeCache } from '../storage/cache';
import { listOperations } from '../storage/outbox';
import { createRepositorySession, type RepositorySession } from '../messages/repository';
import { A, B, C, E, E2 } from '../messages/repositoryTestSupport';
import { NodeSqliteDriver } from '../storage/testSupport/nodePorts';
import {
  createSharedAppearanceSettings,
  loadPendingAppearanceCommand,
  pendingAppearanceCommandKey,
  type PendingAppearanceCommand,
} from './sharedSettings';

let db: AppStorage;
let dir: string;
let now: number;

beforeEach(async () => {
  now = 1_000_000;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-appearance-'));
  db = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(dir, 'app.db')) });
});

afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function sessionFor(accountId: string, current: () => string = () => accountId): RepositorySession {
  return createRepositorySession({ storage: db, accountId, getAccountId: async () => current() });
}

function controller(
  session: RepositorySession,
  send: (envelope: CommandEnvelope) => Promise<CommandOutcome>,
  options: { isOnline?: () => boolean; random?: () => number } = {},
) {
  return createSharedAppearanceSettings({
    session,
    commandApi: { send: jest.fn(send) },
    isOnline: options.isOnline ?? (() => true),
    random: options.random ?? (() => 0.25),
    now: () => now,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const key = (peerId: string) => pendingAppearanceCommandKey(peerId);

async function waitForPending(
  controllerA: ReturnType<typeof createSharedAppearanceSettings>,
  peerId: string,
): Promise<PendingAppearanceCommand> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await controllerA.pending(peerId);
    if (record) return record;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('pending record was never persisted');
}

it('reports no pending record and does not crash on an invalid cached record', async () => {
  const session = sessionFor(A);
  const controllerA = controller(session, async () => ({ status: 'ok' }));

  expect(await controllerA.pending(B)).toBeNull();
  expect(await loadPendingAppearanceCommand(db, A, B)).toBeNull();

  await writeCache(db, A, key(B), {
    operationId: 'not-a-record',
    peerId: B,
    friendshipEpoch: E,
    presetId: 'b-candy',
    state: 'dispatching',
  });
  expect(await controllerA.pending(B)).toBeNull();
  expect(await loadPendingAppearanceCommand(db, A, B)).toBeNull();
});

it('sends the exact payload once after persisting a dispatching record first', async () => {
  const session = sessionFor(A);
  let observed: PendingAppearanceCommand | null = null;
  const send = jest.fn(async (_envelope: CommandEnvelope): Promise<CommandOutcome> => {
    observed = await loadPendingAppearanceCommand(db, A, B);
    return { status: 'ok' };
  });
  const controllerA = controller(session, send);
  await writeCache(db, A, 'chat.peer.B', { selected: 'original' });

  const result = await controllerA.apply({ peerId: B, friendshipEpoch: E, presetId: 'b-candy' });

  expect(result).toMatchObject({ status: 'applied', pending: null });
  expect(send).toHaveBeenCalledTimes(1);
  const envelope = send.mock.calls[0][0];
  expect(envelope).toEqual(expect.objectContaining({
    accountId: A,
    kind: 'set_chat_appearance',
    payload: { peer_id: B, friendship_epoch: E, preset_id: 'b-candy' },
  }));
  expect(observed).toEqual(expect.objectContaining({
    operationId: envelope.operationId,
    peerId: B,
    friendshipEpoch: E,
    presetId: 'b-candy',
    state: 'dispatching',
    createdAt: now,
  }));
  expect(await controllerA.pending(B)).toBeNull();
  expect((await readCache(db, A, 'chat.peer.B'))?.payload).toEqual({ selected: 'original' });
  expect(await listOperations(db, A)).toEqual([]);
});

it('does not dispatch twice while the same peer is already dispatching', async () => {
  const session = sessionFor(A);
  const gate = deferred<CommandOutcome>();
  const send = jest.fn(() => gate.promise);
  const controllerA = controller(session, send);

  const first = controllerA.apply({ peerId: B, friendshipEpoch: E, presetId: 'b-candy' });
  const second = await controllerA.apply({ peerId: B, friendshipEpoch: E, presetId: 'b-soda' });

  expect(second.status).toBe('blocked');
  expect(second.pending?.operationId).toEqual(expect.any(String));

  gate.resolve({ status: 'ok' });
  await expect(first).resolves.toMatchObject({ status: 'applied' });
  expect(send).toHaveBeenCalledTimes(1);
});

it('rejects an offline change without recording or sending', async () => {
  const session = sessionFor(A);
  const send = jest.fn(async (): Promise<CommandOutcome> => ({ status: 'ok' }));
  const controllerA = controller(session, send, { isOnline: () => false });

  const result = await controllerA.apply({ peerId: B, friendshipEpoch: E, presetId: 'b-candy' });

  expect(result.status).toBe('offline');
  expect(result.message).toEqual(expect.stringContaining('オフライン'));
  expect(send).not.toHaveBeenCalled();
  expect(await controllerA.pending(B)).toBeNull();
  expect(await readCache(db, A, key(B))).toBeNull();
});

it('clears a definitely rejected change and returns its message', async () => {
  const session = sessionFor(A);
  const controllerA = controller(session, async () => ({
    status: 'rejected', httpStatus: 403, message: 'この関係では変更できません。',
  }));

  const result = await controllerA.apply({ peerId: B, friendshipEpoch: E, presetId: 'b-candy' });

  expect(result).toMatchObject({ status: 'rejected', message: 'この関係では変更できません。', pending: null });
  expect(await controllerA.pending(B)).toBeNull();
  expect(await readCache(db, A, key(B))).toBeNull();
});

it('keeps the same operation id and payload on an uncertain result, blocks a new change, then confirms with exactly that id', async () => {
  const session = sessionFor(A);
  const send = jest.fn()
    .mockResolvedValueOnce({ status: 'transient', httpStatus: 503, message: 'gateway lost' })
    .mockResolvedValueOnce({ status: 'ok' });
  const controllerA = controller(session, send);
  await writeCache(db, A, 'chat.peer.B', { selected: 'confirmed-original' });

  const first = await controllerA.apply({ peerId: B, friendshipEpoch: E, presetId: 'b-candy' });

  expect(first.status).toBe('unknown');
  expect(first.pending).toMatchObject({
    peerId: B, friendshipEpoch: E, presetId: 'b-candy', state: 'unknown',
  });
  const operationId = first.pending!.operationId;
  expect(await controllerA.pending(B)).toEqual(expect.objectContaining({
    operationId, friendshipEpoch: E, presetId: 'b-candy', state: 'unknown',
  }));
  expect(await listOperations(db, A)).toEqual([]);
  expect((await readCache(db, A, 'chat.peer.B'))?.payload).toEqual({ selected: 'confirmed-original' });

  const blocked = await controllerA.apply({ peerId: B, friendshipEpoch: E2, presetId: 'b-soda' });
  expect(blocked).toMatchObject({ status: 'blocked', pending: expect.objectContaining({ operationId }) });
  expect(send).toHaveBeenCalledTimes(1);

  const confirmed = await controllerA.confirm(B);

  expect(confirmed).toMatchObject({ status: 'applied', pending: null });
  expect(send).toHaveBeenCalledTimes(2);
  const firstEnvelope = send.mock.calls[0][0] as CommandEnvelope;
  const confirmEnvelope = send.mock.calls[1][0] as CommandEnvelope;
  expect(confirmEnvelope.operationId).toBe(firstEnvelope.operationId);
  expect(confirmEnvelope.payload).toEqual(firstEnvelope.payload);
  expect(confirmEnvelope.payload).toEqual({ peer_id: B, friendship_epoch: E, preset_id: 'b-candy' });
  expect(await controllerA.pending(B)).toBeNull();
  expect(await controllerA.confirm(B)).toMatchObject({ status: 'none', pending: null });
});

it('loads the pending record after a restart and preserves the original relationship epoch', async () => {
  const firstSession = sessionFor(A);
  const firstController = controller(firstSession, async () => ({
    status: 'unknown', message: 'response lost',
  }));
  const applied = await firstController.apply({ peerId: B, friendshipEpoch: E, presetId: 'b-soda' });
  expect(applied.status).toBe('unknown');
  const operationId = applied.pending!.operationId;
  firstSession.stop();

  const restartSession = sessionFor(A);
  const restartSend = jest.fn(async (): Promise<CommandOutcome> => ({ status: 'ok' }));
  const restarted = controller(restartSession, restartSend);

  expect(await restarted.pending(B)).toEqual(expect.objectContaining({
    operationId, friendshipEpoch: E, presetId: 'b-soda', state: 'unknown',
  }));
  const result = await restarted.confirm(B);
  expect(result.status).toBe('applied');
  expect(restartSend).toHaveBeenCalledWith(expect.objectContaining({
    operationId,
    payload: { peer_id: B, friendship_epoch: E, preset_id: 'b-soda' },
  }));
});

it('does not apply an old response after the caller left and keeps the record for recovery', async () => {
  const session = sessionFor(A);
  const gate = deferred<CommandOutcome>();
  const send = jest.fn(() => gate.promise);
  const controllerA = controller(session, send);
  let current = true;

  const pendingApply = controllerA.apply({
    peerId: B, friendshipEpoch: E, presetId: 'b-candy', isCurrent: () => current,
  });
  const before = await waitForPending(controllerA, B);

  current = false;
  gate.resolve({ status: 'ok' });
  const result = await pendingApply;

  expect(result.status).toBe('unknown');
  expect((await controllerA.pending(B))?.operationId).toBe(before!.operationId);
  expect(await readCache(db, A, key(B))).not.toBeNull();

  current = true;
  send.mockResolvedValueOnce({ status: 'ok' });
  await expect(controllerA.confirm(B, { isCurrent: () => current })).resolves.toMatchObject({ status: 'applied' });
  expect(await controllerA.pending(B)).toBeNull();
});

it('does not commit or remove a record after the account lifetime stops', async () => {
  const session = sessionFor(A);
  const gate = deferred<CommandOutcome>();
  const send = jest.fn(() => gate.promise);
  const controllerA = controller(session, send);

  const pendingApply = controllerA.apply({ peerId: B, friendshipEpoch: E, presetId: 'b-candy' });
  const before = await waitForPending(controllerA, B);
  session.stop();
  gate.resolve({ status: 'ok' });

  await expect(pendingApply).resolves.toMatchObject({ status: 'unknown' });
  expect((await controllerA.pending(B))?.operationId).toBe(before!.operationId);
  await expect(controllerA.confirm(B)).resolves.toMatchObject({ status: 'blocked' });
});

it('does not overwrite a newer record with a late response from an earlier operation id', async () => {
  const session = sessionFor(A);
  const gate = deferred<CommandOutcome>();
  const dispatched = deferred<undefined>();
  const send = jest.fn(() => { dispatched.resolve(undefined); return gate.promise; });
  const controllerA = controller(session, send);

  const pendingApply = controllerA.apply({ peerId: B, friendshipEpoch: E, presetId: 'b-candy' });
  await dispatched.promise;
  const first = await controllerA.pending(B);
  const newer: PendingAppearanceCommand = {
    ...first!,
    operationId: '99999999-9999-4999-8999-999999999999',
    presetId: 'b-soda',
    createdAt: now + 1,
  };
  await writeCache(db, A, key(B), newer);

  gate.resolve({ status: 'ok' });
  await expect(pendingApply).resolves.toMatchObject({ status: 'unknown' });
  expect(await controllerA.pending(B)).toEqual(newer);
});

it('keeps records and operation ids separated by account', async () => {
  let currentA = A;
  let currentC = C;
  const sessionA = sessionFor(A, () => currentA);
  const sessionC = sessionFor(C, () => currentC);
  const sendA = jest.fn(async (): Promise<CommandOutcome> => ({ status: 'unknown' }));
  const sendC = jest.fn(async (): Promise<CommandOutcome> => ({ status: 'unknown' }));
  const controllerA = controller(sessionA, sendA);
  const controllerC = controller(sessionC, sendC);

  const resultA = await controllerA.apply({ peerId: B, friendshipEpoch: E, presetId: 'b-candy' });
  const resultC = await controllerC.apply({ peerId: B, friendshipEpoch: E2, presetId: 'b-soda' });

  expect(resultA.pending?.operationId).not.toBe(resultC.pending?.operationId);
  expect(await controllerC.pending(B)).toMatchObject({ friendshipEpoch: E2, presetId: 'b-soda' });
  expect((await readCache(db, A, key(B)))?.payload).toMatchObject({ friendshipEpoch: E, presetId: 'b-candy' });
  expect((await readCache(db, C, key(B)))?.payload).toMatchObject({ friendshipEpoch: E2, presetId: 'b-soda' });

  await deleteAccountData(db, A);
  expect(await controllerA.pending(B)).toBeNull();
  expect(await controllerC.pending(B)).toMatchObject({ friendshipEpoch: E2, presetId: 'b-soda' });
});

it('returns offline from confirm without sending and keeps the pending record', async () => {
  const session = sessionFor(A);
  let online = true;
  const send = jest.fn(async (): Promise<CommandOutcome> => ({ status: 'unknown' }));
  const controllerA = controller(session, send, { isOnline: () => online });
  const first = await controllerA.apply({ peerId: B, friendshipEpoch: E, presetId: 'b-candy' });
  online = false;

  const result = await controllerA.confirm(B);

  expect(result).toMatchObject({ status: 'offline', pending: expect.objectContaining({ operationId: first.pending?.operationId }) });
  expect(send).toHaveBeenCalledTimes(1);
});
