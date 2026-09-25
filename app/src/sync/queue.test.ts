import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openAppDatabase, type AppStorage } from '../storage/database';
import { getOperation, listOperations, removeOperation } from '../storage/outbox';
import { NodeSqliteDriver } from '../storage/testSupport/nodePorts';
import {
  PENDING_DEADLINE_MS,
  QueueError,
  SEND_LEASE_MS,
  createSyncQueue,
  type QueueErrorCode,
  type SyncQueue,
} from './queue';
import { RETRY_BASE_MS, RETRY_MAX_MS, backoffDelay, nextAttemptAt } from './retry';

// Task 9: queue state-machine tests against a real SQLite file (the same
// SQL the device build runs, through node:sqlite). The clock and the
// random source are injected, so every deadline, lease and jitter value is
// asserted exactly; no test sleeps or depends on wall-clock time.

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-sync-queue-'));
  const dbPath = path.join(root, 'app.db');
  const opened: AppStorage[] = [];
  const clock = { value: T0 };
  let idSeq = 0;
  const random = () => 0.5; // jitter factor 1.0 → exact backoff values
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

async function expectQueueCode(promise: Promise<unknown>, code: QueueErrorCode): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(QueueError);
  expect((error as QueueError).code).toBe(code);
}

const PROFILE = { kind: 'update_profile', payload: { display_name: 'A' } };
const REQUEST = { kind: 'send_request', payload: { to: 'bob' } };

describe('enqueue', () => {
  it('persists the operation id before anything can send it', async () => {
    const queue = harness.makeQueue();
    const { operation, coalesced } = await queue.enqueue({
      accountId: 'alice',
      ...PROFILE,
      baseVersion: 3,
    });

    expect(coalesced).toBe(false);
    const stored = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(stored).not.toBeNull();
    expect(stored?.state).toBe('pending');
    expect(stored?.createdAt).toBe(T0);
    expect(stored?.expiresAt).toBe(T0 + PENDING_DEADLINE_MS);
    expect(stored?.attempts).toBe(0);
    expect(stored?.nextAttemptAt).toBeNull();
    expect(stored?.baseVersion).toBe(3);
  });

  it.each([[null], [[]], [['not an object']], ['string']])(
    'rejects non-object payload %p',
    async (payload) => {
      const queue = harness.makeQueue();
      await expectQueueCode(
        queue.enqueue({ accountId: 'alice', kind: 'update_profile', payload: payload as never }),
        'invalid_payload',
      );
      expect(await listOperations(harness.storage, 'alice')).toHaveLength(0);
    },
  );

  it('coalesces unsent profile saves into the latest content', async () => {
    const queue = harness.makeQueue();
    const first = await queue.enqueue({ accountId: 'alice', ...PROFILE });

    // Make the row retry-waiting so the merge must also reset the schedule.
    const claimed = await queue.claim('alice');
    expect(claimed?.attempts).toBe(1);
    await queue.applySendResult(claimed!, { status: 'transient', message: 'offline' });

    harness.advance(60_000);
    const second = await queue.enqueue({
      accountId: 'alice',
      kind: 'update_profile',
      payload: { display_name: 'B', introduction: 'latest' },
      baseVersion: 4,
    });

    expect(second.coalesced).toBe(true);
    expect(second.operation.operationId).toBe(first.operation.operationId);
    expect(second.operation.payload).toEqual({ display_name: 'B', introduction: 'latest' });
    expect(second.operation.baseVersion).toBe(4);
    expect(second.operation.state).toBe('pending');
    expect(second.operation.attempts).toBe(0);
    expect(second.operation.nextAttemptAt).toBeNull();
    // Deadline restarts from the LATEST save, not the original enqueue.
    expect(second.operation.expiresAt).toBe(harness.now() + PENDING_DEADLINE_MS);
    expect(await listOperations(harness.storage, 'alice')).toHaveLength(1);
  });

  it('re-activates an overdue unsent profile row on the next save', async () => {
    const queue = harness.makeQueue();
    await queue.enqueue({ accountId: 'alice', ...PROFILE });
    harness.advance(PENDING_DEADLINE_MS + 1);
    await queue.reconcile('alice');

    const save = await queue.enqueue({
      accountId: 'alice',
      kind: 'update_profile',
      payload: { display_name: 'Z' },
    });

    expect(save.coalesced).toBe(true);
    expect(save.operation.state).toBe('pending');
    expect(save.operation.expiresAt).toBe(harness.now() + PENDING_DEADLINE_MS);
    expect(await listOperations(harness.storage, 'alice')).toHaveLength(1);
  });

  it('keeps non-profile kinds as separate operations', async () => {
    const queue = harness.makeQueue();
    const a = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const b = await queue.enqueue({ accountId: 'alice', ...REQUEST });

    expect(a.coalesced).toBe(false);
    expect(b.coalesced).toBe(false);
    expect(a.operation.operationId).not.toBe(b.operation.operationId);
    expect(await listOperations(harness.storage, 'alice')).toHaveLength(2);
  });

  it('never reuses a sent operation id for a different payload', async () => {
    const queue = harness.makeQueue();
    const first = await queue.enqueue({ accountId: 'alice', ...PROFILE });
    const claimed = await queue.claim('alice');
    await queue.applySendResult(claimed!, { status: 'unknown' });

    const second = await queue.enqueue({
      accountId: 'alice',
      kind: 'update_profile',
      payload: { display_name: 'B' },
    });

    expect(second.coalesced).toBe(false);
    expect(second.operation.operationId).not.toBe(first.operation.operationId);
    const original = await getOperation(harness.storage, 'alice', first.operation.operationId);
    expect(original?.state).toBe('sent_unknown');
    expect(original?.payload).toEqual({ display_name: 'A' });
  });
});

describe('claim', () => {
  it('claims a due pending operation exactly once', async () => {
    const queue = harness.makeQueue();
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });

    const claimed = await queue.claim('alice');
    expect(claimed?.operationId).toBe(operation.operationId);
    expect(claimed?.state).toBe('sending');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.nextAttemptAt).toBe(T0); // lease marker

    expect(await queue.claim('alice')).toBeNull();
  });

  it('waits for next_attempt_at before the next attempt', async () => {
    const queue = harness.makeQueue();
    await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const first = await queue.claim('alice');
    await queue.applySendResult(first!, { status: 'transient', message: 'offline' });

    expect(await queue.claim('alice')).toBeNull(); // 5s backoff not due yet

    harness.advance(RETRY_BASE_MS);
    const second = await queue.claim('alice');
    expect(second?.attempts).toBe(2);
    expect(second?.state).toBe('sending');
  });

  it('sends an overdue unsent operation to needs_confirmation instead of claiming it', async () => {
    const queue = harness.makeQueue();
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    harness.advance(PENDING_DEADLINE_MS + 1);

    expect(await queue.claim('alice')).toBeNull();
    const stored = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(stored?.state).toBe('needs_confirmation');
    expect(stored?.expiresAt).toBe(T0 + PENDING_DEADLINE_MS);
  });

  it('holds a later operation behind an unknown same-kind result but keeps other kinds moving', async () => {
    const queue = harness.makeQueue();
    const p1 = await queue.enqueue({ accountId: 'alice', ...PROFILE });
    const first = await queue.claim('alice');
    expect(first?.operationId).toBe(p1.operation.operationId);
    await queue.applySendResult(first!, { status: 'unknown' });

    // p1 is now in flight with an unknown result, so a later profile save
    // becomes its own waiting operation instead of coalescing.
    const request = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const p2 = await queue.enqueue({
      accountId: 'alice',
      kind: 'update_profile',
      payload: { display_name: 'B' },
    });
    expect(p2.coalesced).toBe(false);

    // The unrelated request flows; the later profile save waits.
    const next = await queue.claim('alice');
    expect(next?.operationId).toBe(request.operation.operationId);
    expect(next?.kind).toBe('send_request');

    expect(await queue.claim('alice')).toBeNull();
    const waiting = await getOperation(harness.storage, 'alice', p2.operation.operationId);
    expect(waiting?.state).toBe('pending');
  });

  it('does not let a needs_confirmation row block its kind', async () => {
    const queue = harness.makeQueue();
    await queue.enqueue({ accountId: 'alice', ...REQUEST });
    harness.advance(PENDING_DEADLINE_MS + 1);
    expect(await queue.claim('alice')).toBeNull(); // sweeps the overdue row

    const later = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const claimed = await queue.claim('alice');
    expect(claimed?.operationId).toBe(later.operation.operationId);
  });

  it('resolves a claim/cancel race with exactly one winner', async () => {
    const queue = harness.makeQueue();
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });

    const [claimed, cancelled] = await Promise.all([
      queue.claim('alice'),
      queue.cancelUnsent('alice', operation.operationId),
    ]);

    expect((claimed !== null) !== cancelled).toBe(true);
    if (claimed) {
      expect(claimed.state).toBe('sending');
      expect(cancelled).toBe(false);
    } else {
      expect(
        (await getOperation(harness.storage, 'alice', operation.operationId))?.state,
      ).toBe('cancelled');
    }
  });

  it('never double-claims across two queue instances', async () => {
    await harness.makeQueue().enqueue({ accountId: 'alice', ...REQUEST });
    const other = harness.makeQueue();

    const results = await Promise.all([
      harness.makeQueue().claim('alice'),
      other.claim('alice'),
    ]);
    expect(results.filter((row) => row !== null)).toHaveLength(1);
  });

  it('claims a persisted row after reopening the database file', async () => {
    const queue = harness.makeQueue();
    await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const restarted = await harness.reopen();

    const claimed = await restarted.claim('alice');
    expect(claimed?.state).toBe('sending');
    expect(claimed?.attempts).toBe(1);
  });
});

describe('cancelUnsent', () => {
  it('cancels an unsent operation so it can never be claimed', async () => {
    const queue = harness.makeQueue();
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });

    expect(await queue.cancelUnsent('alice', operation.operationId)).toBe(true);
    expect(await queue.claim('alice')).toBeNull();
    expect(
      (await getOperation(harness.storage, 'alice', operation.operationId))?.state,
    ).toBe('cancelled');
    expect(await queue.cancelUnsent('alice', operation.operationId)).toBe(false);
  });

  it('refuses to cancel after the claim was taken', async () => {
    const queue = harness.makeQueue();
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    await queue.claim('alice');

    expect(await queue.cancelUnsent('alice', operation.operationId)).toBe(false);
    expect(
      (await getOperation(harness.storage, 'alice', operation.operationId))?.state,
    ).toBe('sending');
  });

  it('cancels a needs_confirmation row and reports unknown ids', async () => {
    const queue = harness.makeQueue();
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    harness.advance(PENDING_DEADLINE_MS + 1);
    await queue.reconcile('alice');

    expect(await queue.cancelUnsent('alice', operation.operationId)).toBe(true);
    expect(
      (await getOperation(harness.storage, 'alice', operation.operationId))?.state,
    ).toBe('cancelled');
    expect(await queue.cancelUnsent('alice', 'no-such-operation')).toBe(false);
  });
});

describe('reconcile', () => {
  it('sweeps overdue pending rows exactly once', async () => {
    const queue = harness.makeQueue();
    await queue.enqueue({ accountId: 'alice', ...REQUEST });
    harness.advance(PENDING_DEADLINE_MS + 1);

    expect(await queue.reconcile('alice')).toEqual({
      needsConfirmation: 1,
      recoveredSends: 0,
    });
    expect(await queue.reconcile('alice')).toEqual({
      needsConfirmation: 0,
      recoveredSends: 0,
    });
  });

  it('keeps a sent operation confirming past the 24-hour deadline', async () => {
    const queue = harness.makeQueue();
    const { operation } = await queue.enqueue({ accountId: 'alice', ...PROFILE });
    const claimed = await queue.claim('alice');
    await queue.applySendResult(claimed!, { status: 'unknown' });

    harness.advance(PENDING_DEADLINE_MS + 1);
    expect(await queue.reconcile('alice')).toEqual({
      needsConfirmation: 0,
      recoveredSends: 0,
    });

    const stored = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(stored?.state).toBe('sent_unknown'); // not condemned by the deadline
    expect(stored?.expiresAt).toBe(T0 + PENDING_DEADLINE_MS); // untouched
  });

  it('recovers a dropped sending claim only after the lease expires', async () => {
    const queue = harness.makeQueue();
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    await queue.claim('alice'); // then "crash": nothing settles the claim

    harness.advance(SEND_LEASE_MS - 1);
    expect(await queue.reconcile('alice')).toEqual({
      needsConfirmation: 0,
      recoveredSends: 0,
    });
    expect(
      (await getOperation(harness.storage, 'alice', operation.operationId))?.state,
    ).toBe('sending');

    harness.advance(2);
    expect(await queue.reconcile('alice')).toEqual({
      needsConfirmation: 0,
      recoveredSends: 1,
    });
    const recovered = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(recovered?.state).toBe('sent_unknown');
    expect(recovered?.nextAttemptAt).toBe(harness.now()); // confirmable now
  });
});

describe('retryAsNew', () => {
  it('re-sends confirmed content under a fresh operation id', async () => {
    const queue = harness.makeQueue();
    const old = await queue.enqueue({ accountId: 'alice', ...PROFILE, baseVersion: 7 });
    harness.advance(PENDING_DEADLINE_MS + 1);
    await queue.reconcile('alice');

    harness.advance(60_000);
    const fresh = await queue.retryAsNew({
      accountId: 'alice',
      operationId: old.operation.operationId,
      payload: { display_name: 'confirmed' },
      baseVersion: 9,
    });

    expect(fresh.operationId).not.toBe(old.operation.operationId);
    expect(fresh.state).toBe('pending');
    expect(fresh.kind).toBe('update_profile');
    expect(fresh.payload).toEqual({ display_name: 'confirmed' });
    expect(fresh.baseVersion).toBe(9);
    expect(fresh.attempts).toBe(0);
    expect(fresh.createdAt).toBe(harness.now());
    expect(fresh.expiresAt).toBe(harness.now() + PENDING_DEADLINE_MS);

    const superseded = await getOperation(
      harness.storage,
      'alice',
      old.operation.operationId,
    );
    expect(superseded?.state).toBe('superseded');

    const claimed = await queue.claim('alice');
    expect(claimed?.operationId).toBe(fresh.operationId);
  });

  it('re-sends a permanently failed operation with rebased content', async () => {
    const queue = harness.makeQueue();
    const old = await queue.enqueue({ accountId: 'alice', ...PROFILE, baseVersion: 7 });
    const claimed = await queue.claim('alice');
    const state = await queue.applySendResult(claimed!, {
      status: 'rejected',
      httpStatus: 403,
      message: 'permission denied',
    });
    expect(state).toBe('failed_permanent');

    const fresh = await queue.retryAsNew({
      accountId: 'alice',
      operationId: old.operation.operationId,
      baseVersion: 12,
    });
    expect(fresh.state).toBe('pending');
    expect(fresh.baseVersion).toBe(12);
    expect(fresh.payload).toEqual({ display_name: 'A' });
  });

  it('refuses to invent a new id for results that are not yet decided', async () => {
    const queue = harness.makeQueue();
    const sent = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const fresh = await queue.enqueue({ accountId: 'alice', ...REQUEST });

    const claimed = await queue.claim('alice');
    await queue.applySendResult(claimed!, { status: 'unknown' });

    await expectQueueCode(
      queue.retryAsNew({ accountId: 'alice', operationId: sent.operation.operationId }),
      'not_retryable',
    );
    await expectQueueCode(
      queue.retryAsNew({ accountId: 'alice', operationId: fresh.operation.operationId }),
      'not_retryable',
    );
    await expectQueueCode(
      queue.retryAsNew({ accountId: 'alice', operationId: 'missing-operation' }),
      'unknown_operation',
    );
  });

  it('allows a directly overdue pending row without waiting for a sweep', async () => {
    const queue = harness.makeQueue();
    const old = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    harness.advance(PENDING_DEADLINE_MS + 1);

    const fresh = await queue.retryAsNew({
      accountId: 'alice',
      operationId: old.operation.operationId,
    });
    expect(fresh.operationId).not.toBe(old.operation.operationId);
    expect(fresh.state).toBe('pending');
    expect(fresh.expiresAt).toBe(harness.now() + PENDING_DEADLINE_MS);
    expect(
      (await getOperation(harness.storage, 'alice', old.operation.operationId))?.state,
    ).toBe('superseded');
  });
});

describe('retry timing', () => {
  it('doubles from 5 seconds and caps at 15 minutes', () => {
    const random = () => 0.5;
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((attempt) =>
      backoffDelay(attempt, random),
    );
    expect(delays).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 900_000, 900_000,
    ]);
    expect(RETRY_MAX_MS).toBe(15 * 60 * 1000);
  });

  it('jitters within ±10% and never exceeds the cap', () => {
    expect(backoffDelay(1, () => 0)).toBe(4_500);
    expect(backoffDelay(1, () => 1)).toBe(5_500);
    expect(backoffDelay(2, () => 0)).toBe(9_000);
    expect(backoffDelay(2, () => 1)).toBe(11_000);
    // Jitter cannot push past the 15-minute ceiling.
    expect(backoffDelay(9, () => 1)).toBe(RETRY_MAX_MS);
    expect(backoffDelay(99, () => 1)).toBe(RETRY_MAX_MS);
  });

  it('schedules the absolute next attempt from now', () => {
    expect(nextAttemptAt(1_000, 1, () => 0.5)).toBe(6_000);
  });
});

describe('applySendResult', () => {
  it('retries transient failures with backoff without ever extending the deadline', async () => {
    const queue = harness.makeQueue();
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const deadline = T0 + PENDING_DEADLINE_MS;

    const first = await queue.claim('alice');
    const afterFirst = await queue.applySendResult(first!, {
      status: 'transient',
      httpStatus: 503,
      message: 'unavailable',
    });
    expect(afterFirst).toBe('pending');
    let stored = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(stored?.nextAttemptAt).toBe(T0 + 5_000);
    expect(stored?.expiresAt).toBe(deadline); // automatic retry ≠ deadline

    harness.advance(RETRY_BASE_MS);
    const second = await queue.claim('alice');
    expect(second?.attempts).toBe(2);
    await queue.applySendResult(second!, { status: 'transient', message: 'still offline' });
    stored = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(stored?.nextAttemptAt).toBe(T0 + 5_000 + 10_000); // doubling
    expect(stored?.expiresAt).toBe(deadline);

    // Even after the 24-hour window, retries never moved expires_at - the
    // sweep observes the ORIGINAL deadline and stops the operation.
    harness.advance(PENDING_DEADLINE_MS);
    expect(await queue.claim('alice')).toBeNull();
    stored = await getOperation(harness.storage, 'alice', operation.operationId);
    expect(stored?.state).toBe('needs_confirmation');
    expect(stored?.expiresAt).toBe(deadline);
  });

  it('keeps a confirming operation out of the unsent states on transient errors', async () => {
    const queue = harness.makeQueue();
    await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const claimed = await queue.claim('alice');
    await queue.applySendResult(claimed!, { status: 'unknown' });

    harness.advance(RETRY_BASE_MS); // confirmation is due after the backoff
    const again = await queue.claim('alice');
    expect(again?.state).toBe('sending');
    const state = await queue.applySendResult(again!, {
      status: 'transient',
      message: 'offline during confirmation',
    });
    expect(state).toBe('sent_unknown'); // never regresses to pending
  });

  it('ignores a late result after the account rows were purged', async () => {
    const queue = harness.makeQueue();
    const { operation } = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const claimed = await queue.claim('alice');
    await removeOperation(harness.storage, 'alice', operation.operationId);

    expect(await queue.applySendResult(claimed!, { status: 'ok' })).toBeNull();
    expect(await getOperation(harness.storage, 'alice', operation.operationId)).toBeNull();
  });

  it('keeps the first result when a duplicate answer arrives', async () => {
    const queue = harness.makeQueue();
    await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const claimed = await queue.claim('alice');
    expect(await queue.applySendResult(claimed!, { status: 'ok' })).toBe('succeeded');
    expect(await queue.applySendResult(claimed!, { status: 'transient' })).toBe('succeeded');
  });
});

describe('account switching', () => {
  it('scopes enqueue, claim, cancel and retry to their own account', async () => {
    const queue = harness.makeQueue();
    const alice = await queue.enqueue({ accountId: 'alice', ...REQUEST });
    const bob = await queue.enqueue({ accountId: 'bob', ...REQUEST });

    const claimedForAlice = await queue.claim('alice');
    expect(claimedForAlice?.operationId).toBe(alice.operation.operationId);
    expect(claimedForAlice?.accountId).toBe('alice');

    // Cancelling bob's row leaves alice's in-flight claim untouched.
    expect(await queue.cancelUnsent('bob', bob.operation.operationId)).toBe(true);
    expect(
      (await getOperation(harness.storage, 'alice', alice.operation.operationId))?.state,
    ).toBe('sending');
    expect(
      (await getOperation(harness.storage, 'bob', bob.operation.operationId))?.state,
    ).toBe('cancelled');

    expect(await queue.claim('bob')).toBeNull(); // bob has nothing claimable
    expect(await listOperations(harness.storage, 'alice')).toHaveLength(1);
    expect(await listOperations(harness.storage, 'bob')).toHaveLength(1);
  });
});
