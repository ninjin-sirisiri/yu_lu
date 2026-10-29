import type { SupabaseClient } from '@supabase/supabase-js';

export type ChatRealtimeStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';
export interface ChatRealtimePort {
  subscribe(accountId: string, callbacks: {
    revision(value: number): void;
    status(value: ChatRealtimeStatus): void;
  }): () => void;
}

/** Only the body-free actor invalidation stream. RLS is authoritative; the
 * explicit filter and payload check also prevent accidentally routing peers. */
export function createChatRealtime(client: SupabaseClient): ChatRealtimePort {
  return {
    subscribe(accountId, callbacks) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
        throw new Error('Invalid chat account.');
      }
      let stopped = false;
      const channel = client.channel(`chat-updates:${accountId}`)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'chat_updates', filter: `user_id=eq.${accountId}`,
        }, payload => {
          const row = payload.new as { user_id?: unknown; revision?: unknown };
          if (!stopped && row?.user_id === accountId && typeof row.revision === 'number' &&
              Number.isSafeInteger(row.revision) && row.revision >= 0) callbacks.revision(row.revision);
        })
        .on('system', {}, payload => {
          // A channel join can precede PostgreSQL's replication subscription.
          // Close that second gap too: accepted messages during setup otherwise
          // have neither an event nor a subsequent authoritative refetch.
          if (!stopped && payload.extension === 'postgres_changes' && payload.status === 'ok') {
            callbacks.status('SUBSCRIBED');
          }
        })
        .subscribe(status => { if (!stopped) callbacks.status(status); });
      return () => {
        if (stopped) return;
        stopped = true; // Revoke callbacks before the asynchronous transport leave.
        void client.removeChannel(channel).catch(() => { /* Already revoked locally. */ });
      };
    },
  };
}
