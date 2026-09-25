// Task 7: scheduled request and invitation expiry (service-role only).
//
// Ownership: this function owns the scheduled expiry job. It lapses past-due
// friend requests and invitations via the Task 1 RPCs and never establishes
// friendship. Deploy scheduling (pg_cron / Supabase scheduled functions) lives
// outside this repo worktree; running `functions deploy` is intentionally left
// to CI / an environment with the Supabase CLI.
//
// Task 2 hardening: the trigger is no longer open. `requireServiceCall`
// from `_shared/auth.ts` demands the service credential as the Bearer token
// (the platform verify_jwt check already demands a project-signed header,
// so only the service key satisfies both) and fails closed when the
// credential is not configured. End-user JWTs and anonymous calls get 401.
// Scheduled callers must send `Authorization: Bearer <service key>`.
//
// Import convention: '@supabase/supabase-js' (repo convention, matching
// supabase/functions/daily-settlement/index.ts), resolved through the
// shared supabase/functions/deno.json. Handler and plain-text responses
// match the brief.

import { createClient } from '@supabase/supabase-js';
import { requireServiceCall } from '../_shared/auth.ts';

const url = Deno.env.get('SUPABASE_URL') as string;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
const admin = createClient(url, key);

Deno.serve(async (req: Request): Promise<Response> => {
  const denied = requireServiceCall(req);
  if (denied) return denied;

  const { error } = await admin.rpc('expire_friend_requests');
  if (error) return new Response('request expiry failed', { status: 500 });
  const { error: invitationError } = await admin.rpc('expire_invitations');
  if (invitationError) return new Response('invitation expiry failed', { status: 500 });
  return new Response('expiry ok', { status: 200 });
});
