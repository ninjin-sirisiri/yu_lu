import { requireNonEmpty, type Storage } from './database';

/**
 * `pending_invitation` rows: invitation information saved on the device while
 * registration or a relaunch is still in progress (OAuth return, install
 * hand-off, pasted link). Storage keeps the primitives; the invitations module
 * decides product rules such as keeping the first invitation when a second one
 * is opened.
 */

export interface PendingInvitationRecord {
  accountId: string;
  invitationKey: string;
  payload: unknown;
  createdAt: number;
  expiresAt: number | null;
}

interface PendingInvitationRow {
  invitation_key: string;
  payload: string;
  created_at: number;
  expires_at: number | null;
}

function toRecord(accountId: string, row: PendingInvitationRow): PendingInvitationRecord {
  return {
    accountId,
    invitationKey: row.invitation_key,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export interface SavePendingInvitationInput {
  accountId: string;
  invitationKey: string;
  payload: unknown;
  createdAt?: number;
  expiresAt?: number | null;
}

/** Stores (or replaces) one pending invitation for an account. */
export async function savePendingInvitation(
  db: Storage,
  input: SavePendingInvitationInput,
): Promise<void> {
  requireNonEmpty('accountId', input.accountId);
  requireNonEmpty('invitationKey', input.invitationKey);
  const encoded = JSON.stringify(input.payload);
  if (typeof encoded !== 'string') {
    throw new Error('invitation payload must be JSON-serializable');
  }
  await db.withWriteTransaction((tx) =>
    tx.runAsync(
      `INSERT OR REPLACE INTO pending_invitation
         (account_id, invitation_key, payload, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.accountId,
        input.invitationKey,
        encoded,
        input.createdAt ?? Date.now(),
        input.expiresAt ?? null,
      ],
    ),
  );
}

export async function readPendingInvitation(
  db: Storage,
  accountId: string,
  invitationKey: string,
): Promise<PendingInvitationRecord | null> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('invitationKey', invitationKey);
  const row = await db.getFirstAsync<PendingInvitationRow>(
    'SELECT * FROM pending_invitation WHERE account_id = ? AND invitation_key = ?',
    [accountId, invitationKey],
  );
  return row ? toRecord(accountId, row) : null;
}

/** Pending invitations of one account, oldest first. */
export async function listPendingInvitations(
  db: Storage,
  accountId: string,
): Promise<PendingInvitationRecord[]> {
  requireNonEmpty('accountId', accountId);
  const rows = await db.getAllAsync<PendingInvitationRow>(
    'SELECT * FROM pending_invitation WHERE account_id = ? ORDER BY created_at ASC, invitation_key ASC',
    [accountId],
  );
  return rows.map((row) => toRecord(accountId, row));
}

/** Removes one pending invitation. Returns true when a row was deleted. */
export async function deletePendingInvitation(
  db: Storage,
  accountId: string,
  invitationKey: string,
): Promise<boolean> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('invitationKey', invitationKey);
  return db.withWriteTransaction(async (tx) => {
    const result = await tx.runAsync(
      'DELETE FROM pending_invitation WHERE account_id = ? AND invitation_key = ?',
      [accountId, invitationKey],
    );
    return result.changes > 0;
  });
}
