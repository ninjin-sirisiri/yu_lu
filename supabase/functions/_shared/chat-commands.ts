// Fail-fast only: SQL owns actor, epoch, validation-record and receipt authority.
import { UUID_RE } from './commands.ts';
import { validateChatBody } from './chat-text.ts';

export function validateChatCommandPayload(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  if (kind === 'mark_chat_read') {
    const keys = ['conversation_id', 'message_ids', 'through_sequence'];
    if (Object.keys(payload).length !== keys.length || keys.some((key) => !(key in payload)) ||
      typeof payload.conversation_id !== 'string' || !UUID_RE.test(payload.conversation_id)) {
      return 'Invalid mark_chat_read payload.';
    }
    if (!Array.isArray(payload.message_ids) ||
      payload.message_ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
      return 'Invalid read messages.';
    }
    const bound = payload.through_sequence;
    if (bound !== null && (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0)) {
      return 'Invalid read bound.';
    }
    // Preserve the exact operation payload, including duplicate IDs and the
    // fetched destination. SQL owns membership, set union and max-bound merge.
    return null;
  }
  if (kind !== 'send_message') return null;
  const keys = ['recipient_id', 'client_key', 'friendship_epoch', 'body', 'media_ids'];
  if (Object.keys(payload).length !== keys.length || keys.some((key) => !(key in payload))) {
    return 'Invalid send_message payload.';
  }
  for (const key of ['recipient_id', 'client_key', 'friendship_epoch']) {
    if (typeof payload[key] !== 'string' || !UUID_RE.test(payload[key])) return 'Invalid send_message payload.';
  }
  const ids = payload.media_ids;
  if (!Array.isArray(ids) || ids.length > 4 || ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id)) ||
    new Set(ids.map((id: string) => id.toLowerCase())).size !== ids.length) return 'Invalid chat media.';
  if (typeof payload.body !== 'string') return 'Invalid send_message payload.';
  const body = validateChatBody(payload.body, ids.length);
  // Do not rewrite the original body or epoch: retries must carry identical
  // contents. The DB stores normalized LF text separately from the receipt.
  return body.ok ? null : body.error;
}
