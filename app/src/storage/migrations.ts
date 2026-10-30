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
  {
    version: 2,
    description: 'account/peer chat storage and durable outbox ordering and delivery metadata',
    async up(tx: Storage): Promise<void> {
      await tx.execAsync(`
ALTER TABLE outbox ADD COLUMN ordering_key TEXT;
ALTER TABLE outbox ADD COLUMN queue_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0);
ALTER TABLE outbox ADD COLUMN claimed_at INTEGER;
ALTER TABLE outbox ADD COLUMN reach_stage TEXT;
ALTER TABLE outbox ADD COLUMN result TEXT;
WITH positions AS (
  SELECT account_id, operation_id,
    ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at, operation_id) AS position
  FROM outbox
)
UPDATE outbox SET queue_sequence = (
  SELECT position FROM positions
  WHERE positions.account_id = outbox.account_id AND positions.operation_id = outbox.operation_id
);
CREATE INDEX outbox_account_ordering ON outbox (account_id, ordering_key, queue_sequence);
CREATE TABLE outbox_sequences (
  account_id TEXT PRIMARY KEY NOT NULL,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
);
INSERT INTO outbox_sequences (account_id, last_sequence)
  SELECT account_id, MAX(queue_sequence) FROM outbox GROUP BY account_id;
CREATE TABLE chat_messages (
  account_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  client_key TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  withdrawn INTEGER NOT NULL CHECK (withdrawn IN (0, 1)),
  body TEXT,
  image_paths TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id),
  UNIQUE (account_id, conversation_id, sequence)
);
CREATE INDEX chat_messages_peer_sequence ON chat_messages (account_id, peer_id, sequence);
CREATE TABLE chat_drafts (
  account_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, peer_id)
);
CREATE TABLE chat_read_intents (
  account_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_ids TEXT NOT NULL,
  through_sequence INTEGER CHECK (through_sequence IS NULL OR through_sequence > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, intent_id)
);
CREATE INDEX chat_read_intents_account_created ON chat_read_intents (account_id, created_at, intent_id);
CREATE TABLE chat_attachment_refs (
  account_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('draft', 'outbox', 'message')),
  owner_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  image_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  PRIMARY KEY (account_id, owner_kind, owner_id, position)
);
CREATE TABLE chat_image_cache (
  account_id TEXT NOT NULL,
  remote_path TEXT NOT NULL,
  image_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  last_accessed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, remote_path)
);
CREATE INDEX chat_image_cache_lru ON chat_image_cache (account_id, last_accessed_at, remote_path);
`);
    },
  },
  {
    version: 3,
    description: 'minimal appearance celebration ledger keyed by account, kind and internal subject',
    async up(tx: Storage): Promise<void> {
      // Deliberately contains no name, User ID text, body or image column:
      // subject_id is an internal peer UUID (or the literal 'self' for the
      // personal streak) used only to distinguish subjects, never display.
      await tx.execAsync(`
CREATE TABLE appearance_celebrations (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'streak')),
  subject_id TEXT NOT NULL,
  baseline_days INTEGER NOT NULL CHECK (baseline_days >= 0),
  consumed_milestone INTEGER NOT NULL DEFAULT 0
    CHECK (consumed_milestone IN (0, 1, 7, 30, 60, 100)),
  PRIMARY KEY (account_id, kind, subject_id)
);
`);
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
