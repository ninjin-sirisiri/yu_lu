import * as SQLite from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import type { ImageStore } from './files';
import { runMigrations, schemaMigrations, schemaVersion, type Migration } from './migrations';

/**
 * Account-scoped device storage (SQLite).
 *
 * One SQLite file holds every table; every account-owned row carries an
 * `account_id` column so a single account can be purged without touching the
 * others. `device_settings` uses a NULL `account_id` for device-scoped values
 * (theme and other 端末設定), which survive account removal.
 *
 * All storage modules expose functions that take a {@link Storage} handle
 * instead of issuing ad-hoc SQL at call sites. Writes wrap themselves in
 * {@link Storage.withWriteTransaction}; passing the transaction handle that a
 * transaction callback receives nests correctly (savepoints), so higher layers
 * (for example the Task 9 outbox worker) can compose several storage calls into
 * one atomic write.
 */

/** Values the storage layer binds as SQL parameters. */
export type SqlValue = string | number | boolean | null;
export type SqlParams = readonly SqlValue[];

export interface SqlRunResult {
  lastInsertRowId: number;
  changes: number;
}

/**
 * Minimal SQL surface used by every storage module. `expo-sqlite`'s
 * `SQLiteDatabase` is adapted to this interface; tests inject a driver backed
 * by Node's built-in SQLite so the same SQL runs against a real engine.
 */
export interface Storage {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: SqlParams): Promise<SqlRunResult>;
  getFirstAsync<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T | null>;
  getAllAsync<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]>;
  /**
   * Runs `fn` inside a write transaction and commits on success, rolls back on
   * any thrown error. Calling this on the handle passed to the callback opens a
   * nested (savepoint) transaction on the same connection.
   */
  withWriteTransaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T>;
}

export interface StorageDriver extends Storage {
  close(): Promise<void>;
}

export interface AppStorage extends StorageDriver {
  /** Current `PRAGMA user_version` of the schema. */
  schemaVersion(): Promise<number>;
}

export const DEFAULT_DATABASE_NAME = 'app.db';

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/** Throws unless `value` is a non-empty string. */
export function requireNonEmpty(name: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StorageError(`${name} must be a non-empty string`);
  }
  return value;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Encodes an arbitrary string so it is safe to use as a single path segment
 * or SecureStore key. Safe values are kept readable; anything else becomes a
 * reversible hex form, so distinct inputs can never collide in one directory.
 */
export function safeSegment(value: string): string {
  if (SAFE_SEGMENT.test(value) && value !== '.' && value !== '..') {
    return value;
  }
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    out += value.charCodeAt(i).toString(16).padStart(4, '0');
  }
  return `x${out}`;
}

/** UTF-8 byte length of a string, without relying on TextEncoder. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
        continue;
      }
      bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Random identifier used for image staging and chunked-secret write IDs.
 * Prefers the Web Crypto API, then expo-crypto; throws when neither produces a
 * value instead of silently returning `undefined`.
 */
export function randomId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    const id = webCrypto.randomUUID();
    if (typeof id === 'string' && id.length > 0) return id;
  }
  const id = typeof Crypto.randomUUID === 'function' ? Crypto.randomUUID() : undefined;
  if (typeof id === 'string' && id.length > 0) return id;
  throw new StorageError('no random UUID source is available');
}

/**
 * Adapter over `expo-sqlite`. The root handle serializes transactions with a
 * promise queue; the handle passed to a transaction callback issues savepoints
 * on the transaction connection so nested storage calls stay atomic.
 */
class ExpoSqliteDriver implements StorageDriver {
  private savepointSeq = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: SQLiteDatabase,
    private readonly ownsConnection: boolean,
    private readonly inTransaction: boolean = false,
  ) {}

  execAsync(sql: string): Promise<void> {
    return this.db.execAsync(sql);
  }

  async runAsync(sql: string, params: SqlParams = []): Promise<SqlRunResult> {
    const result = await this.db.runAsync(sql, [...params]);
    return { lastInsertRowId: result.lastInsertRowId, changes: result.changes };
  }

  getFirstAsync<T>(sql: string, params: SqlParams = []): Promise<T | null> {
    return this.db.getFirstAsync<T>(sql, [...params]);
  }

  getAllAsync<T>(sql: string, params: SqlParams = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, [...params]);
  }

  withWriteTransaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      return this.runSavepoint(fn);
    }
    const run = this.queue.then(
      () => undefined,
      () => undefined,
    ).then(async () => {
      let result!: T;
      await this.db.withExclusiveTransactionAsync(async (txn) => {
        result = await fn(new ExpoSqliteDriver(txn, false, true));
      });
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runSavepoint<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
    this.savepointSeq += 1;
    const name = `storage_sp_${this.savepointSeq}`;
    await this.db.execAsync(`SAVEPOINT ${name}`);
    try {
      const result = await fn(this);
      await this.db.execAsync(`RELEASE ${name}`);
      return result;
    } catch (error) {
      await this.db.execAsync(`ROLLBACK TO ${name}`);
      await this.db.execAsync(`RELEASE ${name}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.ownsConnection) {
      await this.db.closeAsync();
    }
  }
}

export interface OpenAppDatabaseOptions {
  /** Database file name for the default expo-sqlite driver. */
  name?: string;
  /** Inject an already opened driver (used by tests). */
  driver?: StorageDriver;
  /** Migration list; defaults to the app schema. */
  migrations?: readonly Migration[];
  /** Skip schema migration (the caller manages `user_version`). */
  skipMigrations?: boolean;
}

/**
 * Opens the app database, applies pending schema migrations and returns the
 * shared storage handle. Closes a driver it created itself when opening fails,
 * so a rejected open never leaks a connection.
 */
export async function openAppDatabase(options: OpenAppDatabaseOptions = {}): Promise<AppStorage> {
  const ownsDriver = options.driver === undefined;
  const driver =
    options.driver ?? new ExpoSqliteDriver(await SQLite.openDatabaseAsync(options.name ?? DEFAULT_DATABASE_NAME), true);
  try {
    await driver.execAsync('PRAGMA journal_mode = WAL');
    if (!options.skipMigrations) {
      await runMigrations(driver, options.migrations ?? schemaMigrations);
    }
    return wrapAppStorage(driver);
  } catch (error) {
    if (ownsDriver) {
      try {
        await driver.close();
      } catch {
        // Preserve the original opening error.
      }
    }
    throw error;
  }
}

function wrapAppStorage(driver: StorageDriver): AppStorage {
  return {
    execAsync: (sql) => driver.execAsync(sql),
    runAsync: (sql, params) => driver.runAsync(sql, params),
    getFirstAsync: <T>(sql: string, params?: SqlParams) => driver.getFirstAsync<T>(sql, params),
    getAllAsync: <T>(sql: string, params?: SqlParams) => driver.getAllAsync<T>(sql, params),
    withWriteTransaction: <T>(fn: (tx: Storage) => Promise<T>) => driver.withWriteTransaction(fn),
    schemaVersion: () => schemaVersion(driver),
    close: () => driver.close(),
  };
}

export interface DeleteAccountDataOptions {
  /** Image store whose account directory is removed after the rows are gone. */
  images?: ImageStore;
}

/**
 * Removes every account-owned row and file for `accountId`: cache, drafts,
 * outbox queue/counters, chat history/drafts/read intents, attachment/cache
 * references, pending invitations, account settings and copied images.
 * Device-scoped `device_settings` rows (theme, 端末設定) are left untouched.
 *
 * Row removal is transactional; the image directory is removed afterwards, so
 * a file failure can only leave unreferenced orphan files, never references
 * without files.
 */
export async function deleteAccountData(
  db: Storage,
  accountId: string,
  options: DeleteAccountDataOptions = {},
): Promise<void> {
  requireNonEmpty('accountId', accountId);
  await db.withWriteTransaction(async (tx) => {
    await tx.runAsync('DELETE FROM chat_attachment_refs WHERE account_id = ?', [accountId]);
    await tx.runAsync('DELETE FROM chat_image_cache WHERE account_id = ?', [accountId]);
    await tx.runAsync('DELETE FROM chat_read_intents WHERE account_id = ?', [accountId]);
    await tx.runAsync('DELETE FROM chat_drafts WHERE account_id = ?', [accountId]);
    await tx.runAsync('DELETE FROM chat_messages WHERE account_id = ?', [accountId]);
    await tx.runAsync('DELETE FROM outbox_sequences WHERE account_id = ?', [accountId]);
    await tx.runAsync('DELETE FROM cache WHERE account_id = ?', [accountId]);
    await tx.runAsync('DELETE FROM drafts WHERE account_id = ?', [accountId]);
    await tx.runAsync('DELETE FROM outbox WHERE account_id = ?', [accountId]);
    await tx.runAsync('DELETE FROM pending_invitation WHERE account_id = ?', [accountId]);
    await tx.runAsync('DELETE FROM device_settings WHERE account_id = ?', [accountId]);
  });
  if (options.images) {
    await options.images.removeAccountImages(accountId);
  }
}
