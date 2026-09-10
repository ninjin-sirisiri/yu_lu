import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { MAX_IMAGES } from '../media/images';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;

function defaultClient(): SupabaseClient {
  return createClient(url, anon);
}

export interface SendMessageInput {
  recipientId: string;
  body: string;
  localImageUris: string[];
  clientKey: string;
}

export interface EditMessageInput {
  messageId: string;
  version: number;
  body: string;
  imagePaths: string[];
}

/** Row shape for the `messages` insert. No timestamp field: the server
 *  `accepted_at` default is the recorded truth for send time. */
export interface MessageInsert {
  recipient_id: string;
  body: string;
  image_paths: string[];
  client_key: string;
}

/** Row shape for the `message_edits` insert. No `edited_at` override and no
 *  `accepted_at`: editing keeps history without changing send time or order. */
export interface MessageEditInsert {
  message_id: string;
  version: number;
  body: string;
  image_paths: string[];
}

export function assertSendable(body: string, localImageUris: string[]): void {
  if (body.trim() === '' && localImageUris.length === 0) {
    throw new Error('Blank-only body with no image cannot be sent');
  }
}

export function buildMessageInsert(input: SendMessageInput): MessageInsert {
  return {
    recipient_id: input.recipientId,
    body: input.body,
    image_paths: input.localImageUris.slice(0, MAX_IMAGES),
    client_key: input.clientKey,
  };
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

export async function sendMessage(
  input: SendMessageInput,
  client: SupabaseClient = defaultClient(),
): Promise<string> {
  assertSendable(input.body, input.localImageUris);
  const row = buildMessageInsert(input);
  const result = await client.from('messages').insert(row).select('message_id').single();
  if (result.error) throw new Error(result.error.message);
  return result.data.message_id as string;
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
