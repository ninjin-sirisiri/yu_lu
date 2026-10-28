import type { ChatClient, ChatListResult, ChatSummary, ChatUnreadResult, HomeResult } from '../backend/chat';
import { readCache, writeCache } from '../storage/cache';
import { listLocalMessages } from '../storage/chat';
import { optimisticUnread, type ReadStateRepository } from '../messages/readState';
import { stopObsoleteSends, type RepositorySession } from '../messages/repository';
import { compareChatRows, compareTargets, localChatRows, type ChatListRow } from '../messages/chatListRows';

interface SavedHome {
  home: HomeResult; list: ChatListResult; unread: ChatUnreadResult; readVersion: number;
}
export interface HomeSnapshot {
  home: HomeResult | null; targets: ChatListRow[]; others: ChatListRow[];
  unreadPeerCount: number; unreadCountsExact: boolean;
  dayStatus: 'current' | 'stale' | 'unavailable'; nextCursor: string | null;
}

/** Account-scoped home/list/unread snapshot. Cached progress retains its actual
 * daily_key; only a live server_now + elapsed clock can label it current.
 * Inject a monotonic elapsed clock in the provider (not device calendar time).
 * Daily targets are never part of the 20-item other-chat page limit. */
export function createHomeRepository(deps: {
  session: RepositorySession; client: ChatClient; reads: ReadStateRepository; now?: () => number;
}) {
  const { session, client, reads } = deps;
  const now = deps.now ?? (() => performance.now());
  let generation = 0;
  let disposed = false;
  let clock: { server: number; local: number; day: string } | null = null;
  const valid = (g: number) => !disposed && generation === g;

  async function refreshHome(): Promise<boolean> {
    const g = ++generation;
    const token = session.token();
    if (disposed || !await session.active()) return false;
    const readVersion = await reads.version();
    const started = now();
    const [home, list, unread] = await Promise.all([client.getHome(), client.listChats(null), client.getUnread()]);
    if (!valid(g) || home.daily_key !== list.daily_key ||
        home.revision !== list.revision || home.revision !== unread.revision) return false;
    const result = await session.commit(token, home.revision, async tx => {
      const previous = (await readCache<SavedHome>(tx, session.accountId, 'chat.home'))?.payload;
      if (previous && home.daily_key < previous.home.daily_key) return false;
      await writeCache(tx, session.accountId, 'chat.home', { home, list, unread, readVersion } satisfies SavedHome, started);
      for (const peer of [...home.targets, ...list.targets, ...list.items]) await stopObsoleteSends(tx, session.accountId, peer);
      return true;
    }, () => valid(g));
    if (result && valid(g)) clock = { server: Date.parse(home.server_now), local: started, day: home.daily_key };
    return result === true;
  }

  async function loadMore(): Promise<boolean> {
    const g = generation;
    const token = session.token();
    if (disposed || !await session.active()) return false;
    const old = (await readCache<SavedHome>(session.storage, session.accountId, 'chat.home'))?.payload;
    if (!old) return refreshHome();
    const cursor = old.list.next_cursor;
    if (!cursor) return false;
    const page = await client.listChats(cursor);
    if (!valid(g) || page.daily_key !== old.home.daily_key || page.revision !== old.home.revision) return false;
    const result = await session.commit(token, page.revision, async tx => {
      const current = (await readCache<SavedHome>(tx, session.accountId, 'chat.home'))?.payload;
      if (!current || current.list.next_cursor !== cursor || current.home.daily_key !== page.daily_key) return false;
      const items = [...new Map([...(cursor ? current.list.items : []), ...page.items].map(row => [row.peer_id, row])).values()];
      await writeCache(tx, session.accountId, 'chat.home', { ...current, list: { ...page, items } }, now());
      for (const peer of [...page.targets, ...page.items]) await stopObsoleteSends(tx, session.accountId, peer);
      return true;
    }, () => valid(g));
    return result === true;
  }

  async function snapshot(): Promise<HomeSnapshot> {
    const unavailable: HomeSnapshot = { home: null, targets: [], others: [], unreadPeerCount: 0,
      unreadCountsExact: false, dayStatus: 'unavailable', nextCursor: null };
    if (disposed || !await session.active()) return unavailable;
    const cached = (await readCache<SavedHome>(session.storage, session.accountId, 'chat.home'))?.payload;
    if (!cached) {
      const others = (await localChatRows(session, [], new Map())).sort(compareChatRows);
      return await session.active() && !disposed ? { ...unavailable, others } : unavailable;
    }
    const counts = new Map<string, number>();
    let unreadCountsExact = true;
    for (const row of cached.unread.items) {
      const messages = (await listLocalMessages(session.storage, session.accountId, row.peer_id))
        .filter(m => m.recipientId === session.accountId && m.conversationId === row.conversation_id)
        .map(m => ({ message_id: m.messageId, sequence: m.sequence }));
      const effect = await reads.state(row.peer_id, row.conversation_id, cached.readVersion);
      const count = optimisticUnread(row, messages, effect);
      counts.set(row.peer_id, count.count);
      unreadCountsExact &&= count.exact;
    }
    const decorate = (row: ChatSummary): ChatSummary => ({ ...row, unread_count: counts.get(row.peer_id) ?? row.unread_count });
    const combined = await localChatRows(session, [...cached.home.targets, ...cached.list.items].map(decorate), counts);
    const byPeer = new Map(combined.map(row => [row.peer_id, row]));
    const targets = [...new Set(cached.home.targets.map(row => row.peer_id))].map(id => byPeer.get(id)!).sort(compareTargets);
    const targetIds = new Set(targets.map(row => row.peer_id));
    const others = combined.filter(row => !targetIds.has(row.peer_id)).sort(compareChatRows);
    const elapsed = clock ? now() - clock.local : -1;
    const current = clock && clock.day === cached.home.daily_key && elapsed >= 0 &&
      clock.server + elapsed < Date.parse(cached.home.deadline);
    if (disposed || !await session.active()) return unavailable;
    const unreadPeerCount = [...counts.values()].filter(count => count > 0).length;
    return { home: { ...cached.home, targets, unread_peer_count: unreadPeerCount }, targets, others,
      unreadPeerCount, unreadCountsExact, dayStatus: current ? 'current' : 'stale', nextCursor: cached.list.next_cursor };
  }
  return { refreshHome, loadMore, snapshot, dispose() { disposed = true; generation++; clock = null; } };
}
