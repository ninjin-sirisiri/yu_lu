import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;

function defaultClient(): SupabaseClient {
  return createClient(url, anon);
}

/** Reserve a block for the next 04:00 JST cycle. Never writes `blocks`
 *  directly: same-day direct blocks of daily targets are rejected by the
 *  relationship guard (migration 0004), so the reservation path is the only
 *  way to separate from a daily target during the day. */
export async function reserveBlock(
  blockedUserId: string,
  client: SupabaseClient = defaultClient(),
): Promise<void> {
  const result = await client.from('block_reservations').insert({
    blocked_user_id: blockedUserId,
  });
  if (result.error) throw new Error(result.error.message);
}

/** Cancel a pending reservation. Only unapplied rows match
 *  (`applied_at IS NULL`); once the cycle has applied the reservation,
 *  cancelling is a no-op. */
export async function cancelReservation(
  blockedUserId: string,
  client: SupabaseClient = defaultClient(),
): Promise<void> {
  const result = await client
    .from('block_reservations')
    .delete()
    .is('applied_at', null)
    .eq('blocked_user_id', blockedUserId);
  if (result.error) throw new Error(result.error.message);
}
