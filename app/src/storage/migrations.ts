import type { Storage } from './database';

/**
 * Versioned schema migrations. `PRAGMA user_version` records the applied
 * version; each pending migration runs inside its own write transaction and
 * bumps the version in the same transaction, so a failed migration leaves the
 * database at the previous version with nothing half-applied.
 */

export interface Migration {
  /** Sequential version starting at 1. */
  version: number;
  description: string;
  up(tx: Storage): Promise<void>;
}

const initialSchema = `
CREATE TABLE IF NOT EXISTS cache (
  account_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, cache_key)
);
CREATE TABLE IF NOT EXISTS drafts (
  account_id TEXT NOT NULL,
  draft_key TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, draft_key)
);
CREATE TABLE IF NOT EXISTS outbox (
  account_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  base_version INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  state TEXT NOT NULL,
  PRIMARY KEY (account_id, operation_id)
);
CREATE INDEX IF NOT EXISTS outbox_account_state
  ON outbox (account_id, state, next_attempt_at);
CREATE TABLE IF NOT EXISTS pending_invitation (
  account_id TEXT NOT NULL,
  invitation_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (account_id, invitation_key)
);
CREATE TABLE IF NOT EXISTS device_settings (
  account_id TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
);
CREATE UNIQUE INDEX IF NOT EXISTS device_settings_device_scope
  ON device_settings (key) WHERE account_id IS NULL;
`;

export const schemaMigrations: readonly Migration[] = [
  {
    version: 1,
    description: 'account-keyed cache, drafts, outbox, pending invitations and settings',
    async up(tx: Storage): Promise<void> {
      await tx.execAsync(initialSchema);
    },
  },
];

export const SCHEMA_VERSION = schemaMigrations[schemaMigrations.length - 1].version;

export class SchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

/** Reads `PRAGMA user_version`. */
export async function schemaVersion(db: Storage): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  return typeof row?.user_version === 'number' ? row.user_version : 0;
}

/**
 * Applies every migration newer than the current version, one transaction per
 * migration. Refuses to run when the database was written by a newer app
 * version than this build knows.
 *
 * Returns the schema version after migrating.
 */
export async function runMigrations(
  db: Storage,
  list: readonly Migration[] = schemaMigrations,
): Promise<number> {
  list.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`migrations must be numbered 1..n in order; got version ${migration.version} at index ${index}`);
    }
  });
  const latest = list.length;
  const current = await schemaVersion(db);
  if (current > latest) {
    throw new SchemaVersionError(
      `database schema version ${current} is newer than the supported version ${latest}`,
    );
  }
  for (const migration of list) {
    if (migration.version <= current) continue;
    await db.withWriteTransaction(async (tx) => {
      await migration.up(tx);
      await tx.execAsync(`PRAGMA user_version = ${migration.version}`);
    });
  }
  return latest;
}
