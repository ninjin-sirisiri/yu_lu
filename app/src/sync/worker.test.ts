import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openAppDatabase, type AppStorage } from '../storage/database';
import { getOperation, listOperations } from '../storage/outbox';
import { NodeSqliteDriver } from '../storage/testSupport/nodePorts';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as appClient from '../backend/client';
import {
  PENDING_DEADLINE_MS,
  SEND_LEASE_MS,
  createSyncQueue,
  type SyncQueue,
} from './queue';
import { RETRY_BASE_MS } from './retry';
import {
  createCommandApi,
  type CommandEnvelope,
  type CommandOutcome,
} from './api';
import { createSyncWorker } from './worker';

// Task 9: worker tests. Every scenario from the brief runs against real
// SQLite with an injected fake network port and a manual clock: acceptance
// then lost response, claim recovery after a restart, the cancel race,
// the 24-hour overdue rule next to an unknown result, independent
// operations, and account switching. The final describe pins the default
// CommandApi's wire shape and outcome classification.

const T0 = 1_700_000_000_000;

function testUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface Harness {
  readonly storage: AppStorage;
  makeQueue(): SyncQueue;
  /** Close and reopen the database file on the same path (restart). */
  reopen(): Promise<SyncQueue>;
  advance(ms: number): void;
  now(): number;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-sync-worker-'));
  const dbPath = path.join(root, 'app.db');
  const opened: AppStorage[] = [];
  const clock = { value: T0 };
  let idSeq = 0;
  const random = () => 0.5;
  let storage: AppStorage = await openAppDatabase({
    driver: new NodeSqliteDriver(dbPath),
  });
  opened.push(storage);

  function makeQueue(handle: AppStorage = storage): SyncQueue {
    return createSyncQueue({
      store: handle,
      clock: { now: () => clock.value },
      random,
      newOperationId: () => testUuid(idSeq++),
    });
  }

  return {
    get storage() {
      return storage;
    },
    makeQueue: () => makeQueue(),
    async reopen() {
      await storage.close();
      storage = await openAppDatabase({
        driver: new NodeSqliteDriver(dbPath),
      });
      opened.push(storage);
      return makeQueue(storage);
    },
    advance: (ms: number) => {
      clock.value += ms;
    },
    now: () => clock.value,
    async cleanup() {
      for (const handle of opened) {
        try {
          await handle.close();
        } catch {
          // Already closed by a test.
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

interface FakeApi {
  readonly calls: CommandEnvelope[];
  readonly api: { send(command: CommandEnvelope): Promise<CommandOutcome> };
  /** Queue scripted outcomes; falls back to `ok` when exhausted. */
  script(...outcomes: CommandOutcome[]): void;
  /** Take full control of the next sends (deferred promises etc.). */
  respond(fn: (command: CommandEnvelope) => Promise<CommandOutcome>): void;
}

function createFakeApi(): FakeApi {
  const calls: CommandEnvelope[] = [];
  let queue: CommandOutcome[] = [];
  let handler: ((command: CommandEnvelope) => Promise<CommandOutcome>) | null = null;
  return {
    calls,
    api: {
      send(command: CommandEnvelope) {
        calls.push(command);
        if (handler) return handler(command);
        return Promise.resolve(queue.shift() ?? { status: 'ok' });
      },
    },
    script(...outcomes: CommandOutcome[]) {
      queue = [...outcomes];
      handler = null;
    },
    respond(fn: (command: CommandEnvelope) => Promise<CommandOutcome>) {
      handler = fn;
    },
  };
}

async function flushUntil(condition: () => boolean, limit = 100): Promise<void> {
  for (let i = 0; i < limit && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!condition()) throw new Error('condition not reached');
}

const PROFILE = { kind: 'update_profile', payload: { display_name: 'A' } };
const REQUEST = { kind: 'send_request', payload: { to: 'bob' } };

describe('chat FIFO worker', () => {
  const chat = (peer: string, body: string) => ({ kind: 'send_message', payload: {
    recipient_id: peer, client_key: body, friendship_epoch: 'epoch', body, media_ids: [],
  } });
  const accepted: CommandOutcome = { status: 'ok', data: { result: {
    message_id: 'm', conversation_id: 'c', sequence: 1, accepted_at: '2026-10-28T01:00:00.123456Z',
  } } };

  it.each(['transient', 'unknown', 'rejected'] as const)('does not overtake a %s chat head but drains another peer and profile', async status => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });
    const a = await queue.enqueue({ accountId: 'alice', ...chat('bob', 'first') });
    const b = await queue.enqueue({ accountId: 'alice', ...chat('bob', 'second') });
    const c = await queue.enqueue({ accountId: 'alice', ...chat('carol', 'other') });
    const p = await queue.enqueue({ accountId: 'alice', ...PROFILE });
    api.script(status === 'rejected' ? { status, httpStatus: 400, message: 'invalid' } : { status }, accepted, { status: 'ok' });
    const steps = await worker.runUntilIdle();
    expect(steps.map(step => step.operationId)).toEqual([a.operation.operationId, c.operation.operationId, p.operation.operationId]);
    expect((await getOperation(harness.storage, 'alice', b.operation.operationId))?.attempts).toBe(0);
  });

  it('treats a throwing chat transport as unknown and forbids cancellation or a fresh-id retry', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });
    const { operation } = await queue.enqueue({ accountId: 'alice', ...chat('bob', 'first') });
    api.respond(() => Promise.reject(new Error('response lost')));
    expect((await worker.runOnce())?.state).toBe('sent_unknown');
    expect(await queue.cancelUnsent('alice', operation.operationId)).toBe(false);
    await expect(queue.retryAsNew({ accountId: 'alice', operationId: operation.operationId })).rejects.toMatchObject({ code: 'not_retryable' });
    harness.advance(PENDING_DEADLINE_MS + 1);
    api.script(accepted);
    expect((await worker.runOnce())?.operationId).toBe(operation.operationId);
    expect((await getOperation(harness.storage, 'alice', operation.operationId))?.result).toMatchObject({ messageId: 'm', sequence: 1 });
  });

  it('ignores an old worker completion while its recovered claim is still sending', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });
    const { operation } = await queue.enqueue({ accountId: 'alice', ...chat('bob', 'first') });
    const releases: Array<(result: CommandOutcome) => void> = [];
    api.respond(() => new Promise(resolve => releases.push(resolve)));
    const first = worker.runOnce();
    await flushUntil(() => releases.length === 1);
    harness.advance(SEND_LEASE_MS);
    const second = createSyncWorker({ queue: harness.makeQueue(), api: api.api, accountId: 'alice' }).runOnce();
    await flushUntil(() => releases.length === 2);
    releases[0]({ status: 'rejected', httpStatus: 403, message: 'stale' });
    expect((await first)?.state).toBe('sending');
    releases[1](accepted);
    expect((await second)?.state).toBe('succeeded');
    expect((await getOperation(harness.storage, 'alice', operation.operationId))?.reachStage).toBe('accepted');
  });
});

describe('acceptance-then-lost-response', () => {
  it('confirms with the same operation id instead of condemning at 24 hours', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });
    const { operation } = await queue.enqueue({ accountId: 'alice', ...PROFILE });

    api.script({ status: 'unknown' }); // server accepted; the response is lost
    const first = await worker.runOnce();
    expect(first?.outcome).toBe('unknown');
    expect(first?.state).toBe('sent_unknown');
    expect(api.calls).toHaveLength(1);

    // 24 hours pass without any answer.
    harness.advance(PENDING_DEADLINE_MS + 1);

    const second = await worker.runOnce();
    expect(second?.state).toBe('succeeded'); // still auto-confirmed, not swept
    expect(api.calls).toHaveLength(2);
    // Result confirmation re-sends the SAME id - the server replays it.
    expect(api.calls[1].operationId).toBe(api.calls[0].operationId);
    expect(api.calls[1].operationId).toBe(operation.operationId);

    const rows = await listOperations(harness.storage, 'alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('succeeded');
    expect(rows[0].expiresAt).toBe(T0 + PENDING_DEADLINE_MS); // never extended
  });

  it('keeps a lost response visible as result confirmation while it waits', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });
    await queue.enqueue({ accountId: 'alice', ...PROFILE });

    api.script({ status: 'unknown' });
    await worker.runOnce();

    // Within the backoff window nothing is re-sent…
    expect(await worker.runOnce()).toBeNull();
    expect(api.calls).toHaveLength(1);
    const stored = await listOperations(harness.storage, 'alice');
    expect(stored[0].state).toBe('sent_unknown');
    expect(stored[0].nextAttemptAt).toBe(T0 + RETRY_BASE_MS);
  });
});

describe('claim recovery after restart', () => {
  it('recovers a claim lost in a crash and re-sends the same id', async () => {
    const queue = harness.makeQueue();
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const claimed = await queue.claim('alice');
    expect(claimed?.state).toBe('sending');
    // The app dies here: nothing settles the claim.

    const api = createFakeApi();
    const restarted = await harness.reopen();
    const worker = createSyncWorker({ queue: restarted, api: api.api, accountId: 'alice' });

    // While the lease is alive the stale claim is left alone.
    expect(await worker.runOnce()).toBeNull();
    expect(api.calls).toHaveLength(0);

    harness.advance(SEND_LEASE_MS + 1);
    const step = await worker.runOnce();
    expect(step?.state).toBe('succeeded');
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].operationId).toBe(operation.operationId); // same id
    const stored = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(stored?.state).toBe('succeeded');
    expect(stored?.attempts).toBe(2); // original claim + recovery claim
  });
});

describe('cancel race', () => {
  it('a cancel that wins the guard leaves nothing to send', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });

    expect(await queue.cancelUnsent('alice', operation.operationId)).toBe(true);
    expect(await worker.runOnce()).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it('a cancel that loses to the claim does not interrupt the send', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });

    let release!: (outcome: CommandOutcome) => void;
    api.respond(
      () =>
        new Promise<CommandOutcome>((resolve) => {
          release = resolve;
        }),
    );

    const run = worker.runOnce();
    await flushUntil(() => api.calls.length === 1);

    // Mid-send: state is 送信中 and the guarded cancel loses.
    const mid = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(mid?.state).toBe('sending');
    expect(await queue.cancelUnsent('alice', operation.operationId)).toBe(false);

    release({ status: 'ok' });
    const step = await run;
    expect(step?.outcome).toBe('ok');
    expect(step?.state).toBe('succeeded');
  });
});

describe('24h-overdue', () => {
  it('never auto-executes overdue unsent work and re-sends it as a new operation', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });
    const old = await queue.enqueue({ accountId: 'alice', ...REQUEST });

    harness.advance(PENDING_DEADLINE_MS + 1);
    expect(await worker.runOnce()).toBeNull(); // swept, NOT executed
    expect(api.calls).toHaveLength(0);
    const swept = await getOperation(harness.storage, 'alice', old.operation.operationId);
    expect(swept?.state).toBe('needs_confirmation');

    // The user confirmed the content and the latest state on screen.
    const fresh = await queue.retryAsNew({
      accountId: 'alice',
      operationId: old.operation.operationId,
      payload: { to: 'bob', note: 'confirmed' },
    });

    const step = await worker.runOnce();
    expect(step?.outcome).toBe('ok');
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].operationId).toBe(fresh.operationId);
    expect(api.calls[0].operationId).not.toBe(old.operation.operationId);
    expect(api.calls[0].payload).toEqual({ to: 'bob', note: 'confirmed' });
    expect(
      (await getOperation(harness.storage, 'alice', old.operation.operationId))?.state,
    ).toBe('superseded');
  });
});

describe('independent operations', () => {
  it('holds only the same target behind an unknown result while others flow', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });

    const p1 = await queue.enqueue({ accountId: 'alice', ...PROFILE });
    const request = await queue.enqueue({ accountId: 'alice', ...REQUEST });

    api.script({ status: 'unknown' }); // first send (p1) loses its response
    const first = await worker.runOnce();
    expect(first?.operationId).toBe(p1.operation.operationId);
    expect(first?.outcome).toBe('unknown');

    // The unrelated request continues while the profile result is unknown.
    const second = await worker.runOnce();
    expect(second?.operationId).toBe(request.operation.operationId);
    expect(second?.outcome).toBe('ok');
    expect(api.calls).toHaveLength(2);

    // A later profile save must not overtake the unknown earlier one.
    const p2 = await queue.enqueue({
      accountId: 'alice',
      kind: 'update_profile',
      payload: { display_name: 'B' },
    });
    expect(p2.coalesced).toBe(false);
    expect(await worker.runOnce()).toBeNull();
    expect(api.calls).toHaveLength(2);
    expect(p2.operation.operationId).not.toBe(p1.operation.operationId);

    // Once the earlier result is confirmed, the waiting save goes out -
    // with its own new operation id.
    harness.advance(RETRY_BASE_MS);
    const confirm = await worker.runOnce();
    expect(confirm?.operationId).toBe(p1.operation.operationId);
    expect(confirm?.state).toBe('succeeded');

    const later = await worker.runOnce();
    expect(later?.operationId).toBe(p2.operation.operationId);
    expect(later?.state).toBe('succeeded');
    expect(api.calls[3].operationId).toBe(p2.operation.operationId);
    expect(api.calls[3].operationId).not.toBe(p1.operation.operationId);
  });

  it('a permanently failed operation does not stall unrelated work', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });

    const profile = await queue.enqueue({ accountId: 'alice', ...PROFILE });
    const request = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    api.script({ status: 'rejected', httpStatus: 403, message: 'permission denied' });

    const first = await worker.runOnce();
    expect(first?.operationId).toBe(profile.operation.operationId);
    expect(first?.outcome).toBe('rejected');
    expect(first?.state).toBe('failed_permanent');

    const second = await worker.runOnce();
    expect(second?.operationId).toBe(request.operation.operationId);
    expect(second?.outcome).toBe('ok');
  });
});

describe('transient failures', () => {
  it('backs off from 5 seconds, doubling, without extending the deadline', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });

    api.script({ status: 'transient', message: 'offline' }, { status: 'transient', message: 'offline' });
    const steps = await worker.runUntilIdle();
    expect(steps).toHaveLength(1); // nothing else is due → the loop stops
    expect(steps[0].state).toBe('pending');

    let stored = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(stored?.nextAttemptAt).toBe(T0 + RETRY_BASE_MS);
    expect(stored?.expiresAt).toBe(T0 + PENDING_DEADLINE_MS);

    harness.advance(RETRY_BASE_MS);
    const second = await worker.runUntilIdle();
    expect(second).toHaveLength(1);
    stored = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(stored?.attempts).toBe(2);
    expect(stored?.nextAttemptAt).toBe(T0 + RETRY_BASE_MS + 2 * RETRY_BASE_MS);
    expect(stored?.expiresAt).toBe(T0 + PENDING_DEADLINE_MS); // still the original

    // Past the original deadline the sweep wins over further retries.
    harness.advance(PENDING_DEADLINE_MS);
    expect(await worker.runUntilIdle()).toHaveLength(0);
    stored = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(stored?.state).toBe('needs_confirmation');
    expect(stored?.expiresAt).toBe(T0 + PENDING_DEADLINE_MS);
    expect(api.calls).toHaveLength(2);
  });

  it('turns a throwing port into a scheduled retry instead of losing the row', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();
    const worker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    api.respond(() => Promise.reject(new Error('boom')));

    const step = await worker.runOnce();
    expect(step?.outcome).toBe('transient');
    expect(step?.state).toBe('pending');
    const stored = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(stored?.nextAttemptAt).toBe(T0 + RETRY_BASE_MS);
  });
});

describe('account switching', () => {
  it('sends only the bound account’s operations, one account after the other', async () => {
    const queue = harness.makeQueue();
    const api = createFakeApi();

    const aliceOp = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const bobOp = await queue.enqueue({ accountId: 'bob', ...REQUEST });

    const aliceWorker = createSyncWorker({ queue, api: api.api, accountId: 'alice' });
    const aliceSteps = await aliceWorker.runUntilIdle();
    expect(aliceSteps).toHaveLength(1);
    expect(api.calls.map((call) => call.accountId)).toEqual(['alice']);
    expect(api.calls[0].operationId).toBe(aliceOp.operation.operationId);

    // Switching accounts binds a worker to the new account; the old
    // account's queue is untouched and nothing leaks across.
    const bobWorker = createSyncWorker({ queue, api: api.api, accountId: 'bob' });
    const bobSteps = await bobWorker.runUntilIdle();
    expect(bobSteps).toHaveLength(1);
    expect(api.calls.map((call) => call.accountId)).toEqual(['alice', 'bob']);
    expect(api.calls[1].operationId).toBe(bobOp.operation.operationId);

    expect(
      (await getOperation(harness.storage, 'alice', aliceOp.operation.operationId))?.state,
    ).toBe('succeeded');
    expect(
      (await getOperation(harness.storage, 'bob', bobOp.operation.operationId))?.state,
    ).toBe('succeeded');
    expect(await aliceWorker.runUntilIdle()).toHaveLength(0);
    expect(await bobWorker.runUntilIdle()).toHaveLength(0);
  });
});

describe('createCommandApi (default network port)', () => {
  function fakeSupabase(options: {
    userId?: string | null;
    invoke?: () => Promise<{ data: unknown; error: unknown }>;
  }) {
    const calls: Array<{ name: string; body: unknown }> = [];
    const client = {
      auth: {
        getSession: () => {
          const userId = options.userId === undefined ? 'alice' : options.userId;
          return Promise.resolve({
            data: { session: userId ? { user: { id: userId } } : null },
            error: null,
          });
        },
      },
      functions: {
        invoke: (name: string, opts: { body: unknown }) => {
          calls.push({ name, body: opts.body });
          return options.invoke
            ? options.invoke()
            : Promise.resolve({ data: { result: { status: 'ok' } }, error: null });
        },
      },
    };
    return { calls, client: client as never };
  }

  const envelope: CommandEnvelope = {
    accountId: 'alice',
    operationId: '11111111-1111-4111-8111-111111111111',
    kind: 'update_profile',
    payload: { base_version: 3, display_name: 'A' },
  };

  it('posts the app-command wire envelope and reports success', async () => {
    const fake = fakeSupabase({});
    const api = createCommandApi({ client: fake.client });

    const outcome = await api.send(envelope);

    expect(outcome.status).toBe('ok');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].name).toBe('app-command');
    expect(fake.calls[0].body).toEqual({
      operation_id: envelope.operationId,
      kind: envelope.kind,
      payload: envelope.payload,
    });
  });

  it('uses the signed-in app client for queued commands by default', async () => {
    const fake = fakeSupabase({});
    const shared = jest.spyOn(appClient, 'getAppClient').mockReturnValue(fake.client);
    try {
      const outcome = await createCommandApi().send(envelope);
      expect(outcome.status).toBe('ok');
      expect(fake.calls).toHaveLength(1);
    } finally {
      shared.mockRestore();
    }
  });

  it('maps the structured 409 body to a conflict outcome', async () => {
    const conflict = {
      status: 'conflict',
      message: 'profile version conflict',
      version: 9,
      profile: { display_name: 'Other' },
      differing_fields: ['display_name'],
    };
    const fake = fakeSupabase({
      invoke: () =>
        Promise.resolve({
          data: null,
          error: {
            message: 'conflict',
            context: {
              status: 409,
              json: () => Promise.resolve({ error: conflict.message, conflict }),
            },
          },
        }),
    });
    const api = createCommandApi({ client: fake.client });

    const outcome = await api.send(envelope);

    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') {
      expect(outcome.message).toBe('profile version conflict');
      expect(outcome.conflict).toEqual(conflict);
    }
  });

  it.each([[403], [400], [401], [404]])(
    'classifies HTTP %i as rejected (not transient)',
    async (status) => {
      const fake = fakeSupabase({
        invoke: () =>
          Promise.resolve({
            data: null,
            error: {
              message: 'denied',
              context: { status, json: () => Promise.resolve({ error: 'denied' }) },
            },
          }),
      });
      const api = createCommandApi({ client: fake.client });
      const outcome = await api.send(envelope);
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') expect(outcome.httpStatus).toBe(status);
    },
  );

  it.each([[500], [503], [429], [408]])(
    'classifies HTTP %i as transient',
    async (status) => {
      const fake = fakeSupabase({
        invoke: () =>
          Promise.resolve({
            data: null,
            error: {
              message: 'server error',
              context: { status, json: () => Promise.resolve({ error: 'server error' }) },
            },
          }),
      });
      const api = createCommandApi({ client: fake.client });
      const outcome = await api.send(envelope);
      expect(outcome.status).toBe('transient');
      if (outcome.status === 'transient') expect(outcome.httpStatus).toBe(status);
    },
  );

  it('classifies connection failures without a status as transient', async () => {
    const fake = fakeSupabase({
      invoke: () =>
        Promise.resolve({
          data: null,
          error: new TypeError('Network request failed'),
        }),
    });
    const api = createCommandApi({ client: fake.client });

    const outcome = await api.send(envelope);

    expect(outcome.status).toBe('transient');
  });

  it('refuses to send a queued operation under a different account', async () => {
    const fake = fakeSupabase({ userId: 'bob' });
    const api = createCommandApi({ client: fake.client });

    const outcome = await api.send(envelope);

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.httpStatus).toBe(401);
    expect(fake.calls).toHaveLength(0); // never left the device
  });

  it('refuses to send without a session', async () => {
    const fake = fakeSupabase({ userId: null });
    const api = createCommandApi({ client: fake.client });

    const outcome = await api.send(envelope);

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.httpStatus).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });
});
