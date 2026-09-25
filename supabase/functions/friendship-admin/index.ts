// Task 7/4: legacy friend-request action endpoint, now proxied onto the
// app-command operation boundary.
//
// Ownership: this function keeps the legacy HTTP contract
// ({ action, sender_user_id, recipient_user_id }) while every transition
// itself executes inside public.app_command - the same operation log,
// payload hashing, pair serialization and identity validation as the
// modern `request` / `approve` / `reject` / `cancel` command kinds. It no
// longer performs its own state logic: pre-checks, block/duplicate/friend
// rules and the transitions themselves live in migration
// 0009_request_transitions.sql, and error messages pass through from the
// boundary unchanged.
//
// Order: verified session (401 before anything else; actor only ever comes
// from the JWT) -> body validation -> actor/role binding (the legacy 403s
// are kept verbatim) -> legacy pair resolution for decision actions ->
// one executeCommand call with the caller's Authorization header.
//
// Contract notes:
// - Decision actions address the request by pair (the legacy body has no
//   request_id): the CURRENT pending row of that pair is resolved here and
//   then validated for identity + state by the handler, so a resolution
//   that races a re-request fails cleanly instead of touching the new row.
// - Success shapes stay legacy: 201 { result: 'requested' }, 200
//   { result: 'crossed', notice }, { result: 'approved' }, { result:
//   'rejected', display } (the neutral UI text - Task 13 owns wording for
//   the modern command result, which stays neutral), { result: 'cancelled' }.
// - The duplicate-request 409 no longer embeds request_id (the boundary
//   error carries only the message); clients on the modern path read the
//   sender's outbox view instead.
//
// Import convention: '@supabase/supabase-js' resolved through
// supabase/functions/deno.json.

import { createClient } from '@supabase/supabase-js';
import { requireActor } from '../_shared/auth.ts';
import { executeCommand } from '../_shared/commands.ts';

const url = Deno.env.get('SUPABASE_URL') as string;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
const admin = createClient(url, key);

const NO_PENDING_MESSAGE = 'No pending request found.';
const REJECTION_DISPLAY = '今回は成立しませんでした';
const CROSSED_NOTICE = '相互にリクエストがあったため、友達になりました。';

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  // A verified session is required before anything else runs; the actor
  // comes from the JWT, never from the body.
  const actor = await requireActor(req);
  if (actor instanceof Response) return actor;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const action = body['action'];
  const sender = body['sender_user_id'];
  const recipient = body['recipient_user_id'];
  if (
    typeof sender !== 'string' ||
    !UUID_RE.test(sender) ||
    typeof recipient !== 'string' ||
    !UUID_RE.test(recipient)
  ) {
    return json({ error: 'sender_user_id and recipient_user_id must be UUIDs' }, 400);
  }
  if (sender === recipient) {
    return json({ error: 'self request is not allowed' }, 400);
  }

  // Bind the verified actor to the role the action requires: senders create
  // and cancel, recipients approve and reject. Anyone else gets 403.
  if (action === 'request' || action === 'cancel') {
    if (sender !== actor.actorId) {
      return json({ error: 'the authenticated actor must be the sender' }, 403);
    }
  } else if (action === 'approve' || action === 'reject') {
    if (recipient !== actor.actorId) {
      return json({ error: 'the authenticated actor must be the recipient' }, 403);
    }
  }

  if (
    action !== 'request' && action !== 'approve' &&
    action !== 'reject' && action !== 'cancel'
  ) {
    return json({ error: 'unsupported action' }, 400);
  }

  // Legacy decision bodies address the pair; resolve the current pending
  // row and hand its id to the boundary, which re-validates identity,
  // role, state and server-time expiry under the pair lock.
  let requestId: string | null = null;
  if (action !== 'request') {
    const { data, error } = await admin
      .from('friend_requests')
      .select('request_id')
      .eq('status', 'pending')
      .eq('sender_user_id', sender)
      .eq('recipient_user_id', recipient)
      .maybeSingle();
    if (error) return json({ error: 'pending check failed' }, 500);
    if (!data) return json({ error: NO_PENDING_MESSAGE }, 404);
    requestId = (data as { request_id: string }).request_id;
  }

  const authorization = req.headers.get('authorization');
  if (!authorization) return json({ error: 'authentication required' }, 401);

  const payload = action === 'request'
    ? { target_user_id: recipient }
    : { request_id: requestId };

  const commandRequest = new Request('http://localhost/functions/v1/app-command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operation_id: crypto.randomUUID(),
      kind: action,
      payload,
    }),
  });

  const res = await executeCommand(commandRequest, authorization);
  if (res.status !== 200) {
    // Boundary errors already match the legacy { error } shape.
    return res;
  }

  const outcome = (await res.json()) as { result?: Record<string, unknown> };
  const result = outcome.result ?? {};
  switch (action) {
    case 'request':
      if (result['result'] === 'crossed') {
        return json({ result: 'crossed', notice: CROSSED_NOTICE }, 200);
      }
      return json(
        { result: 'requested', request_id: result['request_id'] },
        201,
      );
    case 'approve':
      return json({ result: 'approved', message: 'approval ok' }, 200);
    case 'reject':
      // Neutral display only: no reason or timing is disclosed.
      return json({ result: 'rejected', display: REJECTION_DISPLAY }, 200);
    default:
      return json({ result: 'cancelled' }, 200);
  }
});
