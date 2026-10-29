import { useChat } from './provider';

/** Shared by both navigation presentations; this is people, not messages. */
export function useChatUnreadBadge() {
  const chat = useChat();
  const home = chat?.stopped ? null : chat?.home;
  if (!home?.home) return { badge: '…', label: 'チャット、未読を確認中' };
  const count = home.unreadPeerCount;
  const pending = chat?.pendingReadSync || !home.unreadCountsExact;
  const badge = !home.unreadCountsExact ? `${count}以下` : count > 0 ? count : undefined;
  const label = `チャット、未読の相手 ${count}人${home.unreadCountsExact ? '' : '以下'}${pending ? '（同期確認中）' : ''}`;
  return { badge, label };
}
