// Task 7: scheduled request and invitation expiry (service-role only).
//
// Ownership: this function owns the scheduled expiry job. It lapses past-due
// friend requests and invitations via the Task 1 RPCs and never establishes
// friendship. Deploy scheduling (pg_cron / Supabase scheduled functions) lives
// outside this repo worktree; running `functions deploy` is intentionally left
// to CI / an environment with the Supabase CLI.
//
// Import convention: '@supabase/supabase-js' (repo convention, matching
// supabase/functions/daily-settlement/index.ts), not the brief's
// 'npm:@supabase/supabase-js@2'. Handler and plain-text responses match the
// brief exactly. No deno.json: the existing functions ship a single index.ts
// with no deno.json, and this file matches that layout.

import { createClient } from '@supabase/supabase-js';

const url = Deno.env.get('SUPABASE_URL') as string;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
const admin = createClient(url, key);

Deno.serve(async (_req: Request): Promise<Response> => {
  const { error } = await admin.rpc('expire_friend_requests');
  if (error) return new Response('request expiry failed', { status: 500 });
  const { error: invitationError } = await admin.rpc('expire_invitations');
  if (invitationError) return new Response('invitation expiry failed', { status: 500 });
  return new Response('expiry ok', { status: 200 });
});
