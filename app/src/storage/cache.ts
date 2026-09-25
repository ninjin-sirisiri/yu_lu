import { requireNonEmpty, type Storage } from './database';

/**
 * Account-scoped cache for server reads (search results, profiles, friend
 * lists). Every entry records `fetched_at` so screens can show 最終更新時刻
 * and flag data that may be stale after a relaunch.
 */

export interface CacheRecord<T = unknown> {
  accountId: string;
  key: string;
  payload: T;
  fetchedAt: number;
}

export async function writeCache(
  db: Storage,
  accountId: string,
  key: string,
  payload: unknown,
  fetchedAt: number = Date.now(),
): Promise<void> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('key', key);
  const encoded = JSON.stringify(payload);
  if (typeof encoded !== 'string') {
    throw new Error('cache payload must be JSON-serializable');
  }
  await db.withWriteTransaction((tx) =>
    tx.runAsync(
      `INSERT INTO cache (account_id, cache_key, payload, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      [accountId, key, encoded, fetchedAt],
    ),
  );
}

export async function readCache<T = unknown>(
  db: Storage,
  accountId: string,
  key: string,
): Promise<CacheRecord<T> | null> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('key', key);
  const row = await db.getFirstAsync<{ payload: string; fetched_at: number }>(
    'SELECT payload, fetched_at FROM cache WHERE account_id = ? AND cache_key = ?',
    [accountId, key],
  );
  if (!row) return null;
  return {
    accountId,
    key,
    payload: JSON.parse(row.payload) as T,
    fetchedAt: row.fetched_at,
  };
}

/** Removes one cache entry. Returns true when a row was deleted. */
export async function deleteCache(db: Storage, accountId: string, key: string): Promise<boolean> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('key', key);
  return db.withWriteTransaction(async (tx) => {
    const result = await tx.runAsync('DELETE FROM cache WHERE account_id = ? AND cache_key = ?', [
      accountId,
      key,
    ]);
    return result.changes > 0;
  });
}

/** Keys and fetch times cached for one account, newest first. */
export async function listCache(
  db: Storage,
  accountId: string,
): Promise<Array<{ key: string; fetchedAt: number }>> {
  requireNonEmpty('accountId', accountId);
  const rows = await db.getAllAsync<{ cache_key: string; fetched_at: number }>(
    'SELECT cache_key, fetched_at FROM cache WHERE account_id = ? ORDER BY fetched_at DESC, cache_key ASC',
    [accountId],
  );
  return rows.map((row) => ({ key: row.cache_key, fetchedAt: row.fetched_at }));
}
