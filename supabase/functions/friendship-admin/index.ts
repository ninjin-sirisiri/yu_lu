// Task 7: privileged friend-request transitions (service-role only).
//
// Ownership: this function owns server-side request transitions. Approval and
// crossed-request establishment MUST go through this path (never direct table
// writes): Postgres permissive RLS policies OR-combine, so Task 6's policies
// alone cannot separate sender-cancel from recipient-decide by role (see the
// Task 6 report probe: a sender applying pending -> approved on their own row
// succeeds at RLS level). Clients call this function for establishment.
//
// Task 2 hardening: the unverified path is closed. Every call now goes
// through `_shared/auth.ts` — a JWT verified by Supabase Auth is required,
// and the verified actor must match the role the action needs (senders
// create/cancel, recipients approve/reject), so nobody can act for another
// user by naming them in the body. Task 4 finishes the migration by moving
// these transitions onto the app-command operation boundary.
//
// Import convention: '@supabase/supabase-js' (repo convention, matching
// supabase/functions/daily-settlement/index.ts), resolved through
// supabase/functions/deno.json, which this repo's shared Deno config now
// provides.
//
// Actions (JSON body: { action, sender_user_id, recipient_user_id }):
// - request: create a pending request (7-day validity). Refuses with 409 when
//   the pair is blocked in either direction (blocked recipients accept no new
//   request until unblock) or a pending row already exists in the same
//   direction (duplicate requests guide the user to the existing pending
//   request). A reverse-direction pending is a crossed request: establish
//   immediately via create_friendship_from_request with notice to both. An
//   existing friendship also refuses (no new request is needed).
// - approve: recipient approval. Requires a pending sender -> recipient row,
//   then establishes via create_friendship_from_request (which also clears all
//   related pendings, so no unanswered request remains). Refused under an
//   active block: the daily cycle deletes blocked-pair friendships, so
//   approval cannot proceed while a block stands.
// - reject: recipient rejection. Pending -> rejected only; never establishes
//   friendship. The response carries only the neutral display text (no reason
//   or timing is disclosed).
// - cancel: sender cancellation. Pending -> cancelled only; never establishes
//   friendship.
//
// Expiry is owned by request-expiry, not here. Expiry, cancellation, and
// rejection never call the friendship RPC, so they never establish friendship.

import { createClient } from '@supabase/supabase-js';
import { requireActor } from '../_shared/auth.ts';

const url = Deno.env.get('SUPABASE_URL') as string;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
const admin = createClient(url, key);

const FRIEND_REQUEST_VALID_DAYS = 7;
const DUPLICATE_GUIDANCE = 'A request is already pending. Open the existing request.';
const BLOCKED_GUIDANCE =
  'Requests cannot be sent to a blocked recipient. Re-request after unblock.';
const ALREADY_FRIENDS_MESSAGE = 'Already friends. No new request is needed.';
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

function requestExpiry(): string {
  return new Date(Date.now() + FRIEND_REQUEST_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function requestPairFilter(a: string, b: string): string {
  return (
    `and(sender_user_id.eq.${a},recipient_user_id.eq.${b}),` +
    `and(sender_user_id.eq.${b},recipient_user_id.eq.${a})`
  );
}

function blockPairFilter(a: string, b: string): string {
  return (
    `and(user_id.eq.${a},blocked_user_id.eq.${b}),` +
    `and(user_id.eq.${b},blocked_user_id.eq.${a})`
  );
}

async function blockedEitherDirection(a: string, b: string): Promise<boolean> {
  const { data, error } = await admin
    .from('blocks')
    .select('user_id')
    .or(blockPairFilter(a, b))
    .limit(1);
  if (error) throw new Error('block check failed');
  return data !== null && data.length > 0;
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

  if (action === 'request') {
    try {
      // Blocked recipients accept no new request until unblock.
      if (await blockedEitherDirection(sender, recipient)) {
        return json({ error: BLOCKED_GUIDANCE }, 409);
      }
    } catch {
      return json({ error: 'block check failed' }, 500);
    }

    // A duplicate request is never created while one is pending.
    const { data: pendingRows, error: pendingError } = await admin
      .from('friend_requests')
      .select('request_id,sender_user_id,recipient_user_id')
      .eq('status', 'pending')
      .or(requestPairFilter(sender, recipient));
    if (pendingError) return json({ error: 'pending check failed' }, 500);
    const rows = (pendingRows ?? []) as Array<{
      request_id: string;
      sender_user_id: string;
    }>;
    const sameDirection = rows.find((row) => row.sender_user_id === sender);
    if (sameDirection) {
      return json(
        { error: DUPLICATE_GUIDANCE, request_id: sameDirection.request_id },
        409,
      );
    }
    const reversePending = rows.find((row) => row.sender_user_id === recipient);
    if (reversePending) {
      // Crossed requests establish immediately with notice to both.
      const { error: crossedError } = await admin.rpc('create_friendship_from_request', {
        p_sender: sender,
        p_recipient: recipient,
      });
      if (crossedError) return json({ error: 'crossed establishment failed' }, 500);
      return json({ result: 'crossed', notice: CROSSED_NOTICE }, 200);
    }

    // No new request is needed between established friends.
    const [first, second] = sender < recipient ? [sender, recipient] : [recipient, sender];
    const { data: friendship, error: friendshipError } = await admin
      .from('friendships')
      .select('user_a')
      .eq('user_a', first)
      .eq('user_b', second)
      .maybeSingle();
    if (friendshipError) return json({ error: 'friendship check failed' }, 500);
    if (friendship) return json({ error: ALREADY_FRIENDS_MESSAGE }, 409);

    const { data: created, error: insertError } = await admin
      .from('friend_requests')
      .insert({
        sender_user_id: sender,
        recipient_user_id: recipient,
        status: 'pending',
        expires_at: requestExpiry(),
      })
      .select('request_id')
      .single();
    if (insertError) {
      // A concurrent insert may win first; the 0005 partial unique index
      // rejects the loser. Report it as the existing pending request.
      if ((insertError as { code?: string }).code === '23505') {
        return json({ error: DUPLICATE_GUIDANCE }, 409);
      }
      return json({ error: 'request creation failed' }, 500);
    }
    return json(
      { result: 'requested', request_id: (created as { request_id: string }).request_id },
      201,
    );
  }

  if (action === 'approve') {
    try {
      if (await blockedEitherDirection(sender, recipient)) {
        return json({ error: BLOCKED_GUIDANCE }, 409);
      }
    } catch {
      return json({ error: 'block check failed' }, 500);
    }

    // Approval requires a pending row: the RPC clears pendings but would
    // otherwise insert a friendship from nothing.
    const { data: pending, error: pendingError } = await admin
      .from('friend_requests')
      .select('request_id')
      .eq('status', 'pending')
      .eq('sender_user_id', sender)
      .eq('recipient_user_id', recipient)
      .maybeSingle();
    if (pendingError) return json({ error: 'pending check failed' }, 500);
    if (!pending) return json({ error: NO_PENDING_MESSAGE }, 404);

    const { error } = await admin.rpc('create_friendship_from_request', {
      p_sender: sender,
      p_recipient: recipient,
    });
    if (error) return json({ error: 'approval failed' }, 500);
    return json({ result: 'approved', message: 'approval ok' }, 200);
  }

  if (action === 'reject' || action === 'cancel') {
    const targetStatus = action === 'reject' ? 'rejected' : 'cancelled';
    const { data: pending, error: pendingError } = await admin
      .from('friend_requests')
      .select('request_id')
      .eq('status', 'pending')
      .eq('sender_user_id', sender)
      .eq('recipient_user_id', recipient)
      .maybeSingle();
    if (pendingError) return json({ error: 'pending check failed' }, 500);
    if (!pending) return json({ error: NO_PENDING_MESSAGE }, 404);

    // Rejection and cancellation only move the status; they never call the
    // friendship RPC, so they never establish friendship.
    const { error } = await admin
      .from('friend_requests')
      .update({ status: targetStatus, decided_at: new Date().toISOString() })
      .eq('request_id', (pending as { request_id: string }).request_id);
    if (error) return json({ error: `${action} failed` }, 500);
    if (action === 'reject') {
      // Neutral display only: no reason or timing is disclosed.
      return json({ result: 'rejected', display: REJECTION_DISPLAY }, 200);
    }
    return json({ result: 'cancelled' }, 200);
  }

  return json({ error: 'unsupported action' }, 400);
});
