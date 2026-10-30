import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatAppearanceWire, StreakAppearanceWire } from '../appearance/contracts';
import { QueryError } from './queries';

// Wire DTOs mirror Task 8/9's closed app-query boundary. Deliberately no global
// client: the provider must inject the existing authenticated client and actor.
export type ChatAnchor = 'first_unread' | 'latest' | 'before' | 'after';
export interface ChatPeer {
  peer_id: string; conversation_id: string | null;
  peer: { display_name: string; avatar_path: string | null };
  can_send: boolean; friendship_epoch: string | null;
  /** Absent in old caches; never required for the core chat response. */
  appearance?: ChatAppearanceWire;
}
export interface ChatMessage {
  message_id: string; conversation_id: string; sequence: number;
  sender_id: string; recipient_id: string; client_key: string; accepted_at: string;
  withdrawn: boolean; body: string | null; image_paths: string[];
}
export interface ChatUnread {
  peer_id: string; conversation_id: string; unread_count: number;
  first_unread_sequence: number | null; latest_sequence: number;
}
export interface ChatSummary extends ChatPeer {
  unread_count: number; latest_sequence: number; last_message: ChatMessage | null;
  roles: { send: boolean; reply: boolean }; send_completed: boolean | null;
  reply_state: 'reply_needed' | 'waiting' | 'achieved' | null;
  status: 'reply_needed' | 'send_needed' | 'waiting' | 'achieved' | null;
}
export interface HomeResult {
  revision: number; server_now: string; daily_key: string; deadline: string; draw_deadline: string;
  draw_state: 'not_started' | 'pending' | 'running' | 'succeeded' | 'failed'; draw_finalized_at: string | null;
  participation: 'checking' | 'draw_failed' | 'no_friends' | 'waiting_next_cycle' | 'eligible';
  streak: number; streak_appearance?: StreakAppearanceWire;
  send_completed: boolean | null; reply_completed: number; reply_total: number;
  achieved: boolean; actionable_complete: boolean; targets: ChatSummary[]; unread_peer_count: number;
}
export interface ChatListResult {
  revision: number; server_now: string; daily_key: string; targets: ChatSummary[];
  items: ChatSummary[]; next_cursor: string | null; unread_peer_count: number;
}
export interface ChatMessagesResult extends ChatPeer {
  revision: number; items: ChatMessage[]; before_cursor: string | null; after_cursor: string | null;
  first_unread_sequence: number | null; latest_sequence: number;
  streak_appearance?: StreakAppearanceWire;
}
export interface ChatUnreadResult { revision: number; items: ChatUnread[]; unread_peer_count: number }
interface Results {
  get_home: HomeResult; list_chats: ChatListResult;
  get_chat_messages: ChatMessagesResult; get_chat_unread: ChatUnreadResult;
}
export interface ChatClient {
  getHome(): Promise<HomeResult>;
  listChats(cursor?: string | null): Promise<ChatListResult>;
  getMessages(peerId: string, anchor: ChatAnchor, cursor?: string | null): Promise<ChatMessagesResult>;
  getUnread(): Promise<ChatUnreadResult>;
}

export function createChatClient(options: { client: SupabaseClient; accountId: string }): ChatClient {
  async function query<K extends keyof Results>(op: K, payload: Record<string, unknown>): Promise<Results[K]> {
    const { data: auth, error: authError } = await options.client.auth.getSession();
    if (authError || auth.session?.user.id !== options.accountId || !auth.session.access_token) {
      throw new QueryError('Query belongs to a different or unavailable account.', 401);
    }
    const { data, error } = await options.client.functions.invoke('app-query', {
      headers: { Authorization: `Bearer ${auth.session.access_token}` }, body: { op, payload },
    });
    if (error) {
      let message = error.message ?? 'Chat query failed.';
      const context = error.context as { status?: number; json?(): Promise<{ error?: string }> } | undefined;
      try { message = (await context?.json?.())?.error ?? message; } catch { /* Keep transport fallback. */ }
      throw new QueryError(message, context?.status ?? 0);
    }
    if (!data || data.op !== op || !data.result || !Number.isSafeInteger(data.result.revision) || data.result.revision < 0) {
      throw new QueryError('Unexpected chat query response.', 0);
    }
    return data.result as Results[K];
  }
  return {
    getHome: () => query('get_home', {}),
    listChats: (cursor = null) => query('list_chats', { cursor }),
    getMessages: (peerId, anchor, cursor = null) => query('get_chat_messages', { peer_id: peerId, anchor, cursor }),
    getUnread: () => query('get_chat_unread', {}),
  };
}
