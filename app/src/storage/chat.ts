import { requireNonEmpty, safeSegment, StorageError, type Storage } from './database';
import type { ImageReference } from './files';
import type { AcceptedMessage, AttachmentOwner, ChatDraft, ChatImageCacheEntry, ChatReadIntent } from '../messages/types';

function scope(accountId: string, peerId: string): void {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('peerId', peerId);
}

/** All local chat files live in the existing ImageStore account directory,
 * including viewing copies, so account removal can remove them in one pass.
 * This rejects temporary picker URIs, traversal and another account's files. */
function validateReference(accountId: string, image: ImageReference): void {
  const parts = image.relativePath.split('/');
  if (image.accountId !== accountId || parts.length !== 3 || parts[0] !== 'images' ||
      parts[1] !== safeSegment(accountId) || !/^[A-Za-z0-9._-]+$/.test(parts[2]) ||
      parts[2] === '.' || parts[2] === '..' || !Number.isSafeInteger(image.bytes) || image.bytes <= 0) {
    throw new StorageError('attachment must reference a persistent image owned by this account');
  }
  requireNonEmpty('imageId', image.imageId);
}

interface AttachmentRow { image_id: string; relative_path: string; bytes: number }
function imageFromRow(accountId: string, row: AttachmentRow): ImageReference {
  return { accountId, imageId: row.image_id, relativePath: row.relative_path, bytes: row.bytes };
}

/** Replaces only this owner's ordered references, never the file or another
 * owner's references. Compose with an outbox enqueue using its tx handle. */
export async function saveAttachmentReferences(
  db: Storage, accountId: string, ownerKind: AttachmentOwner, ownerId: string, images: readonly ImageReference[],
): Promise<void> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('ownerId', ownerId);
  for (const image of images) validateReference(accountId, image);
  await db.withWriteTransaction(async tx => {
    await tx.runAsync('DELETE FROM chat_attachment_refs WHERE account_id = ? AND owner_kind = ? AND owner_id = ?',
      [accountId, ownerKind, ownerId]);
    for (const [position, image] of images.entries()) {
      await tx.runAsync(`INSERT INTO chat_attachment_refs
        (account_id, owner_kind, owner_id, position, image_id, relative_path, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [accountId, ownerKind, ownerId, position, image.imageId, image.relativePath, image.bytes]);
    }
  });
}

export async function listAttachmentReferences(
  db: Storage, accountId: string, ownerKind: AttachmentOwner, ownerId: string,
): Promise<ImageReference[]> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('ownerId', ownerId);
  const rows = await db.getAllAsync<AttachmentRow>(`SELECT image_id, relative_path, bytes FROM chat_attachment_refs
    WHERE account_id = ? AND owner_kind = ? AND owner_id = ? ORDER BY position`, [accountId, ownerKind, ownerId]);
  return rows.map(row => imageFromRow(accountId, row));
}

/** Saves the current composer atomically with its attachment references.
 * Cancelled/superseded operations remain independent outbox records. */
export async function saveChatDraft(db: Storage, draft: ChatDraft): Promise<void> {
  scope(draft.accountId, draft.peerId);
  await db.withWriteTransaction(async tx => {
    await tx.runAsync(`INSERT INTO chat_drafts (account_id, peer_id, body, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (account_id, peer_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    [draft.accountId, draft.peerId, draft.body, draft.updatedAt]);
    await saveAttachmentReferences(tx, draft.accountId, 'draft', draft.peerId, draft.attachments);
  });
}

export async function readChatDraft(db: Storage, accountId: string, peerId: string): Promise<ChatDraft | null> {
  scope(accountId, peerId);
  return db.withWriteTransaction(async tx => {
    const row = await tx.getFirstAsync<{ body: string; updated_at: number }>(
      'SELECT body, updated_at FROM chat_drafts WHERE account_id = ? AND peer_id = ?', [accountId, peerId]);
    return row ? { accountId, peerId, body: row.body, updatedAt: row.updated_at,
      attachments: await listAttachmentReferences(tx, accountId, 'draft', peerId) } : null;
  });
}

/** An accepted receipt is immutable. Re-fetches are idempotent; withdrawal is
 * monotonic and redacts content even if an older response arrives afterwards. */
export async function storeAcceptedMessage(db: Storage, message: AcceptedMessage): Promise<void> {
  scope(message.accountId, message.peerId);
  requireNonEmpty('messageId', message.messageId);
  requireNonEmpty('conversationId', message.conversationId);
  if (!Number.isSafeInteger(message.sequence) || message.sequence <= 0) throw new StorageError('invalid message sequence');
  const parties = [message.senderId, message.recipientId];
  if (message.accountId === message.peerId || !parties.includes(message.accountId) || !parties.includes(message.peerId)) {
    throw new StorageError('message parties do not match account and peer');
  }
  await db.withWriteTransaction(async tx => {
    const old = await tx.getFirstAsync<{ peer_id: string; conversation_id: string; sequence: number }>(
      'SELECT peer_id, conversation_id, sequence FROM chat_messages WHERE account_id = ? AND message_id = ?',
      [message.accountId, message.messageId]);
    if (old && (old.peer_id !== message.peerId || old.conversation_id !== message.conversationId || old.sequence !== message.sequence)) {
      throw new StorageError('accepted message identity cannot change');
    }
    await tx.runAsync(`INSERT INTO chat_messages (account_id, peer_id, message_id, conversation_id, sequence,
      sender_id, recipient_id, client_key, accepted_at, withdrawn, body, image_paths)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, message_id) DO UPDATE SET
        withdrawn = MAX(chat_messages.withdrawn, excluded.withdrawn),
        body = CASE WHEN chat_messages.withdrawn OR excluded.withdrawn THEN NULL ELSE chat_messages.body END,
        image_paths = CASE WHEN chat_messages.withdrawn OR excluded.withdrawn THEN '[]' ELSE chat_messages.image_paths END`,
    [message.accountId, message.peerId, message.messageId, message.conversationId, message.sequence, message.senderId,
      message.recipientId, message.clientKey, message.acceptedAt, message.withdrawn,
      message.withdrawn ? null : message.body, JSON.stringify(message.withdrawn ? [] : message.imagePaths)]);
    if (message.withdrawn) {
      await tx.runAsync("DELETE FROM chat_attachment_refs WHERE account_id = ? AND owner_kind = 'message' AND owner_id = ?",
        [message.accountId, message.messageId]);
    }
  });
}

interface MessageRow {
  message_id: string; conversation_id: string; sequence: number; sender_id: string; recipient_id: string;
  client_key: string; accepted_at: string; withdrawn: number; body: string | null; image_paths: string;
}

/** Only confirmed history, in server sequence order. Unsent display items are
 * composed separately from the outbox by the conversation repository. */
export async function listLocalMessages(db: Storage, accountId: string, peerId: string): Promise<AcceptedMessage[]> {
  scope(accountId, peerId);
  const rows = await db.getAllAsync<MessageRow>(
    'SELECT * FROM chat_messages WHERE account_id = ? AND peer_id = ? ORDER BY sequence ASC', [accountId, peerId]);
  return rows.map(row => ({ accountId, peerId, messageId: row.message_id, conversationId: row.conversation_id,
    sequence: row.sequence, senderId: row.sender_id, recipientId: row.recipient_id, clientKey: row.client_key,
    acceptedAt: row.accepted_at, withdrawn: row.withdrawn === 1, body: row.body, imagePaths: JSON.parse(row.image_paths) as string[] }));
}

/** Idempotent immutable intent, safe to replay under the same operation ID. */
export async function saveReadIntent(db: Storage, intent: ChatReadIntent): Promise<boolean> {
  scope(intent.accountId, intent.peerId);
  requireNonEmpty('intentId', intent.intentId);
  requireNonEmpty('conversationId', intent.conversationId);
  if (intent.throughSequence !== null && (!Number.isSafeInteger(intent.throughSequence) || intent.throughSequence <= 0)) {
    throw new StorageError('invalid read intent bound');
  }
  return db.withWriteTransaction(async tx => (await tx.runAsync(`INSERT INTO chat_read_intents
    (account_id, intent_id, peer_id, conversation_id, message_ids, through_sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, intent_id) DO NOTHING`, [intent.accountId, intent.intentId, intent.peerId,
    intent.conversationId, JSON.stringify(intent.messageIds), intent.throughSequence, intent.createdAt])).changes > 0);
}

export async function listReadIntents(db: Storage, accountId: string): Promise<ChatReadIntent[]> {
  requireNonEmpty('accountId', accountId);
  const rows = await db.getAllAsync<{ intent_id: string; peer_id: string; conversation_id: string;
    message_ids: string; through_sequence: number | null; created_at: number }>(
    'SELECT * FROM chat_read_intents WHERE account_id = ? ORDER BY created_at, intent_id', [accountId]);
  return rows.map(row => ({ accountId, intentId: row.intent_id, peerId: row.peer_id, conversationId: row.conversation_id,
    messageIds: JSON.parse(row.message_ids) as string[], throughSequence: row.through_sequence, createdAt: row.created_at }));
}

export async function removeReadIntent(db: Storage, accountId: string, intentId: string): Promise<boolean> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('intentId', intentId);
  return db.withWriteTransaction(async tx => (await tx.runAsync(
    'DELETE FROM chat_read_intents WHERE account_id = ? AND intent_id = ?', [accountId, intentId])).changes > 0);
}

export async function saveImageCacheEntry(db: Storage, entry: ChatImageCacheEntry): Promise<void> {
  requireNonEmpty('accountId', entry.accountId);
  requireNonEmpty('remotePath', entry.remotePath);
  validateReference(entry.accountId, entry.image);
  await db.withWriteTransaction(async tx => {
    await tx.runAsync(`INSERT INTO chat_image_cache (account_id, remote_path, image_id, relative_path, bytes, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, remote_path) DO UPDATE SET image_id = excluded.image_id,
      relative_path = excluded.relative_path, bytes = excluded.bytes, last_accessed_at = excluded.last_accessed_at`,
    [entry.accountId, entry.remotePath, entry.image.imageId, entry.image.relativePath, entry.image.bytes, entry.lastAccessedAt]);
  });
}

/** Oldest viewing copies first. Does not evict or delete any file itself. */
export async function listImageCacheEntries(db: Storage, accountId: string): Promise<ChatImageCacheEntry[]> {
  requireNonEmpty('accountId', accountId);
  const rows = await db.getAllAsync<AttachmentRow & { remote_path: string; last_accessed_at: number }>(
    'SELECT * FROM chat_image_cache WHERE account_id = ? ORDER BY last_accessed_at, remote_path', [accountId]);
  return rows.map(row => ({ accountId, remotePath: row.remote_path, image: imageFromRow(accountId, row), lastAccessedAt: row.last_accessed_at }));
}
