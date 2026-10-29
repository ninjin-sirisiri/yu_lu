import type { ChatAnchor, ChatClient, ChatMessagesResult, ChatPeer } from '../backend/chat';
import { randomId, type Storage } from '../storage/database';
import { readCache, writeCache } from '../storage/cache';
import { listLocalMessages, storeAcceptedMessage, saveChatDraft, saveAttachmentReferences } from '../storage/chat';
import { getOperation, listOperations, updateOperation, type OutboxRecord } from '../storage/outbox';
import { readDeviceSetting } from '../storage/settings';
import { isChatTerminalState } from '../sync/types';
import type { ImageReference } from '../storage/files';
import { sendMessage } from './send';
import { createSyncQueue } from '../sync/queue';
import { validateChatBody } from './text';
import type { AcceptedMessage, MessageReceipt } from './types';
import type { ReadStateRepository } from './readState';

/** One instance per authenticated provider lifetime. stop() is irreversible;
 * call it before logout/account switching, before the existing purge lifecycle.
 * All repositories for that actor share this revision/invalidation fence. */
export function createRepositorySession(deps: {
  storage: Storage; accountId: string; getAccountId(): Promise<string | null>;
}) {
  let stopped = false;
  let revision = 0;
  let generation = 0;
  class Revoked extends Error {}
  async function active(db = deps.storage) {
    if (stopped || await deps.getAccountId() !== deps.accountId) return false;
    const pending = await readDeviceSetting(db, 'logout.pending');
    return (pending === null || pending === '') && await deps.getAccountId() === deps.accountId && !stopped;
  }
  return {
    storage: deps.storage, accountId: deps.accountId, active,
    stop() { stopped = true; generation++; },
    invalidate() { generation++; },
    token: () => generation,
    observeRevision(value: number) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid chat revision.');
      revision = Math.max(revision, value);
    },
    async commit<T>(token: number, value: number | null, write: (tx: Storage) => Promise<T>, valid = () => true): Promise<T | null> {
      const result = await deps.storage.withWriteTransaction(async tx => {
        if (!await active(tx) || token !== generation || !valid()) return null;
        const old = await readCache<number>(tx, deps.accountId, 'chat.revision');
        if (value !== null && value < Math.max(revision, old?.payload ?? 0)) return null;
        const result = await write(tx);
        // Logout can begin while storage awaits. Throw to roll back every write,
        // rather than returning false after partially recreating account rows.
        if (!await active(tx) || token !== generation || !valid() || (value !== null && value < revision)) throw new Revoked();
        if (value !== null) {
          await writeCache(tx, deps.accountId, 'chat.revision', value, 0);
        }
        if (!await active(tx) || token !== generation || !valid() || (value !== null && value < revision)) throw new Revoked();
        return result;
      }).catch(error => { if (error instanceof Revoked) return null; throw error; });
      if (result !== null && value !== null) revision = Math.max(revision, value);
      return result;
    },
  };
}
export type RepositorySession = ReturnType<typeof createRepositorySession>;

/** Must run in the same transaction as publishing new relationship metadata.
 * Positive unsent work needs confirmation. Possibly dispatched work retains its
 * reach evidence in a nonclaimable FIFO blocker; never invent non-delivery. */
export async function stopObsoleteSends(db: Storage, accountId: string, peer: ChatPeer): Promise<void> {
  await writeCache(db, accountId, `chat.relationship.${peer.peer_id}`, {
    peer_id: peer.peer_id, conversation_id: peer.conversation_id, peer: peer.peer,
    can_send: peer.can_send, friendship_epoch: peer.friendship_epoch,
  } satisfies ChatPeer, 0);
  for (const row of await listOperations(db, accountId, { orderingKey: peer.peer_id })) {
    if (row.kind !== 'send_message' || isChatTerminalState(row.state)) continue;
    // Already nonclaimable with positive rejection evidence: preserve Task 12's
    // safe explicit local exclusion rather than relabeling this result unknown.
    if (row.state === 'failed_permanent' && row.reachStage === 'rejected') continue;
    const payload = row.payload as { friendship_epoch?: string };
    if (peer.can_send && payload.friendship_epoch === peer.friendship_epoch) continue;
    const unsent = row.reachStage === 'not_started' || row.reachStage === 'preparing';
    await updateOperation(db, accountId, row.operationId, {
      state: unsent ? 'needs_confirmation' : 'relationship_stopped', nextAttemptAt: null,
      claimedAt: null, claimGeneration: row.claimGeneration + 1,
      ...(unsent ? { reachStage: 'not_started' as const } : {}),
    }, { expectState: row.state, expectClaimGeneration: row.claimGeneration });
  }
}

function accepted(accountId: string, peerId: string, m: ChatMessagesResult['items'][number]): AcceptedMessage {
  return { accountId, peerId, messageId: m.message_id, conversationId: m.conversation_id,
    sequence: m.sequence, senderId: m.sender_id, recipientId: m.recipient_id, clientKey: m.client_key,
    acceptedAt: m.accepted_at, withdrawn: m.withdrawn, body: m.withdrawn ? null : m.body, imagePaths: m.withdrawn ? [] : m.image_paths };
}

export interface ConversationSnapshot {
  messages: AcceptedMessage[]; pending: OutboxRecord[]; cancelled: OutboxRecord[];
  metadata: ChatMessagesResult | null; canSend: boolean;
}

export function createConversationRepository(deps: {
  session: RepositorySession; peerId: string; client: ChatClient; reads: ReadStateRepository; now?: () => number;
}) {
  const { session, peerId, client, reads } = deps;
  const now = deps.now ?? Date.now;
  const cacheKey = `chat.peer.${peerId}`;
  let generation = 0;
  let disposed = false;
  let live = false;
  let liveEpoch: string | null = null;
  let loadedOnce = false;
  let latestPending = 0;
  const valid = (g: number) => !disposed && g === generation;
  const queue = (tx: Storage) => createSyncQueue({ store: tx, clock: { now }, random: Math.random });
  async function localAction<T>(id: string, action: (tx: Storage, row: OutboxRecord) => Promise<T>): Promise<T> {
    const g = generation;
    const result = await session.commit(session.token(), null, async tx => {
      const row = await getOperation(tx, session.accountId, id);
      if (!row || row.kind !== 'send_message' || row.orderingKey !== peerId) throw new Error('Unknown local message.');
      const result = await action(tx, row);
      await writeCache(tx, session.accountId, `chat.localActivity.${peerId}`, now(), now());
      return result;
    }, () => valid(g));
    if (result === null) throw new Error('Chat repository was revoked.');
    return result;
  }

  async function load(anchor: ChatAnchor): Promise<boolean> {
    if (disposed) return false;
    // Recovery is not a user navigation. Do not let a read acknowledgement or
    // Realtime refresh revoke the destination of an explicit latest jump.
    if (anchor === 'first_unread' && latestPending > 0) return false;
    if (anchor === 'first_unread' || anchor === 'latest') { generation++; live = false; }
    const g = generation;
    const token = session.token();
    if (!await session.active()) return false;
    const old = await readCache<ChatMessagesResult>(session.storage, session.accountId, cacheKey);
    const cursor = anchor === 'before' ? old?.payload.before_cursor : anchor === 'after' ? old?.payload.after_cursor : null;
    if ((anchor === 'before' || anchor === 'after') && !cursor) return false;
    const result = await client.getMessages(peerId, anchor, cursor);
    if (!valid(g) || result.peer_id !== peerId) return false;
    const applied = await session.commit(token, result.revision, async tx => {
      const cached = await readCache<ChatMessagesResult>(tx, session.accountId, cacheKey);
      const previousMessages = anchor === 'first_unread' && loadedOnce
        ? await listLocalMessages(tx, session.accountId, peerId) : [];
      for (const item of result.items) await storeAcceptedMessage(tx, accepted(session.accountId, peerId, item));
      // History can confirm a request whose HTTP response was lost. Match the
      // actor AND peer/client key, persist the actual server receipt, and revoke
      // any outstanding worker capability before releasing this FIFO position.
      for (const row of await listOperations(tx, session.accountId, { orderingKey: peerId })) {
        if (row.kind !== 'send_message' || isChatTerminalState(row.state)) continue;
        const key = (row.payload as { client_key?: string }).client_key;
        const item = result.items.find(m => m.sender_id === session.accountId && m.recipient_id === peerId && m.client_key === key);
        if (!item) continue;
        await updateOperation(tx, session.accountId, row.operationId, {
          state: 'succeeded', reachStage: 'accepted', nextAttemptAt: null, claimedAt: null,
          claimGeneration: row.claimGeneration + 1,
          result: { messageId: item.message_id, conversationId: item.conversation_id,
            sequence: item.sequence, acceptedAt: item.accepted_at } satisfies MessageReceipt,
        }, { expectState: row.state, expectClaimGeneration: row.claimGeneration });
      }
      await stopObsoleteSends(tx, session.accountId, result);
      const metadata = { ...result, items: [],
        before_cursor: anchor === 'after' ? cached?.payload.before_cursor ?? null : result.before_cursor,
        after_cursor: anchor === 'before' ? cached?.payload.after_cursor ?? null : result.after_cursor };
      // Realtime recovery refetches first_unread, not the user's viewport.
      // Preserve the cursor at a previously extended edge unless this response
      // actually extends that edge. An explicit latest jump still resets both.
      if (cached && previousMessages.length && anchor === 'first_unread') {
        const first = result.items[0]?.sequence ?? Infinity;
        const last = result.items.at(-1)?.sequence ?? -Infinity;
        if (first >= previousMessages[0].sequence) metadata.before_cursor = cached.payload.before_cursor;
        if (last <= previousMessages.at(-1)!.sequence) metadata.after_cursor = cached.payload.after_cursor;
      }
      await writeCache(tx, session.accountId, cacheKey, metadata, now());
      if (anchor === 'latest' && result.conversation_id && result.latest_sequence > 0) {
        await reads.record(peerId, result.conversation_id, [], result.latest_sequence, tx);
      }
      return true;
    }, () => valid(g));
    if (applied && valid(g)) { live = true; loadedOnce = true; liveEpoch = result.friendship_epoch; }
    return applied === true;
  }

  return {
    loadInitial: () => load('first_unread'), loadBefore: () => load('before'),
    loadAfter: () => load('after'), async jumpLatest() {
      latestPending++;
      try { return await load('latest'); }
      finally { latestPending--; }
    },
    dispose() { disposed = true; live = false; generation++; },
    async snapshot(): Promise<ConversationSnapshot> {
      if (disposed || !await session.active()) return { messages: [], pending: [], cancelled: [], metadata: null, canSend: false };
      const metadata = (await readCache<ChatMessagesResult>(session.storage, session.accountId, cacheKey))?.payload ?? null;
      const relationship = (await readCache<ChatPeer>(session.storage, session.accountId, `chat.relationship.${peerId}`))?.payload;
      const messages = await listLocalMessages(session.storage, session.accountId, peerId);
      const allRows = await listOperations(session.storage, session.accountId, { orderingKey: peerId });
      const rows = allRows
        .filter(row => row.kind === 'send_message' && row.state !== 'cancelled' && row.state !== 'superseded');
      // A durable receipt can precede the next history fetch. It is confirmed,
      // not a speculative timestamp; server sequence still orders it.
      for (const row of rows) {
        const r = row.result as MessageReceipt | null;
        const p = row.payload as { client_key: string; body: string; chat_prepared?: { media?: { final_path: string }[] } };
        if (row.state === 'succeeded' && r && !messages.some(m => m.messageId === r.messageId ||
            (m.senderId === session.accountId && m.clientKey === p.client_key))) {
          messages.push({ ...r, accountId: session.accountId, peerId, senderId: session.accountId, recipientId: peerId,
            clientKey: p.client_key, withdrawn: false, body: p.body, imagePaths: p.chat_prepared?.media?.map(m => m.final_path) ?? [] });
        }
      }
      messages.sort((a, b) => a.sequence - b.sequence);
      const pending = rows.filter(row => !messages.some(m => m.senderId === session.accountId &&
        m.clientKey === (row.payload as { client_key?: string }).client_key));
      if (!await session.active() || disposed) return { messages: [], pending: [], cancelled: [], metadata: null, canSend: false };
      return { messages, pending, cancelled: allRows.filter(row => row.kind === 'send_message' && row.state === 'cancelled'),
        metadata, canSend: live && relationship?.can_send === true && relationship.friendship_epoch === liveEpoch };
    },
    async enqueueMessage(input: { body: string; attachments: ImageReference[]; clientKey?: string; clearDraft?: boolean }): Promise<string> {
      const g = generation;
      if (!live || disposed) throw new Error('Currently unable to send to this person.');
      const result = await session.commit(session.token(), null, async tx => {
        const metadata = (await readCache<ChatMessagesResult>(tx, session.accountId, cacheKey))?.payload;
        const relationship = (await readCache<ChatPeer>(tx, session.accountId, `chat.relationship.${peerId}`))?.payload;
        if (!metadata?.can_send || !metadata.friendship_epoch || !relationship?.can_send ||
            relationship.friendship_epoch !== liveEpoch) throw new Error('Currently unable to send to this person.');
        const id = await sendMessage({ accountId: session.accountId, recipientId: peerId,
          friendshipEpoch: metadata.friendship_epoch, body: input.body, attachments: input.attachments,
          clientKey: input.clientKey ?? randomId() }, { storage: tx, now });
        if (input.clearDraft) await saveChatDraft(tx, { accountId: session.accountId, peerId, body: '', attachments: [], updatedAt: now() });
        return id;
      }, () => valid(g) && live);
      if (!result) throw new Error('Chat repository was revoked.');
      return result;
    },
    cancelUnsent: (id: string) => localAction(id, tx => queue(tx).cancelUnsent(session.accountId, id)),
    saveCancelled: (id: string, draft: { body: string; attachments: ImageReference[] }) => localAction(id, async (tx, row) => {
      if (row.state !== 'cancelled') throw new Error('Only cancelled local messages can be edited.');
      const checked = validateChatBody(draft.body, draft.attachments.length);
      if (!checked.ok) throw new Error(checked.error);
      await saveAttachmentReferences(tx, session.accountId, 'outbox', id, draft.attachments);
      return updateOperation(tx, session.accountId, id, { payload: { ...(row.payload as Record<string, unknown>),
        body: checked.value, images_staged: draft.attachments, chat_prepared: undefined, chat_preparation_id: undefined } }, { expectState: 'cancelled' });
    }),
    discardCancelled: (id: string) => localAction(id, async (tx, row) => {
      if (row.state !== 'cancelled') throw new Error('Only cancelled local messages can be discarded.');
      await saveAttachmentReferences(tx, session.accountId, 'outbox', id, []);
      return updateOperation(tx, session.accountId, id, { state: 'superseded', payload: {} }, { expectState: 'cancelled' });
    }),
    retryConfirmed: (id: string) => localAction(id, async (tx, row) => {
      const relationship = (await readCache<ChatPeer>(tx, session.accountId, `chat.relationship.${peerId}`))?.payload;
      if (!live || !relationship?.can_send || relationship.friendship_epoch !== liveEpoch) throw new Error('Currently unable to send to this person.');
      const payload = row.payload as Record<string, unknown>;
      const checked = validateChatBody(payload.body as string, Array.isArray(payload.images_staged) ? payload.images_staged.length : 0);
      if (!checked.ok) throw new Error(checked.error);
      // Explicit confirmation creates a NEW send under this displayed epoch;
      // stopped/unknown work is never revived by a relationship refresh.
      return queue(tx).retryAsNew({ accountId: session.accountId, operationId: id,
        payload: { ...payload, friendship_epoch: liveEpoch, body: checked.value } });
    }),
    async recordVisible(ids: readonly string[]): Promise<void> {
      const g = generation;
      await session.commit(session.token(), null, async tx => {
        const metadata = (await readCache<ChatMessagesResult>(tx, session.accountId, cacheKey))?.payload;
        if (!metadata?.conversation_id) return false;
        const visible = new Set(ids);
        const incoming = (await listLocalMessages(tx, session.accountId, peerId))
          .filter(m => m.recipientId === session.accountId && visible.has(m.messageId)).map(m => m.messageId);
        if (incoming.length) await reads.record(peerId, metadata.conversation_id, incoming, null, tx);
        return true;
      }, () => valid(g));
    },
  };
}
