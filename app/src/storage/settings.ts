import { requireNonEmpty, type Storage } from './database';

/**
 * `device_settings` accessors. Two scopes share the table:
 *
 * - Device scope (`account_id IS NULL`): 端末設定 that must survive account
 *   removal — theme choice and the 07:00/19:00 時間帯指定.
 * - Account scope (`account_id = <id>`): per-account settings such as whether
 *   the first-run guidance was seen; deleted with the account.
 *
 * `INSERT OR REPLACE` resolves conflicts through the table's primary key and,
 * for device rows, through the partial unique index on `key`.
 */

export async function readDeviceSetting(db: Storage, key: string): Promise<string | null> {
  requireNonEmpty('key', key);
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM device_settings WHERE account_id IS NULL AND key = ?',
    [key],
  );
  return row?.value ?? null;
}

export async function writeDeviceSetting(
  db: Storage,
  key: string,
  value: string,
  updatedAt: number = Date.now(),
): Promise<void> {
  requireNonEmpty('key', key);
  await db.withWriteTransaction((tx) =>
    tx.runAsync(
      'INSERT OR REPLACE INTO device_settings (account_id, key, value, updated_at) VALUES (NULL, ?, ?, ?)',
      [key, value, updatedAt],
    ),
  );
}

export async function readAccountSetting(
  db: Storage,
  accountId: string,
  key: string,
): Promise<string | null> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('key', key);
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM device_settings WHERE account_id = ? AND key = ?',
    [accountId, key],
  );
  return row?.value ?? null;
}

export async function writeAccountSetting(
  db: Storage,
  accountId: string,
  key: string,
  value: string,
  updatedAt: number = Date.now(),
): Promise<void> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('key', key);
  await db.withWriteTransaction((tx) =>
    tx.runAsync(
      'INSERT OR REPLACE INTO device_settings (account_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
      [accountId, key, value, updatedAt],
    ),
  );
}

/** Every account-scoped setting of one account. */
export async function listAccountSettings(
  db: Storage,
  accountId: string,
): Promise<Record<string, string>> {
  requireNonEmpty('accountId', accountId);
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    'SELECT key, value FROM device_settings WHERE account_id = ?',
    [accountId],
  );
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}
