import type { ChatMessage, ChatPeer, ChatSummary } from '../backend/chat';
import { readCache } from '../storage/cache';
import { listChatDrafts, listLocalMessagePeers, listLocalMessages } from '../storage/chat';
import { listOperations } from '../storage/outbox';
import type { RepositorySession } from './repository';
import type { MessageReceipt } from './types';

export interface ChatListRow extends ChatSummary {
  local?: { draft: boolean; states: string[]; updatedAt: number; only: boolean };
}
const stateOrder = { reply_needed: 0, send_needed: 1, waiting: 2, achieved: 3 };
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function time(row: ChatListRow): [number, string] {
  const stamp = row.last_message?.accepted_at;
  // Date.parse alone loses the server's sub-millisecond order. ISO fractions
  // are compared after the millisecond epoch (offsets are handled by Date).
  return stamp ? [Date.parse(stamp), (stamp.match(/\.(\d+)/)?.[1] ?? '').padEnd(9, '0').slice(3, 9)]
    : [row.local?.updatedAt ?? -Infinity, '000000'];
}
export function compareChatRows(a: ChatListRow, b: ChatListRow): number {
  const [at, af] = time(a), [bt, bf] = time(b);
  return (at === bt ? 0 : at > bt ? -1 : 1) || compareId(bf, af) ||
    (a.last_message && b.last_message ? compareId(b.last_message.message_id, a.last_message.message_id) : 0) ||
    compareId(a.peer_id, b.peer_id);
}
export function compareTargets(a: ChatListRow, b: ChatListRow): number {
  const order = (a.status ? stateOrder[a.status] : 4) - (b.status ? stateOrder[b.status] : 4);
  // The server already ordered empty targets by registered User ID (not
  // exposed in this DTO). Stable sort retains that authoritative order, never
  // substituting internal UUID/display-name/local draft activity for User ID.
  if (!a.last_message && !b.last_message) return order;
  if (!a.last_message || !b.last_message) return order || (a.last_message ? -1 : 1);
  return order || compareChatRows(a, b);
}

/** Read-only projection over the SAME account stores. Metadata/cache hydration
 * alone is never a membership signal and no profile is fetched for old peers. */
export async function localChatRows(session: RepositorySession, server: ChatSummary[], counts: ReadonlyMap<string, number>): Promise<ChatListRow[]> {
  const rows = new Map<string, ChatListRow>(server.map(row => [row.peer_id, { ...row }]));
  const drafts = await listChatDrafts(session.storage, session.accountId);
  const outbox = (await listOperations(session.storage, session.accountId)).filter(row => row.kind === 'send_message' &&
    row.orderingKey && row.state !== 'superseded');
  const peers = new Set([...drafts.map(d => d.peerId), ...outbox.map(r => r.orderingKey!),
    ...await listLocalMessagePeers(session.storage, session.accountId)]);
  for (const peerId of peers) {
    if (peerId === session.accountId) continue;
    const draft = drafts.find(d => d.peerId === peerId);
    const peerRows = outbox.filter(r => r.orderingKey === peerId);
    const pending = peerRows.filter(r => r.state !== 'succeeded');
    const relationship = (await readCache<ChatPeer>(session.storage, session.accountId, `chat.relationship.${peerId}`))?.payload;
    let row = rows.get(peerId);
    const last = (await listLocalMessages(session.storage, session.accountId, peerId)).at(-1);
    let lastMessage: ChatMessage | null = last ? { message_id: last.messageId, conversation_id: last.conversationId, sequence: last.sequence,
      sender_id: last.senderId, recipient_id: last.recipientId, client_key: last.clientKey, accepted_at: last.acceptedAt,
      withdrawn: last.withdrawn, body: last.body, image_paths: last.imagePaths } : null;
    for (const accepted of peerRows.filter(r => r.state === 'succeeded' && r.result)) {
      const receipt = accepted.result as MessageReceipt;
      const payload = accepted.payload as { client_key: string; body: string; chat_prepared?: { media?: { final_path: string }[] } };
      if (!lastMessage || receipt.sequence > lastMessage.sequence) lastMessage = {
        message_id: receipt.messageId, conversation_id: receipt.conversationId, sequence: receipt.sequence,
        accepted_at: receipt.acceptedAt, sender_id: session.accountId, recipient_id: peerId, client_key: payload.client_key,
        withdrawn: false, body: payload.body, image_paths: payload.chat_prepared?.media?.map(m => m.final_path) ?? [] };
    }
    if (!row) {
      if (!draft && !pending.length && !lastMessage) continue;
      row = { peer_id: peerId, peer: relationship?.peer ?? { display_name: '相手', avatar_path: null },
        conversation_id: lastMessage?.conversation_id ?? relationship?.conversation_id ?? null,
        // Display metadata only. ConversationRepository still requires a live
        // confirmed relationship before enqueue; cached rows grant no capability.
        can_send: relationship?.can_send ?? false, friendship_epoch: relationship?.friendship_epoch ?? null,
        appearance: relationship?.appearance,
        unread_count: counts.get(peerId) ?? 0, latest_sequence: lastMessage?.sequence ?? 0, last_message: lastMessage,
        roles: { send: false, reply: false }, send_completed: null, reply_state: null, status: null };
    } else if (lastMessage && (!row.last_message || lastMessage.sequence > row.last_message.sequence ||
        (lastMessage.message_id === row.last_message.message_id && lastMessage.withdrawn))) {
      // Confirmed facts can precede a list refresh. Never let local editor time
      // replace server order, nor an older receipt unredact a withdrawn row.
      row = { ...row, conversation_id: lastMessage.conversation_id,
        latest_sequence: Math.max(row.latest_sequence, lastMessage.sequence), last_message: lastMessage };
    }
    if (draft || pending.length) {
      const changed = (await readCache<number>(session.storage, session.accountId, `chat.localActivity.${peerId}`))?.payload ?? 0;
      row = { ...row, local: { draft: !!draft, states: [...new Set(pending.map(r => r.state))],
        updatedAt: Math.max(draft?.updatedAt ?? 0, changed, ...pending.map(r => r.createdAt)), only: !row.last_message } };
    }
    rows.set(peerId, row);
  }
  return [...rows.values()];
}
