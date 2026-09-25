/**
 * Node-only test doubles for the storage layer, used by
 * `__tests__/storage.integration.test.ts` (and later queue tests). They run the
 * real SQL above Node's built-in SQLite (`node:sqlite`) and a real file
 * system, so SQL-boundary tests exercise the same statements as the device
 * build, which uses `expo-sqlite`.
 *
 * Never import this module from app code: Metro cannot resolve `node:sqlite`.
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SqlParams, SqlRunResult, Storage, StorageDriver } from '../database';
import type { FileSystemPort } from '../files';

let savepointSeq = 0;

/** Booleans are not a SQLite storage class; bind them as 0/1 like expo-sqlite does. */
function bindValues(params?: SqlParams): Array<string | number | null> {
  if (!params) return [];
  return params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value));
}

export class NodeSqliteDriver implements StorageDriver {
  private readonly db: DatabaseSync;
  private depth = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
  }

  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async runAsync(sql: string, params?: SqlParams): Promise<SqlRunResult> {
    const result = this.db.prepare(sql).run(...bindValues(params));
    return {
      lastInsertRowId: Number(result.lastInsertRowid),
      changes: Number(result.changes),
    };
  }

  async getFirstAsync<T>(sql: string, params?: SqlParams): Promise<T | null> {
    const row = this.db.prepare(sql).get(...bindValues(params));
    return (row ?? null) as unknown as T | null;
  }

  async getAllAsync<T>(sql: string, params?: SqlParams): Promise<T[]> {
    return this.db.prepare(sql).all(...bindValues(params)) as unknown as T[];
  }

  async withWriteTransaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
    if (this.depth > 0) {
      savepointSeq += 1;
      const name = `test_sp_${savepointSeq}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = await fn(this);
        this.db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
        throw error;
      }
    }
    const run = this.queue
      .then(
        () => undefined,
        () => undefined,
      )
      .then(async () => {
        this.db.exec('BEGIN IMMEDIATE');
        this.depth = 1;
        try {
          const result = await fn(this);
          this.db.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            // The transaction may already be gone; rethrow the original error.
          }
          throw error;
        } finally {
          this.depth = 0;
        }
      });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

/** `expo-file-system`-shaped port backed by the local file system. */
export function createNodeFileSystemPort(documentRoot: string): FileSystemPort {
  return {
    documentRoot,
    join(...segments: string[]): string {
      return path.join(...segments);
    },
    ensureDirectory(target: string): void {
      fs.mkdirSync(target, { recursive: true });
    },
    exists(target: string): boolean {
      return fs.existsSync(target);
    },
    size(target: string): number {
      try {
        return fs.statSync(target).size;
      } catch {
        return 0;
      }
    },
    async copyFile(from: string, to: string): Promise<void> {
      await fs.promises.copyFile(from, to);
    },
    async moveFile(from: string, to: string): Promise<void> {
      await fs.promises.rename(from, to);
    },
    removeFile(target: string): void {
      fs.rmSync(target, { force: true });
    },
    removeDirectory(target: string): void {
      fs.rmSync(target, { recursive: true, force: true });
    },
  };
}
