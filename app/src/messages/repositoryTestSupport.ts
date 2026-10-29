import type { ChatClient, ChatMessage, ChatMessagesResult, ChatSummary, HomeResult } from '../backend/chat';

export const A = '10000000-0000-4000-8000-000000000001';
export const B = '10000000-0000-4000-8000-000000000002';
export const C = '10000000-0000-4000-8000-000000000003';
export const E = '20000000-0000-4000-8000-000000000001';
export const E2 = '20000000-0000-4000-8000-000000000002';
export const CONV = '30000000-0000-4000-8000-000000000001';
export const key = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const message = (sequence: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  message_id: key(sequence + 100), conversation_id: CONV, sequence, sender_id: B, recipient_id: A,
  client_key: key(sequence), accepted_at: '2026-10-28T00:00:00.123456Z', withdrawn: false, body: `m${sequence}`, image_paths: [], ...extra,
});
export const page = (items = [message(2), message(3)], extra: Partial<ChatMessagesResult> = {}): ChatMessagesResult => ({
  peer_id: B, conversation_id: CONV, peer: { display_name: 'Bob', avatar_path: null }, can_send: true,
  friendship_epoch: E, revision: 1, items, before_cursor: 'before-2', after_cursor: 'after-3',
  first_unread_sequence: 2, latest_sequence: 3, ...extra,
});
export const summary = (extra: Partial<ChatSummary> = {}): ChatSummary => ({
  peer_id: B, conversation_id: CONV, peer: { display_name: 'Bob', avatar_path: null }, can_send: true,
  friendship_epoch: E, unread_count: 2, latest_sequence: 3, last_message: message(3), roles: { send: true, reply: false },
  send_completed: false, reply_state: null, status: 'send_needed', ...extra,
});
export const home = (extra: Partial<HomeResult> = {}): HomeResult => ({
  revision: 1, server_now: '2026-10-28T18:59:50Z', daily_key: '2026-10-28', deadline: '2026-10-28T19:00:00Z',
  draw_deadline: '2026-10-27T19:05:00Z', draw_state: 'succeeded', draw_finalized_at: '2026-10-27T19:00:01Z',
  participation: 'eligible', streak: 2, send_completed: false, reply_completed: 0, reply_total: 0,
  achieved: false, actionable_complete: false, targets: [summary()], unread_peer_count: 1, ...extra,
});
export const api = (): ChatClient => ({
  getHome: jest.fn(async () => home()),
  listChats: jest.fn(async () => ({ revision: 1, server_now: home().server_now, daily_key: home().daily_key,
    targets: [summary()], items: [], next_cursor: null, unread_peer_count: 1 })),
  getMessages: jest.fn(async () => page()),
  getUnread: jest.fn(async () => ({ revision: 1, unread_peer_count: 1, items: [{ peer_id: B, conversation_id: CONV,
    unread_count: 2, first_unread_sequence: 2, latest_sequence: 3 }] })),
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
