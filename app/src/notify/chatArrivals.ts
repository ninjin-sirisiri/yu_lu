import type { ChatClient, ChatUnreadResult } from '../backend/chat';
import { readCache, writeCache } from '../storage/cache';
import type { Storage } from '../storage/database';
import type { RepositorySession } from '../messages/repository';

export interface ChatArrival { id: string; peerId: string; name: string }
interface Known { serverNow: string; positions: Record<string, number> }
const KEY = 'chat.arrival.known';

/** Revisions only invalidate reads. Compare actual accepted incoming rows with
 * durable conversation high-water marks, never unread deltas or revision gaps.
 * No message content is copied into the notice or its durable baseline. */
export async function prepareChatArrivals(session: RepositorySession, client: ChatClient,
  unread: ChatUnreadResult, serverNow: string, announce: boolean) {
  const previous = (await readCache<Known>(session.storage, session.accountId, KEY))?.payload;
  const positions = { ...previous?.positions };
  const arrivals: ChatArrival[] = [];
  for (const row of unread.items) {
    const old = previous?.positions[row.conversation_id] ?? 0;
    positions[row.conversation_id] = Math.max(old, row.latest_sequence);
    if (!announce || !previous || row.latest_sequence <= old || !await session.active()) continue;
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const result = await client.getMessages(row.peer_id, cursor ? 'before' : 'latest', cursor);
      if (result.revision !== unread.revision || result.peer_id !== row.peer_id || result.conversation_id !== row.conversation_id) {
        throw new Error('Arrival snapshot changed.');
      }
      const incoming = result.items.find(m => m.conversation_id === row.conversation_id && m.sender_id === row.peer_id &&
        m.recipient_id === session.accountId && !m.withdrawn && m.sequence > old && m.sequence <= row.latest_sequence &&
        // An unseen conversation can be historical (relationship/paging change).
        (previous.positions[row.conversation_id] !== undefined || Date.parse(m.accepted_at) > Date.parse(previous.serverNow)));
      if (incoming) {
        arrivals.push({ id: incoming.message_id, peerId: row.peer_id, name: result.peer.display_name }); break;
      }
      if (!result.items.length || result.items.some(m => m.sequence <= old)) break;
      cursor = result.before_cursor;
      if (cursor && cursors.has(cursor)) throw new Error('Arrival cursor did not advance.');
      if (cursor) cursors.add(cursor);
    } while (cursor && await session.active());
  }
  return { arrivals, async commit(tx: Storage) {
    // Serialized with the home snapshot and protected by session.commit's
    // rollback fence; logout can never resurrect this account's known state.
    const current = (await readCache<Known>(tx, session.accountId, KEY))?.payload;
    for (const [id, sequence] of Object.entries(current?.positions ?? {})) positions[id] = Math.max(sequence, positions[id] ?? 0);
    await writeCache(tx, session.accountId, KEY, { serverNow, positions } satisfies Known, 0);
  } };
}
