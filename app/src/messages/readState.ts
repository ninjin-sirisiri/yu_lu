import type { ChatMessage, ChatUnread } from '../backend/chat';
import type { Storage } from '../storage/database';
import { randomId } from '../storage/database';
import { listLocalMessages, listReadIntents, removeReadIntent, saveReadIntent } from '../storage/chat';
import { readCache, writeCache } from '../storage/cache';
import type { CommandApi } from '../sync/api';
import type { RepositorySession } from './repository';

export interface ReadState { throughSequence: number; messageIds: string[] }
const empty = (): ReadState => ({ throughSequence: 0, messageIds: [] });
export function mergeReadState(a: ReadState, b: ReadState): ReadState {
  return { throughSequence: Math.max(a.throughSequence, b.throughSequence),
    messageIds: [...new Set([...a.messageIds, ...b.messageIds])].sort() };
}

/** The four query DTOs do not expose individual server sparse membership.
 * Only subtract proven unread IDs (the first hole, or a complete candidate set
 * whose size equals the server count). Otherwise keep an explicit upper bound,
 * never manufacture a zero/badge disappearance for an already-read sparse ID.
 * A latest jump at/above this snapshot's max clears exactly that snapshot. */
export function optimisticUnread(
  baseline: Pick<ChatUnread, 'unread_count' | 'first_unread_sequence' | 'latest_sequence'>,
  incoming: readonly Pick<ChatMessage, 'message_id' | 'sequence'>[], effect: ReadState,
): { count: number; exact: boolean } {
  if (!baseline.unread_count) return { count: 0, exact: true };
  if (effect.throughSequence >= baseline.latest_sequence) return { count: 0, exact: true };
  const first = baseline.first_unread_sequence;
  const candidates = [...new Map(incoming.filter(m => first !== null && m.sequence >= first &&
    m.sequence <= baseline.latest_sequence).map(m => [m.message_id, m])).values()];
  const ids = new Set(effect.messageIds);
  const affected = candidates.filter(m => m.sequence <= effect.throughSequence || ids.has(m.message_id));
  // Only a complete incoming sequence range plus matching server count proves
  // every candidate unread. A partial page or outgoing gap is not that proof.
  const complete = first !== null && candidates.length === baseline.latest_sequence - first + 1;
  if (complete && candidates.length === baseline.unread_count) {
    return { count: baseline.unread_count - affected.length, exact: true };
  }
  const firstRead = first !== null && (first <= effect.throughSequence || affected.some(m => m.sequence === first));
  const locallyKnown = new Set(incoming.map(m => m.message_id));
  const uncertain = effect.messageIds.some(id => !locallyKnown.has(id)) || affected.some(m => m.sequence !== first) ||
    (first !== null && effect.throughSequence >= first && effect.throughSequence < baseline.latest_sequence);
  return { count: Math.max(0, baseline.unread_count - Number(firstRead)), exact: !uncertain };
}

interface SavedRead { state: ReadState; version: number }
const stateKey = (peerId: string, conversationId: string) => `chat.read.${peerId}.${conversationId}`;

export function createReadStateRepository(deps: {
  session: RepositorySession; commandApi: CommandApi; now?: () => number; newId?: () => string;
}) {
  const { session } = deps;
  const now = deps.now ?? Date.now;
  let syncing: Promise<void> | null = null;
  async function version(db = session.storage): Promise<number> {
    return (await readCache<number>(db, session.accountId, 'chat.read-version'))?.payload ?? 0;
  }
  async function stateIn(db: Storage, peerId: string, conversationId: string, baselineVersion = -1): Promise<ReadState> {
    const ack = (await readCache<SavedRead>(db, session.accountId, stateKey(peerId, conversationId)))?.payload;
    let merged = ack && ack.version > baselineVersion ? ack.state : empty();
    for (const intent of await listReadIntents(db, session.accountId)) {
      if (intent.peerId === peerId && intent.conversationId === conversationId) {
        merged = mergeReadState(merged, { throughSequence: intent.throughSequence ?? 0, messageIds: intent.messageIds });
      }
    }
    return merged;
  }
  async function state(peerId: string, conversationId: string, baselineVersion = -1): Promise<ReadState> {
    if (!await session.active()) return empty();
    return stateIn(session.storage, peerId, conversationId, baselineVersion);
  }
  async function record(peerId: string, conversationId: string, ids: readonly string[], through: number | null, db?: Storage): Promise<void> {
    if (through !== null && (!Number.isSafeInteger(through) || through <= 0)) throw new Error('Invalid read intent bound.');
    async function persist(tx: Storage): Promise<boolean> {
      const existing = await stateIn(tx, peerId, conversationId);
      const knownIds = new Set(existing.messageIds);
      const messageIds = [...new Set(ids)].filter(id => !knownIds.has(id)).sort();
      const throughSequence = through !== null && through > existing.throughSequence ? through : null;
      if (!messageIds.length && throughSequence === null) return false;
      const inserted = await saveReadIntent(tx, { accountId: session.accountId, intentId: (deps.newId ?? randomId)(),
        peerId, conversationId, messageIds, throughSequence, createdAt: now() });
      if (!inserted) throw new Error('Read intent ID is already in use.');
      return true;
    }
    if (db) { await persist(db); return; }
    await session.commit(session.token(), null, persist);
  }
  async function runSync(): Promise<void> {
    if (!await session.active()) return;
    const intents = await listReadIntents(session.storage, session.accountId);
    // Not outbox.enqueue: message FIFO, send expiry and a failed conversation
    // must not prevent another conversation's durable read union from syncing.
    for (const intent of intents) {
      if (!await session.active()) return;
      const token = session.token();
      try {
        const outcome = await deps.commandApi.send({ accountId: session.accountId, operationId: intent.intentId,
          kind: 'mark_chat_read', payload: { conversation_id: intent.conversationId,
            message_ids: intent.messageIds, through_sequence: intent.throughSequence },
          beforeRequest: async () => {
            if (!await session.active() || !(await listReadIntents(session.storage, session.accountId))
              .some(i => i.intentId === intent.intentId)) throw new Error('Read intent was revoked.');
          } });
        if (outcome.status !== 'ok') continue;
        const result = outcome.data?.result as { conversation_id?: string; message_ids?: unknown; through_sequence?: unknown } | undefined;
        if (result?.conversation_id !== intent.conversationId || !Array.isArray(result.message_ids) ||
            !result.message_ids.every(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) ||
            !Number.isSafeInteger(result.through_sequence) ||
            (result.through_sequence as number) < (intent.throughSequence ?? 0)) continue;
        const known = await listLocalMessages(session.storage, session.accountId, intent.peerId);
        if (!intent.messageIds.every(id => (result.message_ids as string[]).includes(id) ||
          known.some(m => m.messageId === id && m.conversationId === intent.conversationId &&
            m.sequence <= (result.through_sequence as number)))) continue;
        const applied = await session.commit(token, null, async tx => {
          const old = (await readCache<SavedRead>(tx, session.accountId, stateKey(intent.peerId, intent.conversationId)))?.payload;
          const v = await version(tx) + 1;
          const merged = mergeReadState(old?.state ?? empty(), { throughSequence: result.through_sequence as number,
            messageIds: result.message_ids as string[] });
          await writeCache(tx, session.accountId, stateKey(intent.peerId, intent.conversationId), { state: merged, version: v }, now());
          await writeCache(tx, session.accountId, 'chat.read-version', v, now());
          await removeReadIntent(tx, session.accountId, intent.intentId);
          return true;
        });
        if (applied) session.invalidate(); // Reject queries started before acknowledgement.
      } catch {
        // Preserve the same immutable ID/payload on transport/storage failures.
        // Do not let one peer starve other read intents or discard old intents.
      }
    }
  }
  return { record, state, version,
    sync(): Promise<void> {
      if (!syncing) syncing = runSync().finally(() => { syncing = null; });
      return syncing;
    },
  };
}
export type ReadStateRepository = ReturnType<typeof createReadStateRepository>;
