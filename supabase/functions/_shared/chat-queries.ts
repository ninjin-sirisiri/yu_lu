// Task 8 read DTOs. Only the authenticated actor's progress/read results occur here.
import { UUID_RE } from './commands.ts';

export const CHAT_QUERY_OPS = ['get_home', 'list_chats', 'get_chat_messages', 'get_chat_unread'] as const;
export type ChatQueryOp = (typeof CHAT_QUERY_OPS)[number];
export type ChatAnchor = 'first_unread' | 'latest' | 'before' | 'after';
export interface ChatPeer {
  peer_id: string;
  conversation_id: string | null;
  peer: { display_name: string; avatar_path: string | null };
  can_send: boolean;
  friendship_epoch: string | null;
}
export interface ChatMessage {
  message_id: string;
  conversation_id: string;
  sequence: number;
  sender_id: string;
  recipient_id: string;
  client_key: string;
  accepted_at: string;
  withdrawn: boolean;
  body: string | null;
  image_paths: string[];
}
export interface ChatUnread {
  peer_id: string;
  conversation_id: string;
  unread_count: number;
  first_unread_sequence: number | null;
  latest_sequence: number;
}
export interface ChatSummary extends ChatPeer {
  unread_count: number;
  latest_sequence: number;
  last_message: ChatMessage | null;
  roles: { send: boolean; reply: boolean };
  send_completed: boolean | null;
  reply_state: 'reply_needed' | 'waiting' | 'achieved' | null;
  status: 'reply_needed' | 'send_needed' | 'waiting' | 'achieved' | null;
}
/** Actor-only invalidation token captured with the response's database snapshot. */
export interface ChatRevision { revision: number }
export interface HomeResult extends ChatRevision {
  server_now: string;
  daily_key: string;
  deadline: string;
  draw_deadline: string;
  draw_state: 'not_started' | 'pending' | 'running' | 'succeeded' | 'failed';
  draw_finalized_at: string | null;
  participation: 'checking' | 'draw_failed' | 'no_friends' | 'waiting_next_cycle' | 'eligible';
  streak: number;
  send_completed: boolean | null;
  reply_completed: number;
  reply_total: number;
  achieved: boolean;
  actionable_complete: boolean;
  targets: ChatSummary[];
  unread_peer_count: number;
}
export interface ChatListResult extends ChatRevision {
  server_now: string;
  daily_key: string;
  targets: ChatSummary[];
  items: ChatSummary[];
  next_cursor: string | null;
  unread_peer_count: number;
}
export interface ChatMessagesResult extends ChatPeer, ChatRevision {
  items: ChatMessage[];
  before_cursor: string | null;
  after_cursor: string | null;
  first_unread_sequence: number | null;
  latest_sequence: number;
}
export interface ChatUnreadResult extends ChatRevision { items: ChatUnread[]; unread_peer_count: number }
export interface ChatQueryResults {
  get_home: HomeResult;
  list_chats: ChatListResult;
  get_chat_messages: ChatMessagesResult;
  get_chat_unread: ChatUnreadResult;
}

/** SQL remains the authority for cursor contents, actor and history membership. */
export function validateChatQueryPayload(op: ChatQueryOp, payload: Record<string, unknown>): string | null {
  const invalid = 'Invalid chat query payload.';
  const allowed = op === 'get_chat_messages' ? ['peer_id', 'anchor', 'cursor'] : op === 'list_chats' ? ['cursor'] : [];
  if (Object.keys(payload).some((key) => !allowed.includes(key))) return invalid;
  const cursor = payload.cursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') return invalid;
  if (op !== 'get_chat_messages') return null;
  if (typeof payload.peer_id !== 'string' || !UUID_RE.test(payload.peer_id)) return invalid;
  if (!['first_unread', 'latest', 'before', 'after'].includes(payload.anchor as string)) return invalid;
  const directional = payload.anchor === 'before' || payload.anchor === 'after';
  if (directional ? typeof cursor !== 'string' || cursor.length === 0 : cursor != null) return invalid;
  return null;
}
