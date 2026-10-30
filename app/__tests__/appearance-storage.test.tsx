import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  APPEARANCE_PREFERENCES_KEY,
  baselineCelebration,
  consumeCelebrationBatch,
  readAppearancePreferences,
  readCelebration,
  updateAppearancePreferences,
  writeAppearancePreferences,
  type AppearancePreferences,
} from '../src/storage/appearance';
import { writeCache } from '../src/storage/cache';
import {
  deleteAccountData,
  openAppDatabase,
  StorageError,
  type AppStorage,
} from '../src/storage/database';
import { readDraft, saveDraft } from '../src/storage/drafts';
import { SCHEMA_VERSION, runMigrations, schemaMigrations, type Migration } from '../src/storage/migrations';
import { enqueueOperation, listOperations } from '../src/storage/outbox';
import { readDeviceSetting, writeDeviceSetting } from '../src/storage/settings';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';

/**
 * Task 8: the device-local celebration ledger and 端末設定 persisted in a real
 * SQLite file. The ledger keeps only account/kind/internal subject/baseline/
 * consumed milestone — never names, User ID text, bodies or images.
 */

interface Harness {
  root: string;
  dbPath: string;
  open(options?: { migrations?: readonly Migration[] }): Promise<AppStorage>;
  cleanup(): Promise<void>;
}

function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-storage-'));
  const dbPath = path.join(root, 'app.db');
  const handles: AppStorage[] = [];
  return {
    root,
    dbPath,
    async open(options = {}) {
      const db = await openAppDatabase({
        driver: new NodeSqliteDriver(dbPath),
        ...(options.migrations ? { migrations: options.migrations } : {}),
      });
      handles.push(db);
      return db;
    },
    async cleanup() {
      for (const db of handles) {
        try {
          await db.close();
        } catch {
          // Already closed by a test.
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

const DEFAULT_PREFERENCES: AppearancePreferences = {
  vibrancy: 'flashy',
  chatEnabled: true,
  streakEnabled: true,
  chatResumeGeneration: 0,
  streakResumeGeneration: 0,
};

async function columns(db: AppStorage, table: string): Promise<string[]> {
  return (await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)).map((row) => row.name);
}

async function celebrationCount(db: AppStorage): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM appearance_celebrations');
  return row?.n ?? 0;
}

describe('schema migration v3', () => {
  it('adds appearance_celebrations at SCHEMA_VERSION without rewriting v2 data', async () => {
    expect(SCHEMA_VERSION).toBe(3);
    const v2 = await harness.open({ migrations: schemaMigrations.slice(0, 2) });
    expect(await v2.schemaVersion()).toBe(2);
    await saveDraft(v2, 'alice', 'registration', { userId: 'alice' }, 5);
    await writeDeviceSetting(v2, 'theme', 'dark', 6);
    await v2.close();

    const v3 = await harness.open();
    expect(await v3.schemaVersion()).toBe(SCHEMA_VERSION);
    expect((await readDraft(v3, 'alice', 'registration'))?.body).toEqual({ userId: 'alice' });
    expect(await readDeviceSetting(v3, 'theme')).toBe('dark');
    expect(await columns(v3, 'appearance_celebrations')).toEqual([
      'account_id',
      'kind',
      'subject_id',
      'baseline_days',
      'consumed_milestone',
    ]);
  });

  it('rolls back the failed migration DDL and version, then succeeds after the conflict is removed', async () => {
    const db = await harness.open({ migrations: schemaMigrations.slice(0, 2) });
    await db.execAsync('CREATE TABLE appearance_celebrations (collision TEXT)');

    await expect(runMigrations(db)).rejects.toThrow();
    expect(await db.schemaVersion()).toBe(2);
    // The real table DDL did not stick: the pre-existing conflicting table is
    // untouched rather than partially replaced.
    expect(await columns(db, 'appearance_celebrations')).toEqual(['collision']);

    await db.execAsync('DROP TABLE appearance_celebrations');
    expect(await runMigrations(db)).toBe(SCHEMA_VERSION);
    expect(await db.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(await columns(db, 'appearance_celebrations')).toEqual([
      'account_id',
      'kind',
      'subject_id',
      'baseline_days',
      'consumed_milestone',
    ]);
  });

  it('stores only internal identifiers, a baseline and a consumed milestone', async () => {
    const db = await harness.open();
    expect(await columns(db, 'appearance_celebrations')).toEqual([
      'account_id',
      'kind',
      'subject_id',
      'baseline_days',
      'consumed_milestone',
    ]);
    const ddl =
      (await db.getFirstAsync<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'appearance_celebrations'",
      ))?.sql ?? '';
    expect(ddl).not.toMatch(/\b(name|body|image|display_name|user_id)\b/i);
  });
});

describe('celebration baselines', () => {
  it('inserts a first baseline and never resets it on later canonical syncs', async () => {
    const db = await harness.open();
    expect(await readCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' })).toBeNull();

    const first = await baselineCelebration(db, {
      accountId: 'alice',
      kind: 'chat',
      subjectId: 'peer-1',
      days: 8,
    });
    expect(first).toEqual({
      accountId: 'alice',
      kind: 'chat',
      subjectId: 'peer-1',
      baselineDays: 8,
      consumedMilestone: 7,
    });

    const later = await baselineCelebration(db, {
      accountId: 'alice',
      kind: 'chat',
      subjectId: 'peer-1',
      days: 65,
    });
    expect(later).toEqual(first);
    expect(await readCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' })).toEqual(first);
  });

  it('normalizes non-positive and fractional confirmed days', async () => {
    const db = await harness.open();
    const zero = await baselineCelebration(db, {
      accountId: 'alice',
      kind: 'streak',
      subjectId: 'self',
      days: 0,
    });
    expect(zero).toMatchObject({ baselineDays: 0, consumedMilestone: 0 });

    const negative = await baselineCelebration(db, {
      accountId: 'alice',
      kind: 'chat',
      subjectId: 'peer-negative',
      days: -12,
    });
    expect(negative).toMatchObject({ baselineDays: 0, consumedMilestone: 0 });

    const fractional = await baselineCelebration(db, {
      accountId: 'alice',
      kind: 'chat',
      subjectId: 'peer-fraction',
      days: 6.9,
    });
    expect(fractional).toMatchObject({ baselineDays: 6, consumedMilestone: 1 });
  });

  it('isolates the same kind and subject between accounts', async () => {
    const db = await harness.open();
    const alice = await baselineCelebration(db, {
      accountId: 'alice',
      kind: 'chat',
      subjectId: 'peer-1',
      days: 30,
    });
    const bob = await baselineCelebration(db, {
      accountId: 'bob',
      kind: 'chat',
      subjectId: 'peer-1',
      days: 0,
    });

    await consumeCelebrationBatch(db, {
      accountId: 'alice',
      records: [{ kind: 'chat', subjectId: 'peer-1', milestone: 60 }],
    });

    expect(await readCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' })).toEqual({
      ...alice,
      consumedMilestone: 60,
    });
    expect(await readCelebration(db, { accountId: 'bob', kind: 'chat', subjectId: 'peer-1' })).toEqual(bob);
    expect(await celebrationCount(db)).toBe(2);
  });
});

describe('celebration consumption', () => {
  async function seedTwo(db: AppStorage) {
    await baselineCelebration(db, {
      accountId: 'alice',
      kind: 'chat',
      subjectId: 'peer-1',
      days: 0,
    });
    await baselineCelebration(db, {
      accountId: 'alice',
      kind: 'streak',
      subjectId: 'self',
      days: 0,
    });
  }

  it('consumes a chat and streak record together in one write transaction', async () => {
    const db = await harness.open();
    await seedTwo(db);

    const updated = await consumeCelebrationBatch(db, {
      accountId: 'alice',
      records: [
        { kind: 'chat', subjectId: 'peer-1', milestone: 30 },
        { kind: 'streak', subjectId: 'self', milestone: 7 },
      ],
    });
    expect(updated.map((record) => [record.kind, record.subjectId, record.consumedMilestone])).toEqual([
      ['chat', 'peer-1', 30],
      ['streak', 'self', 7],
    ]);
    expect(await readCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' })).toMatchObject({
      consumedMilestone: 30,
    });
    expect(await readCelebration(db, { accountId: 'alice', kind: 'streak', subjectId: 'self' })).toMatchObject({
      consumedMilestone: 7,
    });
  });

  it('keeps the consumed milestone monotonic when milestones arrive out of order', async () => {
    const db = await harness.open();
    await seedTwo(db);

    await consumeCelebrationBatch(db, {
      accountId: 'alice',
      records: [{ kind: 'chat', subjectId: 'peer-1', milestone: 30 }],
    });
    const [backwards] = await consumeCelebrationBatch(db, {
      accountId: 'alice',
      records: [{ kind: 'chat', subjectId: 'peer-1', milestone: 7 }],
    });
    expect(backwards.consumedMilestone).toBe(30);

    const [forwards] = await consumeCelebrationBatch(db, {
      accountId: 'alice',
      records: [{ kind: 'chat', subjectId: 'peer-1', milestone: 60 }],
    });
    expect(forwards.consumedMilestone).toBe(60);
    expect((await readCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' }))?.consumedMilestone).toBe(60);
  });

  it('rolls back every record when one baseline is missing', async () => {
    const db = await harness.open();
    await seedTwo(db);

    await expect(
      consumeCelebrationBatch(db, {
        accountId: 'alice',
        records: [
          { kind: 'chat', subjectId: 'peer-1', milestone: 7 },
          { kind: 'streak', subjectId: 'never-baselined', milestone: 30 },
        ],
      }),
    ).rejects.toBeInstanceOf(StorageError);

    expect((await readCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' }))?.consumedMilestone).toBe(0);
    expect((await readCelebration(db, { accountId: 'alice', kind: 'streak', subjectId: 'self' }))?.consumedMilestone).toBe(0);
  });

  it('rejects invalid batches before touching stored records', async () => {
    const db = await harness.open();
    await seedTwo(db);
    const record = (patch: Record<string, unknown> = {}) => ({
      kind: 'chat',
      subjectId: 'peer-1',
      milestone: 7,
      ...patch,
    });
    const invalidBatches: unknown[] = [
      { records: [] },
      { records: [record(), record({ subjectId: 'peer-2' }), record({ subjectId: 'peer-3' })] },
      { records: [record(), record({ milestone: 30 })] },
      { records: [record({ kind: 'profile' })] },
      { records: [record({ milestone: 3 })] },
      { records: [record({ milestone: 0 })] },
      { records: [record({ subjectId: '' })] },
    ];
    for (const batch of invalidBatches) {
      await expect(
        consumeCelebrationBatch(db, { accountId: 'alice', ...(batch as { records: never[] }) }),
      ).rejects.toBeInstanceOf(StorageError);
    }
    expect((await readCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' }))?.consumedMilestone).toBe(0);
  });

  it('keys a conversation by peer id, not conversation id or friendship epoch', async () => {
    const db = await harness.open();
    await writeCache(db, 'alice', 'chat.peer.peer-1', { conversation_id: 'c1', friendship_epoch: 'epoch-1' }, 1);
    const baseline = await baselineCelebration(db, {
      accountId: 'alice',
      kind: 'chat',
      subjectId: 'peer-1',
      days: 6,
    });

    await writeCache(db, 'alice', 'chat.peer.peer-1', { conversation_id: 'c2', friendship_epoch: 'epoch-2' }, 2);
    expect(await readCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' })).toEqual(baseline);

    const [consumed] = await consumeCelebrationBatch(db, {
      accountId: 'alice',
      records: [{ kind: 'chat', subjectId: 'peer-1', milestone: 7 }],
    });
    expect(consumed).toEqual({ ...baseline, consumedMilestone: 7 });
    expect(await celebrationCount(db)).toBe(1);
  });

  it('restores celebrations and device preferences after reopen and re-login', async () => {
    const first = await harness.open();
    await baselineCelebration(first, {
      accountId: 'alice',
      kind: 'chat',
      subjectId: 'peer-1',
      days: 29,
    });
    await consumeCelebrationBatch(first, {
      accountId: 'alice',
      records: [{ kind: 'chat', subjectId: 'peer-1', milestone: 60 }],
    });
    const preferences = await updateAppearancePreferences(
      first,
      { vibrancy: 'off', streakEnabled: false },
      { bumpResume: ['streak'] },
    );
    await first.close();

    const second = await harness.open();
    expect(await readCelebration(second, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' })).toEqual({
      accountId: 'alice',
      kind: 'chat',
      subjectId: 'peer-1',
      baselineDays: 29,
      consumedMilestone: 60,
    });
    expect(await readAppearancePreferences(second)).toEqual(preferences);
  });
});

describe('lifetime guard', () => {
  it('rejects a stale baseline after the insert and rolls the row back', async () => {
    const db = await harness.open();
    let sawInsert = false;
    await expect(
      baselineCelebration(db, {
        accountId: 'alice',
        kind: 'chat',
        subjectId: 'peer-1',
        days: 7,
        lifetime: async () => {
          sawInsert =
            (await db.getFirstAsync(
              "SELECT 1 FROM appearance_celebrations WHERE account_id = 'alice' AND kind = 'chat' AND subject_id = 'peer-1'",
            )) !== null;
          return false;
        },
      }),
    ).rejects.toBeInstanceOf(StorageError);

    expect(sawInsert).toBe(true);
    expect(await readCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' })).toBeNull();
  });

  it('rejects consumption at commit time without changing the stored milestone', async () => {
    const db = await harness.open();
    await baselineCelebration(db, {
      accountId: 'alice',
      kind: 'chat',
      subjectId: 'peer-1',
      days: 0,
    });

    let observedDuringGuard = false;
    await expect(
      consumeCelebrationBatch(db, {
        accountId: 'alice',
        records: [{ kind: 'chat', subjectId: 'peer-1', milestone: 30 }],
        lifetime: async () => {
          observedDuringGuard =
            (await readCelebration(db, {
              accountId: 'alice',
              kind: 'chat',
              subjectId: 'peer-1',
            }))?.consumedMilestone === 30;
          return false;
        },
      }),
    ).rejects.toBeInstanceOf(StorageError);

    expect(observedDuringGuard).toBe(true);
    expect((await readCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' }))?.consumedMilestone).toBe(0);
  });
});

describe('appearance preferences', () => {
  it('returns defaults when the device setting is missing', async () => {
    const db = await harness.open();
    expect(await readAppearancePreferences(db)).toEqual(DEFAULT_PREFERENCES);
    expect(await readDeviceSetting(db, APPEARANCE_PREFERENCES_KEY)).toBeNull();
  });

  it('persists as one device-scoped JSON value for every account after logout', async () => {
    const db = await harness.open();
    const custom: AppearancePreferences = {
      vibrancy: 'subtle',
      chatEnabled: false,
      streakEnabled: true,
      chatResumeGeneration: 4,
      streakResumeGeneration: 2,
    };
    await writeAppearancePreferences(db, custom);
    expect(await readAppearancePreferences(db)).toEqual(custom);
    expect(JSON.parse((await readDeviceSetting(db, APPEARANCE_PREFERENCES_KEY)) ?? 'null')).toEqual(custom);

    await baselineCelebration(db, { accountId: 'alice', kind: 'streak', subjectId: 'self', days: 10 });
    await deleteAccountData(db, 'alice');

    // The same device setting is visible to another account after logout.
    expect(await readAppearancePreferences(db)).toEqual(custom);
    expect(await readCelebration(db, { accountId: 'alice', kind: 'streak', subjectId: 'self' })).toMatchObject({
      baselineDays: 10,
      consumedMilestone: 7,
    });
  });

  it('applies a patch and resume-generation bumps in one transaction', async () => {
    const db = await harness.open();
    const first = await updateAppearancePreferences(
      db,
      { vibrancy: 'subtle', chatEnabled: false },
      { bumpResume: ['chat'] },
    );
    expect(first).toEqual({
      ...DEFAULT_PREFERENCES,
      vibrancy: 'subtle',
      chatEnabled: false,
      chatResumeGeneration: 1,
    });

    const second = await updateAppearancePreferences(
      db,
      { chatEnabled: true, streakEnabled: false },
      { bumpResume: ['chat', 'streak'] },
    );
    expect(second).toMatchObject({
      chatEnabled: true,
      streakEnabled: false,
      chatResumeGeneration: 2,
      streakResumeGeneration: 1,
    });

    const third = await updateAppearancePreferences(db, {}, { bumpResume: ['chat'] });
    expect(third.chatResumeGeneration).toBe(3);
    expect(third.streakResumeGeneration).toBe(1);
  });

  it('serializes concurrent bumps so no generation increment is lost', async () => {
    const db = await harness.open();
    await Promise.all([
      updateAppearancePreferences(db, { vibrancy: 'subtle' }, { bumpResume: ['chat'] }),
      updateAppearancePreferences(db, { vibrancy: 'off' }, { bumpResume: ['chat'] }),
    ]);
    expect((await readAppearancePreferences(db)).chatResumeGeneration).toBe(2);
  });

  it('rejects corrupt or invalid stored values with a StorageError', async () => {
    const db = await harness.open();
    const invalidValues = [
      '{not json',
      'null',
      '[]',
      '{}',
      JSON.stringify({ ...DEFAULT_PREFERENCES, vibrancy: 'loud' }),
      JSON.stringify({ ...DEFAULT_PREFERENCES, chatEnabled: 'yes' }),
      JSON.stringify({ ...DEFAULT_PREFERENCES, chatResumeGeneration: -1 }),
      JSON.stringify({ ...DEFAULT_PREFERENCES, streakResumeGeneration: 1.5 }),
      JSON.stringify({ ...DEFAULT_PREFERENCES, streakResumeGeneration: Number.MAX_SAFE_INTEGER + 1 }),
    ];
    for (const raw of invalidValues) {
      await writeDeviceSetting(db, APPEARANCE_PREFERENCES_KEY, raw);
      await expect(readAppearancePreferences(db)).rejects.toBeInstanceOf(StorageError);
    }

    await writeDeviceSetting(db, APPEARANCE_PREFERENCES_KEY, '{still broken');
    await expect(updateAppearancePreferences(db, { vibrancy: 'off' }, { bumpResume: ['chat'] })).rejects.toBeInstanceOf(StorageError);
    expect(await readDeviceSetting(db, APPEARANCE_PREFERENCES_KEY)).toBe('{still broken');
  });

  it('validates values written directly', async () => {
    const db = await harness.open();
    await expect(
      writeAppearancePreferences(db, { ...DEFAULT_PREFERENCES, vibrancy: 'loud' as never }),
    ).rejects.toBeInstanceOf(StorageError);
    await expect(
      writeAppearancePreferences(db, { ...DEFAULT_PREFERENCES, chatResumeGeneration: -2 }),
    ).rejects.toBeInstanceOf(StorageError);
    expect(await readAppearancePreferences(db)).toEqual(DEFAULT_PREFERENCES);
  });

  it('rejects a stale preference update after writing and rolls back patch and bump', async () => {
    const db = await harness.open();
    const before = await readAppearancePreferences(db);
    let sawWrite = false;
    await expect(
      updateAppearancePreferences(
        db,
        { vibrancy: 'off' },
        {
          bumpResume: ['streak'],
          lifetime: async () => {
            const raw = await readDeviceSetting(db, APPEARANCE_PREFERENCES_KEY);
            const parsed = JSON.parse(raw ?? 'null') as AppearancePreferences | null;
            sawWrite = parsed?.vibrancy === 'off' && parsed.streakResumeGeneration === 1;
            return false;
          },
        },
      ),
    ).rejects.toBeInstanceOf(StorageError);

    expect(sawWrite).toBe(true);
    expect(await readAppearancePreferences(db)).toEqual(before);
  });
});

describe('account removal', () => {
  it('removes normal account rows but preserves celebrations and device preferences', async () => {
    const db = await harness.open();
    await saveDraft(db, 'alice', 'registration', { userId: 'alice' });
    await writeCache(db, 'alice', 'friends', [{ id: 'bob' }]);
    await enqueueOperation(db, {
      accountId: 'alice',
      operationId: 'op-1',
      kind: 'profile.update',
      payload: {},
      createdAt: 1,
      expiresAt: 2,
      state: 'queued',
    });
    await baselineCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1', days: 7 });
    await baselineCelebration(db, { accountId: 'alice', kind: 'streak', subjectId: 'self', days: 30 });
    await baselineCelebration(db, { accountId: 'bob', kind: 'chat', subjectId: 'peer-1', days: 1 });
    await updateAppearancePreferences(db, { vibrancy: 'subtle' }, { bumpResume: ['chat'] });

    await deleteAccountData(db, 'alice');

    // Normal account-scoped rows are gone.
    expect(await readDraft(db, 'alice', 'registration')).toBeNull();
    expect(await db.getFirstAsync('SELECT 1 FROM cache WHERE account_id = ?', ['alice'])).toBeNull();
    expect(await listOperations(db, 'alice')).toEqual([]);

    // The explicit exception survives: minimal celebration records for the
    // logged-out account and the device-scoped preferences.
    expect(await readCelebration(db, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' })).toMatchObject({
      baselineDays: 7,
      consumedMilestone: 7,
    });
    expect(await readCelebration(db, { accountId: 'alice', kind: 'streak', subjectId: 'self' })).toMatchObject({
      baselineDays: 30,
      consumedMilestone: 30,
    });
    expect(await readAppearancePreferences(db)).toMatchObject({
      vibrancy: 'subtle',
      chatResumeGeneration: 1,
    });
    // Another account's records are untouched too.
    expect(await readCelebration(db, { accountId: 'bob', kind: 'chat', subjectId: 'peer-1' })).toMatchObject({
      baselineDays: 1,
    });
    expect(await celebrationCount(db)).toBe(3);

    // Re-login on the same device must keep seeing the same ledger.
    await db.close();
    const reopened = await harness.open();
    expect(await readCelebration(reopened, { accountId: 'alice', kind: 'chat', subjectId: 'peer-1' })).toMatchObject({
      consumedMilestone: 7,
    });
    expect(await readAppearancePreferences(reopened)).toMatchObject({ vibrancy: 'subtle' });
  });
});
