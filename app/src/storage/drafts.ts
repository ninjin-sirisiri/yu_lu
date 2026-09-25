import { requireNonEmpty, type Storage } from './database';

/**
 * Account-scoped local drafts (registration input, profile edits, and other
 * form state). Bodies are stored as JSON so screens restore exactly what the
 * user typed after a relaunch.
 */

export interface DraftRecord<T = unknown> {
  accountId: string;
  key: string;
  body: T;
  updatedAt: number;
}

function encodeBody(body: unknown): string {
  const encoded = JSON.stringify(body);
  if (typeof encoded !== 'string') {
    throw new Error('draft body must be JSON-serializable');
  }
  return encoded;
}

export async function saveDraft(
  db: Storage,
  accountId: string,
  key: string,
  body: unknown,
  updatedAt: number = Date.now(),
): Promise<void> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('key', key);
  const encoded = encodeBody(body);
  await db.withWriteTransaction((tx) =>
    tx.runAsync(
      `INSERT INTO drafts (account_id, draft_key, body, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, draft_key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      [accountId, key, encoded, updatedAt],
    ),
  );
}

export async function readDraft<T = unknown>(
  db: Storage,
  accountId: string,
  key: string,
): Promise<DraftRecord<T> | null> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('key', key);
  const row = await db.getFirstAsync<{ body: string; updated_at: number }>(
    'SELECT body, updated_at FROM drafts WHERE account_id = ? AND draft_key = ?',
    [accountId, key],
  );
  if (!row) return null;
  return {
    accountId,
    key,
    body: JSON.parse(row.body) as T,
    updatedAt: row.updated_at,
  };
}

/** Removes a draft. Returns true when a row was deleted. */
export async function deleteDraft(db: Storage, accountId: string, key: string): Promise<boolean> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('key', key);
  return db.withWriteTransaction(async (tx) => {
    const result = await tx.runAsync('DELETE FROM drafts WHERE account_id = ? AND draft_key = ?', [
      accountId,
      key,
    ]);
    return result.changes > 0;
  });
}

/** All drafts of one account, most recently updated first. */
export async function listDrafts(db: Storage, accountId: string): Promise<DraftRecord[]> {
  requireNonEmpty('accountId', accountId);
  const rows = await db.getAllAsync<{ draft_key: string; body: string; updated_at: number }>(
    'SELECT draft_key, body, updated_at FROM drafts WHERE account_id = ? ORDER BY updated_at DESC, draft_key ASC',
    [accountId],
  );
  return rows.map((row) => ({
    accountId,
    key: row.draft_key,
    body: JSON.parse(row.body) as unknown,
    updatedAt: row.updated_at,
  }));
}
