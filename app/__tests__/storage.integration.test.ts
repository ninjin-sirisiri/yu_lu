import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { deleteAccountData, openAppDatabase, type AppStorage, type OpenAppDatabaseOptions } from '../src/storage/database';
import {
  SCHEMA_VERSION,
  SchemaVersionError,
  runMigrations,
  schemaMigrations,
  schemaVersion,
  type Migration,
} from '../src/storage/migrations';
import { deleteDraft, listDrafts, readDraft, saveDraft } from '../src/storage/drafts';
import { deleteCache, listCache, readCache, writeCache } from '../src/storage/cache';
import {
  countOperations,
  enqueueOperation,
  getOperation,
  listOperations,
  removeOperation,
  updateOperation,
} from '../src/storage/outbox';
import {
  listAccountSettings,
  readAccountSetting,
  readDeviceSetting,
  writeAccountSetting,
  writeDeviceSetting,
} from '../src/storage/settings';
import {
  deletePendingInvitation,
  listPendingInvitations,
  readPendingInvitation,
  savePendingInvitation,
} from '../src/storage/invitations';
import { createImageStore, ImageImportError, type FileSystemPort } from '../src/storage/files';
import { ChunkedSecretError, createChunkedSecrets, splitUtf8Bytes } from '../src/storage/secure';
import { NodeSqliteDriver, createNodeFileSystemPort } from '../src/storage/testSupport/nodePorts';

/**
 * SQL-boundary tests for the account storage layer. They run the production
 * SQL against Node's built-in SQLite on a real database file: write, close,
 * reopen and restore. Device-level proof of the write → process exit →
 * relaunch → restore cycle lives in docs/testing/app-foundation-friends-ui.md.
 */

interface Harness {
  root: string;
  dbPath: string;
  documentRoot: string;
  openStorage(options?: Omit<OpenAppDatabaseOptions, 'driver'>): Promise<AppStorage>;
  cleanup(): Promise<void>;
}

function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-storage-'));
  const dbPath = path.join(root, 'app.db');
  const documentRoot = path.join(root, 'Documents');
  fs.mkdirSync(documentRoot, { recursive: true });
  const open: AppStorage[] = [];
  return {
    root,
    dbPath,
    documentRoot,
    async openStorage(options = {}) {
      const storage = await openAppDatabase({ driver: new NodeSqliteDriver(dbPath), ...options });
      open.push(storage);
      return storage;
    },
    async cleanup() {
      for (const storage of open) {
        try {
          await storage.close();
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

function tableNames(storage: AppStorage, type: 'table' | 'index'): Promise<Array<{ name: string }>> {
  return storage.getAllAsync<{ name: string }>(
    'SELECT name FROM sqlite_master WHERE type = ?',
    [type],
  );
}

describe('schema and migrations', () => {
  it('creates every required table and indexes the schema version', async () => {
    const storage = await harness.openStorage();
    const names = (await tableNames(storage, 'table')).map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'cache',
        'drafts',
        'outbox',
        'pending_invitation',
        'device_settings',
        'chat_messages',
        'chat_drafts',
        'chat_read_intents',
        'chat_attachment_refs',
        'chat_image_cache',
      ]),
    );
    expect(await schemaVersion(storage)).toBe(SCHEMA_VERSION);
    expect(await storage.schemaVersion()).toBe(SCHEMA_VERSION);
    const journal = await storage.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(journal?.journal_mode).toBe('wal');
  });

  it('defines the columns the plan requires', async () => {
    const storage = await harness.openStorage();
    const columns = async (table: string) =>
      (await storage.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)).map(
        (row) => row.name,
      );
    expect(await columns('cache')).toEqual(
      expect.arrayContaining(['account_id', 'cache_key', 'payload', 'fetched_at']),
    );
    expect(await columns('drafts')).toEqual(
      expect.arrayContaining(['account_id', 'draft_key', 'body', 'updated_at']),
    );
    expect(await columns('outbox')).toEqual(
      expect.arrayContaining([
        'operation_id',
        'kind',
        'payload',
        'base_version',
        'created_at',
        'expires_at',
        'attempts',
        'next_attempt_at',
        'state',
        'ordering_key',
        'queue_sequence',
        'claim_generation',
        'claimed_at',
        'reach_stage',
        'result',
      ]),
    );
    expect(await columns('pending_invitation')).toEqual(
      expect.arrayContaining(['account_id', 'invitation_key', 'payload', 'created_at', 'expires_at']),
    );
    expect(await columns('device_settings')).toEqual(
      expect.arrayContaining(['account_id', 'key', 'value', 'updated_at']),
    );
    expect((await tableNames(storage, 'index')).map((row) => row.name)).toEqual(
      expect.arrayContaining(['device_settings_device_scope', 'outbox_account_state']),
    );
  });

  it('is idempotent across reopenings', async () => {
    const first = await harness.openStorage();
    await saveDraft(first, 'alice', 'registration', { userId: 'alice' });
    await first.close();

    const second = await harness.openStorage();
    expect(await schemaVersion(second)).toBe(SCHEMA_VERSION);
    expect((await readDraft(second, 'alice', 'registration'))?.body).toEqual({ userId: 'alice' });
  });

  it('upgrades a partial database step by step without losing data', async () => {
    const initial = await harness.openStorage();
    await saveDraft(initial, 'alice', 'registration', { userId: 'alice' });
    await initial.close();

    const extra: Migration = {
      version: SCHEMA_VERSION + 1,
      description: 'test-only follow-up migration',
      async up(tx) {
        await tx.execAsync('CREATE TABLE extra_table (id INTEGER PRIMARY KEY NOT NULL)');
        await tx.runAsync('INSERT INTO extra_table (id) VALUES (?)', [1]);
      },
    };
    const upgraded = await harness.openStorage({ migrations: [...schemaMigrations, extra] });
    expect(await schemaVersion(upgraded)).toBe(SCHEMA_VERSION + 1);
    expect((await readDraft(upgraded, 'alice', 'registration'))?.body).toEqual({ userId: 'alice' });
    const extraRow = await upgraded.getFirstAsync<{ id: number }>('SELECT id FROM extra_table');
    expect(extraRow?.id).toBe(1);
  });

  it('rolls back a failed migration and keeps the previous version', async () => {
    const failing: Migration = {
      version: SCHEMA_VERSION + 1,
      description: 'fails after partial work',
      async up(tx) {
        await tx.execAsync('CREATE TABLE half_applied (id INTEGER PRIMARY KEY NOT NULL)');
        throw new Error('migration exploded');
      },
    };
    const driver = new NodeSqliteDriver(harness.dbPath);
    await expect(
      openAppDatabase({ driver, migrations: [...schemaMigrations, failing] }),
    ).rejects.toThrow('migration exploded');
    await driver.close();

    const reopened = await harness.openStorage();
    expect(await schemaVersion(reopened)).toBe(SCHEMA_VERSION);
    const tables = (await tableNames(reopened, 'table')).map((row) => row.name);
    expect(tables).not.toContain('half_applied');
  });

  it('refuses to open a database written by a newer app version', async () => {
    const storage = await harness.openStorage();
    await storage.execAsync('PRAGMA user_version = 99');
    await storage.close();

    const driver = new NodeSqliteDriver(harness.dbPath);
    await expect(openAppDatabase({ driver })).rejects.toThrow(SchemaVersionError);
    await driver.close();
  });

  it('rejects a migration list that is not numbered from 1', async () => {
    const storage = await harness.openStorage();
    const misnumbered: Migration[] = [
      { version: 2, description: 'starts at two', async up() {} },
    ];
    await expect(runMigrations(storage, misnumbered)).rejects.toThrow('numbered 1..n');
  });
});

describe('drafts', () => {
  it('round-trips unicode bodies with timestamps', async () => {
    const storage = await harness.openStorage();
    const body = { userId: 'ゆめ_01', displayName: '夢 ✨', bio: '改行\nあり' };
    await saveDraft(storage, 'alice', 'registration', body, 1_700_000_000_000);

    const restored = await readDraft<typeof body>(storage, 'alice', 'registration');
    expect(restored).toEqual({
      accountId: 'alice',
      key: 'registration',
      body,
      updatedAt: 1_700_000_000_000,
    });
  });

  it('keeps drafts separate per account and per key', async () => {
    const storage = await harness.openStorage();
    await saveDraft(storage, 'alice', 'profile', { displayName: 'Alice' }, 10);
    await saveDraft(storage, 'bob', 'profile', { displayName: 'Bob' }, 20);

    expect((await readDraft(storage, 'alice', 'profile'))?.body).toEqual({ displayName: 'Alice' });
    expect((await readDraft(storage, 'bob', 'profile'))?.body).toEqual({ displayName: 'Bob' });
    expect(await readDraft(storage, 'carol', 'profile')).toBeNull();
    expect(await readDraft(storage, 'alice', 'unknown')).toBeNull();
  });

  it('overwrites in place and deletes', async () => {
    const storage = await harness.openStorage();
    await saveDraft(storage, 'alice', 'profile', { displayName: 'One' }, 10);
    await saveDraft(storage, 'alice', 'profile', { displayName: 'Two' }, 20);
    expect(await listDrafts(storage, 'alice')).toHaveLength(1);
    expect((await readDraft(storage, 'alice', 'profile'))?.updatedAt).toBe(20);

    expect(await deleteDraft(storage, 'alice', 'profile')).toBe(true);
    expect(await deleteDraft(storage, 'alice', 'profile')).toBe(false);
    expect(await readDraft(storage, 'alice', 'profile')).toBeNull();
  });

  it('lists drafts newest first', async () => {
    const storage = await harness.openStorage();
    await saveDraft(storage, 'alice', 'a', { step: 1 }, 10);
    await saveDraft(storage, 'alice', 'b', { step: 2 }, 30);
    await saveDraft(storage, 'alice', 'c', { step: 3 }, 20);

    expect((await listDrafts(storage, 'alice')).map((draft) => draft.key)).toEqual(['b', 'c', 'a']);
    expect(await listDrafts(storage, 'bob')).toEqual([]);
  });

  it('restores after closing and reopening the database file', async () => {
    const first = await harness.openStorage();
    await saveDraft(first, 'alice', 'registration', { userId: 'alice', step: 3 });
    await first.close();

    const second = await harness.openStorage();
    expect((await readDraft(second, 'alice', 'registration'))?.body).toEqual({
      userId: 'alice',
      step: 3,
    });
  });
});

describe('cache', () => {
  it('stores payloads with the fetch time', async () => {
    const storage = await harness.openStorage();
    await writeCache(storage, 'alice', 'friends', [{ id: 'bob' }], 1_700_000_000_000);

    const entry = await readCache<Array<{ id: string }>>(storage, 'alice', 'friends');
    expect(entry).toEqual({
      accountId: 'alice',
      key: 'friends',
      payload: [{ id: 'bob' }],
      fetchedAt: 1_700_000_000_000,
    });
  });

  it('refreshes fetched_at when the same key is written again', async () => {
    const storage = await harness.openStorage();
    await writeCache(storage, 'alice', 'friends', [], 100);
    await writeCache(storage, 'alice', 'friends', [{ id: 'bob' }], 200);

    expect((await readCache(storage, 'alice', 'friends'))?.fetchedAt).toBe(200);
    expect(await listCache(storage, 'alice')).toEqual([{ key: 'friends', fetchedAt: 200 }]);
  });

  it('isolates accounts and supports deletion', async () => {
    const storage = await harness.openStorage();
    await writeCache(storage, 'alice', 'search:夢', [{ id: 'bob' }], 10);
    await writeCache(storage, 'bob', 'search:夢', [{ id: 'carol' }], 20);

    expect((await readCache(storage, 'bob', 'search:夢'))?.fetchedAt).toBe(20);
    expect(await deleteCache(storage, 'alice', 'search:夢')).toBe(true);
    expect(await deleteCache(storage, 'alice', 'search:夢')).toBe(false);
    expect(await readCache(storage, 'alice', 'search:夢')).toBeNull();
    expect(await readCache(storage, 'bob', 'search:夢')).not.toBeNull();
  });

  it('restores after closing and reopening the database file', async () => {
    const first = await harness.openStorage();
    await writeCache(first, 'alice', 'friends', [{ id: 'bob' }], 42);
    await first.close();

    const second = await harness.openStorage();
    expect((await readCache(second, 'alice', 'friends'))?.fetchedAt).toBe(42);
  });
});

describe('outbox', () => {
  const operation = {
    accountId: 'alice',
    operationId: 'op-1',
    kind: 'profile.update',
    payload: { displayName: '夢' },
    baseVersion: 7,
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_086_400_000,
    state: 'queued',
  };

  it('persists every required column', async () => {
    const storage = await harness.openStorage();
    expect(await enqueueOperation(storage, { ...operation, attempts: 0, nextAttemptAt: 500 })).toBe(
      true,
    );

    const row = await getOperation(storage, 'alice', 'op-1');
    expect(row).toEqual({
      accountId: 'alice',
      operationId: 'op-1',
      kind: 'profile.update',
      payload: { displayName: '夢' },
      baseVersion: 7,
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_086_400_000,
      attempts: 0,
      nextAttemptAt: 500,
      state: 'queued',
      orderingKey: null,
      queueSequence: 1,
      claimGeneration: 0,
      claimedAt: null,
      reachStage: null,
      result: null,
    });
    expect(await countOperations(storage, 'alice')).toBe(1);
    expect(await countOperations(storage, 'alice', { state: 'queued' })).toBe(1);
    expect(await countOperations(storage, 'alice', { state: 'sending' })).toBe(0);
  });

  it('is idempotent per operation id', async () => {
    const storage = await harness.openStorage();
    expect(await enqueueOperation(storage, operation)).toBe(true);
    expect(
      await enqueueOperation(storage, {
        ...operation,
        payload: { displayName: 'changed later' },
        state: 'sending',
      }),
    ).toBe(false);

    const row = await getOperation(storage, 'alice', 'op-1');
    expect(row?.payload).toEqual({ displayName: '夢' });
    expect(row?.state).toBe('queued');
  });

  it('supports compare-and-set state transitions', async () => {
    const storage = await harness.openStorage();
    await enqueueOperation(storage, operation);

    const claimed = await updateOperation(
      storage,
      'alice',
      'op-1',
      { state: 'sending', attempts: 1, nextAttemptAt: null },
      { expectState: 'queued' },
    );
    expect(claimed).toBe(true);

    const secondClaim = await updateOperation(
      storage,
      'alice',
      'op-1',
      { state: 'sending' },
      { expectState: 'queued' },
    );
    expect(secondClaim).toBe(false);
    expect((await getOperation(storage, 'alice', 'op-1'))?.state).toBe('sending');
    expect(await getOperation(storage, 'bob', 'op-1')).toBeNull();
  });

  it('lists and removes operations per account', async () => {
    const storage = await harness.openStorage();
    await enqueueOperation(storage, operation);
    await enqueueOperation(storage, {
      ...operation,
      operationId: 'op-2',
      createdAt: operation.createdAt + 1,
      state: 'confirming',
    });
    await enqueueOperation(storage, { ...operation, accountId: 'bob', operationId: 'op-1' });

    const aliceStates = (await listOperations(storage, 'alice')).map((row) => row.state);
    expect(aliceStates).toEqual(['queued', 'confirming']);
    expect(await listOperations(storage, 'alice', { state: 'confirming' })).toHaveLength(1);

    expect(await removeOperation(storage, 'alice', 'op-1')).toBe(true);
    expect(await removeOperation(storage, 'alice', 'op-1')).toBe(false);
    expect(await getOperation(storage, 'alice', 'op-1')).toBeNull();
    expect(await getOperation(storage, 'bob', 'op-1')).not.toBeNull();
  });

  it('restores the queue after closing and reopening the database file', async () => {
    const first = await harness.openStorage();
    await enqueueOperation(first, operation);
    await first.close();

    const second = await harness.openStorage();
    expect(await countOperations(second, 'alice', { state: 'queued' })).toBe(1);
  });
});

describe('device settings', () => {
  it('stores device-scoped theme settings as a single row', async () => {
    const storage = await harness.openStorage();
    await writeDeviceSetting(storage, 'theme', 'dark', 10);
    await writeDeviceSetting(storage, 'theme', 'light', 20);

    expect(await readDeviceSetting(storage, 'theme')).toBe('light');
    const rows = await storage.getAllAsync<{ value: string }>(
      'SELECT value FROM device_settings WHERE account_id IS NULL AND key = ?',
      ['theme'],
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps account settings separate from device settings', async () => {
    const storage = await harness.openStorage();
    await writeDeviceSetting(storage, 'guidance-seen', 'device-value', 10);
    await writeAccountSetting(storage, 'alice', 'guidance-seen', 'account-value', 20);

    expect(await readDeviceSetting(storage, 'theme')).toBeNull();
    expect(await readDeviceSetting(storage, 'guidance-seen')).toBe('device-value');
    expect(await readAccountSetting(storage, 'alice', 'guidance-seen')).toBe('account-value');
    expect(await readAccountSetting(storage, 'bob', 'guidance-seen')).toBeNull();
    expect(await listAccountSettings(storage, 'alice')).toEqual({ 'guidance-seen': 'account-value' });
  });

  it('restores after closing and reopening the database file', async () => {
    const first = await harness.openStorage();
    await writeDeviceSetting(first, 'theme', 'dark');
    await first.close();

    const second = await harness.openStorage();
    expect(await readDeviceSetting(second, 'theme')).toBe('dark');
  });
});

describe('pending invitations', () => {
  it('saves, lists and deletes per account', async () => {
    const storage = await harness.openStorage();
    await savePendingInvitation(storage, {
      accountId: 'alice',
      invitationKey: 'first',
      payload: { token: 'invite-1' },
      createdAt: 10,
      expiresAt: 1_700_086_400_000,
    });
    await savePendingInvitation(storage, {
      accountId: 'alice',
      invitationKey: 'second',
      payload: { token: 'invite-2' },
      createdAt: 20,
      expiresAt: null,
    });
    await savePendingInvitation(storage, {
      accountId: 'bob',
      invitationKey: 'first',
      payload: { token: 'invite-3' },
      createdAt: 30,
    });

    const invitations = await listPendingInvitations(storage, 'alice');
    expect(invitations.map((row) => row.invitationKey)).toEqual(['first', 'second']);
    expect(invitations[0]).toEqual({
      accountId: 'alice',
      invitationKey: 'first',
      payload: { token: 'invite-1' },
      createdAt: 10,
      expiresAt: 1_700_086_400_000,
    });
    expect(invitations[1].expiresAt).toBeNull();
    expect((await readPendingInvitation(storage, 'bob', 'first'))?.payload).toEqual({
      token: 'invite-3',
    });

    expect(await deletePendingInvitation(storage, 'alice', 'first')).toBe(true);
    expect(await deletePendingInvitation(storage, 'alice', 'first')).toBe(false);
    expect(await listPendingInvitations(storage, 'alice')).toHaveLength(1);
  });

  it('restores after closing and reopening the database file', async () => {
    const first = await harness.openStorage();
    await savePendingInvitation(first, {
      accountId: 'alice',
      invitationKey: 'first',
      payload: { token: 'invite-1' },
    });
    await first.close();

    const second = await harness.openStorage();
    expect((await readPendingInvitation(second, 'alice', 'first'))?.payload).toEqual({
      token: 'invite-1',
    });
  });
});

describe('write transactions', () => {
  it('commits everything or nothing', async () => {
    const storage = await harness.openStorage();
    await expect(
      storage.withWriteTransaction(async (tx) => {
        await saveDraft(tx, 'alice', 'profile', { displayName: 'One' });
        await writeCache(tx, 'alice', 'friends', [], 1);
        throw new Error('rollback please');
      }),
    ).rejects.toThrow('rollback please');

    expect(await readDraft(storage, 'alice', 'profile')).toBeNull();
    expect(await readCache(storage, 'alice', 'friends')).toBeNull();

    await storage.withWriteTransaction(async (tx) => {
      await saveDraft(tx, 'alice', 'profile', { displayName: 'One' });
      await writeCache(tx, 'alice', 'friends', [], 1);
    });
    expect(await readDraft(storage, 'alice', 'profile')).not.toBeNull();
    expect(await readCache(storage, 'alice', 'friends')).not.toBeNull();
  });

  it('supports nested transactions through savepoints', async () => {
    const storage = await harness.openStorage();
    await storage.withWriteTransaction(async (tx) => {
      await saveDraft(tx, 'alice', 'outer', { step: 1 });
      try {
        await tx.withWriteTransaction(async (inner) => {
          await saveDraft(inner, 'alice', 'inner', { step: 2 });
          throw new Error('inner failed');
        });
      } catch {
        // The inner savepoint rolled back; the outer transaction continues.
      }
      await saveDraft(tx, 'alice', 'after', { step: 3 });
    });

    expect(await readDraft(storage, 'alice', 'outer')).not.toBeNull();
    expect(await readDraft(storage, 'alice', 'after')).not.toBeNull();
    expect(await readDraft(storage, 'alice', 'inner')).toBeNull();
  });
});

describe('account removal', () => {
  it('purges every account-owned row and file while the theme survives', async () => {
    const documentRoot = harness.documentRoot;
    const images = createImageStore({ fs: createNodeFileSystemPort(documentRoot) });
    const storageHandle = await harness.openStorage();

    const source = path.join(harness.root, 'avatar.png');
    fs.writeFileSync(source, 'avatar-bytes-for-alice');
    fs.writeFileSync(path.join(harness.root, 'bob.png'), 'avatar-bytes-for-bob');
    const aliceImage = await images.importImage('alice', source, { extension: 'png' });
    const bobImage = await images.importImage('bob', path.join(harness.root, 'bob.png'), {
      extension: 'png',
    });

    await saveDraft(storageHandle, 'alice', 'registration', { userId: 'alice' });
    await saveDraft(storageHandle, 'bob', 'registration', { userId: 'bob' });
    await writeCache(storageHandle, 'alice', 'friends', [{ id: 'bob' }]);
    await writeCache(storageHandle, 'bob', 'friends', []);
    await enqueueOperation(storageHandle, {
      accountId: 'alice',
      operationId: 'op-1',
      kind: 'profile.update',
      payload: {},
      createdAt: 1,
      expiresAt: 2,
      state: 'queued',
    });
    await enqueueOperation(storageHandle, {
      accountId: 'bob',
      operationId: 'op-1',
      kind: 'profile.update',
      payload: {},
      createdAt: 1,
      expiresAt: 2,
      state: 'queued',
    });
    await savePendingInvitation(storageHandle, {
      accountId: 'alice',
      invitationKey: 'first',
      payload: { token: 'invite' },
    });
    await writeAccountSetting(storageHandle, 'alice', 'guidance-seen', 'yes');
    await writeDeviceSetting(storageHandle, 'theme', 'dark');

    await deleteAccountData(storageHandle, 'alice', { images });

    // Account-owned rows and files are gone.
    expect(await readDraft(storageHandle, 'alice', 'registration')).toBeNull();
    expect(await readCache(storageHandle, 'alice', 'friends')).toBeNull();
    expect(await countOperations(storageHandle, 'alice')).toBe(0);
    expect(await listPendingInvitations(storageHandle, 'alice')).toEqual([]);
    expect(await listAccountSettings(storageHandle, 'alice')).toEqual({});
    expect(fs.existsSync(images.resolvePath(aliceImage))).toBe(false);
    expect(fs.existsSync(path.join(documentRoot, 'images', 'alice'))).toBe(false);

    // The other account and the device-scoped theme stay intact.
    expect(await readDraft(storageHandle, 'bob', 'registration')).not.toBeNull();
    expect(await readCache(storageHandle, 'bob', 'friends')).not.toBeNull();
    expect(await countOperations(storageHandle, 'bob')).toBe(1);
    expect(await readDeviceSetting(storageHandle, 'theme')).toBe('dark');
    expect(fs.existsSync(images.resolvePath(bobImage))).toBe(true);
  });
});

describe('image storage', () => {
  function ports(overrides: Partial<FileSystemPort> = {}): FileSystemPort {
    return { ...createNodeFileSystemPort(harness.documentRoot), ...overrides };
  }

  function stagingFiles(): string[] {
    const staging = path.join(harness.documentRoot, 'images', '.staging');
    return fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  }

  function accountFiles(accountId: string): string[] {
    const directory = path.join(harness.documentRoot, 'images', accountId);
    return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  }

  it('copies into the persistent document directory before returning a reference', async () => {
    const images = createImageStore({ fs: ports() });
    const source = path.join(harness.root, 'photo.jpg');
    const bytes = Buffer.from('0123456789abcdef');
    fs.writeFileSync(source, bytes);

    const reference = await images.importImage('alice', source);
    expect(reference.relativePath).toMatch(/^images\/alice\/.+\.jpg$/);
    expect(reference.bytes).toBe(bytes.length);

    const resolved = images.resolvePath(reference);
    expect(resolved.startsWith(harness.documentRoot)).toBe(true);
    expect(fs.readFileSync(resolved)).toEqual(bytes);
    expect(stagingFiles()).toEqual([]);
    expect(accountFiles('alice')).toHaveLength(1);
  });

  it('leaves no file and no reference when the copy fails midway', async () => {
    const images = createImageStore({
      fs: ports({
        copyFile: async (from: string, to: string) => {
          const partial = fs.readFileSync(from).subarray(0, 3);
          fs.writeFileSync(to, partial);
          throw new Error('device ran out of space');
        },
      }),
    });
    const source = path.join(harness.root, 'photo.jpg');
    fs.writeFileSync(source, 'full image content');

    await expect(images.importImage('alice', source)).rejects.toThrow(ImageImportError);
    expect(stagingFiles()).toEqual([]);
    expect(accountFiles('alice')).toEqual([]);
  });

  it('detects a silently truncated copy and removes it', async () => {
    const images = createImageStore({
      fs: ports({
        copyFile: async (from: string, to: string) => {
          const truncated = fs.readFileSync(from).subarray(0, 4);
          fs.writeFileSync(to, truncated);
        },
      }),
    });
    const source = path.join(harness.root, 'photo.jpg');
    fs.writeFileSync(source, 'full image content');

    await expect(images.importImage('alice', source)).rejects.toThrow('truncated');
    expect(stagingFiles()).toEqual([]);
    expect(accountFiles('alice')).toEqual([]);
  });

  it('cleans up when the move into the final location fails', async () => {
    const images = createImageStore({
      fs: ports({
        moveFile: async () => {
          throw new Error('rename failed');
        },
      }),
    });
    const source = path.join(harness.root, 'photo.jpg');
    fs.writeFileSync(source, 'full image content');

    await expect(images.importImage('alice', source)).rejects.toThrow(ImageImportError);
    expect(stagingFiles()).toEqual([]);
    expect(accountFiles('alice')).toEqual([]);
  });

  it('rejects a missing source without touching storage', async () => {
    const images = createImageStore({ fs: ports() });
    await expect(images.importImage('alice', path.join(harness.root, 'missing.jpg'))).rejects.toThrow(
      ImageImportError,
    );
    expect(stagingFiles()).toEqual([]);
    expect(fs.existsSync(path.join(harness.documentRoot, 'images'))).toBe(true);
    expect(accountFiles('alice')).toEqual([]);
  });

  it('removes single images and whole account directories', async () => {
    const images = createImageStore({ fs: ports() });
    const source = path.join(harness.root, 'photo.png');
    fs.writeFileSync(source, 'image content');

    const reference = await images.importImage('alice', source, { extension: 'png' });
    expect(accountFiles('alice')).toHaveLength(1);
    await images.removeImage(reference);
    expect(accountFiles('alice')).toEqual([]);

    await images.importImage('alice', source, { extension: 'png' });
    await images.removeAccountImages('alice');
    expect(fs.existsSync(path.join(harness.documentRoot, 'images', 'alice'))).toBe(false);
  });

  it('clears staged leftovers', async () => {
    const images = createImageStore({ fs: ports() });
    const staging = path.join(harness.documentRoot, 'images', '.staging');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'orphan.part'), 'partial');

    images.clearStaging();
    expect(stagingFiles()).toEqual([]);
  });
});

describe('chunked credential storage', () => {
  function strictBackend(limitBytes: number) {
    const store = new Map<string, string>();
    return {
      store,
      backend: {
        async getItem(key: string): Promise<string | null> {
          return store.has(key) ? (store.get(key) as string) : null;
        },
        async setItem(key: string, value: string): Promise<void> {
          if (Buffer.byteLength(value, 'utf8') > limitBytes) {
            throw new Error(`SecureStore rejected ${key}: value exceeds ${limitBytes} bytes`);
          }
          store.set(key, value);
        },
        async removeItem(key: string): Promise<void> {
          store.delete(key);
        },
      },
    };
  }

  it('round-trips a small session through the manifest format', async () => {
    const { backend } = strictBackend(1024);
    const secrets = createChunkedSecrets({ backend, newId: () => 'write-1' });
    await secrets.set('session.alice', '{"access_token":"short"}');
    expect(await secrets.get('session.alice')).toBe('{"access_token":"short"}');
    expect(await secrets.get('session.missing')).toBeNull();
    await secrets.remove('session.alice');
    expect(await secrets.get('session.alice')).toBeNull();
  });

  it('splits oversized sessions into platform-sized chunks and reassembles them', async () => {
    const limit = 256;
    const { backend, store } = strictBackend(limit);
    const secrets = createChunkedSecrets({
      backend,
      maxChunkBytes: limit,
      newId: () => `write-${store.size}`,
    });
    const session = JSON.stringify({
      access_token: 'a'.repeat(700),
      refresh_token: 'b'.repeat(700),
      user: { name: '夢夢夢', id: 'ゆめ_01' },
    });
    expect(Buffer.byteLength(session, 'utf8')).toBeGreaterThan(limit);

    await secrets.set('session.alice', session);

    const chunkKeys = [...store.keys()].filter((key) => key.startsWith('session.alice.'));
    expect(chunkKeys.length).toBeGreaterThan(1);
    for (const [key, value] of store) {
      expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(limit);
    }
    expect(await secrets.get('session.alice')).toBe(session);
  });

  it('never splits surrogate pairs and honors the byte budget for Japanese text', async () => {
    const maxBytes = 5;
    const value = '🙂🎉日本語の文字列とmixed ASCII';
    const pieces = splitUtf8Bytes(value, maxBytes);
    expect(pieces.join('')).toBe(value);
    for (const piece of pieces) {
      expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(maxBytes);
      expect(piece.length).toBeGreaterThan(0);
    }
    for (let index = 0; index < pieces.length - 1; index += 1) {
      const last = pieces[index].charCodeAt(pieces[index].length - 1);
      const firstNext = pieces[index + 1].charCodeAt(0);
      const splitPair =
        last >= 0xd800 && last <= 0xdbff && firstNext >= 0xdc00 && firstNext <= 0xdfff;
      expect(splitPair).toBe(false);
    }

    // The manifest itself needs more than 5 bytes, so the backend limit stays
    // realistic while chunks are budgeted at 5 bytes.
    const { backend } = strictBackend(64);
    const secrets = createChunkedSecrets({
      backend,
      maxChunkBytes: maxBytes,
      newId: () => 'unicode-write',
    });
    await secrets.set('session.unicode', value);
    expect(await secrets.get('session.unicode')).toBe(value);
  });

  it('fails loudly when a chunk disappears instead of returning a broken value', async () => {
    const { backend, store } = strictBackend(64);
    const secrets = createChunkedSecrets({
      backend,
      maxChunkBytes: 64,
      newId: () => 'lost-write',
    });
    await secrets.set('session.alice', 'x'.repeat(200));

    const chunkKeys = [...store.keys()].filter((key) => key.startsWith('session.alice.'));
    expect(chunkKeys.length).toBeGreaterThan(1);
    store.delete(chunkKeys[chunkKeys.length - 1]);

    await expect(secrets.get('session.alice')).rejects.toThrow(ChunkedSecretError);
  });

  it('cleans up chunks of the previous write when the value shrinks', async () => {
    const { backend, store } = strictBackend(64);
    const secrets = createChunkedSecrets({ backend, maxChunkBytes: 64, newId: () => 'v1' });
    await secrets.set('session.alice', 'y'.repeat(300));
    expect([...store.keys()].filter((key) => key.startsWith('session.alice.')).length).toBeGreaterThan(1);

    const shrunk = createChunkedSecrets({ backend, maxChunkBytes: 64, newId: () => 'v2' });
    await shrunk.set('session.alice', 'short');
    expect(await shrunk.get('session.alice')).toBe('short');
    expect([...store.keys()].filter((key) => key.startsWith('session.alice.')).sort()).toEqual([
      'session.alice.v2.0',
    ]);
  });
});
