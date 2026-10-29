import type { SupabaseClient } from '@supabase/supabase-js';
import { getAppClient } from '../backend/client';
import type { Storage } from '../storage/database';
import type { ImageReference } from '../storage/files';
import { saveAttachmentReferences } from '../storage/chat';
import { createSyncQueue } from '../sync/queue';
import { validateChatBody } from './text';

function defaultClient(): SupabaseClient {
  return getAppClient();
}

export interface SendMessageInput {
  accountId: string;
  recipientId: string;
  /** Captured when the user confirmed this send. Never refreshed by a worker. */
  friendshipEpoch: string;
  body: string;
  attachments: ImageReference[];
  clientKey: string;
}

export interface EditMessageInput {
  messageId: string;
  version: number;
  body: string;
  imagePaths: string[];
}

/** Row shape for the `message_edits` insert. No `edited_at` override and no
 *  `accepted_at`: editing keeps history without changing send time or order. */
export interface MessageEditInsert {
  message_id: string;
  version: number;
  body: string;
  image_paths: string[];
}

export function buildEditInsert(input: EditMessageInput): MessageEditInsert {
  return {
    message_id: input.messageId,
    version: input.version,
    body: input.body,
    image_paths: input.imagePaths,
  };
}

/** Withdrawal hides content without deleting the row and never touches
 *  `accepted_at`, so achievement and receipt facts are unchanged. */
export function buildWithdrawUpdate(): { withdrawn: boolean } {
  return { withdrawn: true };
}

/** Reserve, never insert directly or return an invented server receipt. The
 * returned ID identifies durable queued work; the shared lifecycle sends it.
 * Attachment pins and enqueue commit together or neither is visible. */
export async function sendMessage(input: SendMessageInput, options: {
  storage: Storage;
  now?: () => number;
}): Promise<string> {
  const body = validateChatBody(input.body, input.attachments.length);
  if (!body.ok) throw new Error(body.error);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (![input.accountId, input.recipientId, input.friendshipEpoch, input.clientKey].every(v => uuid.test(v)) ||
      input.accountId === input.recipientId) throw new Error('Invalid message identity.');
  return options.storage.withWriteTransaction(async tx => {
    const queue = createSyncQueue({ store: tx, clock: { now: options.now ?? Date.now }, random: Math.random });
    const { operation } = await queue.enqueue({ accountId: input.accountId, kind: 'send_message', payload: {
      recipient_id: input.recipientId, client_key: input.clientKey, friendship_epoch: input.friendshipEpoch,
      body: body.value, images_staged: input.attachments,
    } });
    await saveAttachmentReferences(tx, input.accountId, 'outbox', operation.operationId, input.attachments);
    return operation.operationId;
  });
}

export async function editMessage(
  input: EditMessageInput,
  client: SupabaseClient = defaultClient(),
): Promise<void> {
  const row = buildEditInsert(input);
  const result = await client.from('message_edits').insert(row);
  if (result.error) throw new Error(result.error.message);
}

export async function withdrawMessage(
  messageId: string,
  client: SupabaseClient = defaultClient(),
): Promise<void> {
  const result = await client.from('messages').update(buildWithdrawUpdate()).eq('message_id', messageId);
  if (result.error) throw new Error(result.error.message);
}
