// Task 18: shared notification contracts (device session, push content,
// delivery status mapping).
//
// Ownership: this module owns the fail-fast payload gate and HTTP handler
// for the `device-session` Edge Function (registration binds the
// VERIFIED actor from the JWT to a push token - there is no actor field
// anywhere in the contract), the notification copy built ONLY from public
// fields (event type + peer display name + generic per-event text; never
// streaks, progress or any other private state), and the mapping from
// provider send/receipt outcomes onto delivery statuses. Like the other
// Edge gates, rejecting here is only fail-fast: public.device_session
// remains authoritative and its messages are byte-identical to
// DEVICE_MESSAGES (asserted in supabase/functions/tests/notifications.test.ts
// and supabase/tests/database/notifications.test.sql).
//
// The Expo HTTP sender itself is a SEPARATE adapter module
// (_shared/expo-push.ts) so the transport, tickets and receipts can be
// faked in tests; the default wiring only ever calls the Expo API when an
// access token credential exists.

import { defaultGetUser, jsonError, requireActor, type GetUser } from './auth.ts';
import { mapRpcError, UUID_RE, type RpcOutcome } from './commands.ts';
import type { PushMessage, ReceiptOutcome, SendOutcome } from './expo-push.ts';

// ---------------------------------------------------------------------------
// device-session payload gate (byte-identical messages in SQL 0013).
// ---------------------------------------------------------------------------

export const DEVICE_MESSAGES = {
  actionRequired: 'action is required',
  actionType: 'action must be a string',
  actionUnknown: 'unsupported action',
  tokenRequired: 'push_token is required',
  tokenType: 'push_token must be a string',
  tokenBlank: 'push_token must not be blank',
  tokenTooLong: 'push_token must be 512 characters or fewer',
  deviceIdRequired: 'device_id is required',
  deviceIdType: 'device_id must be a string',
  deviceIdUuid: 'device_id must be a UUID',
} as const;

export const DEVICE_SESSION_ACTIONS = ['register', 'unregister'] as const;

export type DeviceSessionRequest =
  | { ok: true; action: 'register'; payload: Record<string, unknown> }
  | { ok: true; action: 'unregister'; payload: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Shape gate for the device-session body. The action selects the required
 * fields; unknown extra fields are left to the SQL handler (same policy as
 * the invitation/command gates). Returns the message to reject with
 * (HTTP 400), or the parsed action + payload.
 */
export function validateDeviceSessionBody(body: unknown): DeviceSessionRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  if (!('action' in record)) {
    return { ok: false, error: DEVICE_MESSAGES.actionRequired };
  }
  const action = record['action'];
  if (typeof action !== 'string') {
    return { ok: false, error: DEVICE_MESSAGES.actionType };
  }
  if (!(DEVICE_SESSION_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: DEVICE_MESSAGES.actionUnknown };
  }

  const payload = { ...record };
  delete payload['action'];

  if (action === 'register') {
    if (!('push_token' in payload)) {
      return { ok: false, error: DEVICE_MESSAGES.tokenRequired };
    }
    const token = payload['push_token'];
    if (typeof token !== 'string') {
      return { ok: false, error: DEVICE_MESSAGES.tokenType };
    }
    if (token.trim().length === 0) {
      return { ok: false, error: DEVICE_MESSAGES.tokenBlank };
    }
    if (token.trim().length > 512) {
      return { ok: false, error: DEVICE_MESSAGES.tokenTooLong };
    }
    return { ok: true, action: 'register', payload };
  }

  if (!('device_id' in payload)) {
    return { ok: false, error: DEVICE_MESSAGES.deviceIdRequired };
  }
  const deviceId = payload['device_id'];
  if (typeof deviceId !== 'string') {
    return { ok: false, error: DEVICE_MESSAGES.deviceIdType };
  }
  if (!UUID_RE.test(deviceId)) {
    return { ok: false, error: DEVICE_MESSAGES.deviceIdUuid };
  }
  return { ok: true, action: 'unregister', payload };
}

// ---------------------------------------------------------------------------
// device-session transport (injectable for tests).
// ---------------------------------------------------------------------------

export interface DeviceSessionArgs {
  p_action: string;
  p_payload: Record<string, unknown>;
}

export type DeviceSessionRpc = (
  args: DeviceSessionArgs,
  authorization: string,
) => Promise<RpcOutcome>;

/** Default transport: one PostgREST RPC call with the caller's JWT forwarded
 * so the database derives the actor from the same verified claims. */
export const defaultDeviceSessionRpc: DeviceSessionRpc = async (
  args,
  authorization,
) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY') ??
    Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) {
    return { ok: false, code: null, message: 'device session endpoint is not configured' };
  }
  try {
    const res = await fetch(`${url}/rest/v1/rpc/device_session`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok && typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return { ok: true, data: body as Record<string, unknown> };
    }
    const err = (typeof body === 'object' && body !== null ? body : {}) as {
      code?: unknown;
      message?: unknown;
    };
    return {
      ok: false,
      code: typeof err.code === 'string' ? err.code : null,
      message: typeof err.message === 'string'
        ? err.message
        : 'device session failed',
    };
  } catch {
    return { ok: false, code: null, message: 'device session failed' };
  }
};

/**
 * The device-session HTTP flow: method check -> verified session (401,
 * actor only ever from the JWT) -> payload gate -> one RPC call with the
 * caller's Authorization forwarded. There is no actor field in the body.
 */
export async function executeDeviceSession(
  req: Request,
  getUser: GetUser = defaultGetUser,
  rpc: DeviceSessionRpc = defaultDeviceSessionRpc,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError(405, 'method not allowed');
  }
  const actor = await requireActor(req, getUser);
  if (actor instanceof Response) return actor;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'invalid JSON body');
  }
  const parsed = validateDeviceSessionBody(raw);
  if (!parsed.ok) return jsonError(400, parsed.error);

  const authorization = req.headers.get('authorization');
  if (!authorization) return jsonError(401, 'authentication required');

  const outcome = await rpc(
    { p_action: parsed.action, p_payload: parsed.payload },
    authorization,
  );
  if (!outcome.ok) {
    const mapped = mapRpcError(outcome.code);
    return jsonError(
      mapped.status,
      mapped.expose ? outcome.message : 'device session failed',
    );
  }
  return new Response(JSON.stringify(outcome.data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Push content: public fields only. The queue rows carry exactly
// {event_type, request_id, peer_display_name, push_token}; the copy never
// reads streaks, progress or introduction state because those fields are
// not part of the input type - structural absence, asserted in tests.
// ---------------------------------------------------------------------------

export const PUSHABLE_EVENT_TYPES = [
  'request_received',
  'friendship_established',
  'request_expired',
] as const;

export type PushableEventType = (typeof PUSHABLE_EVENT_TYPES)[number];

export function isPushableEventType(value: string): value is PushableEventType {
  return (PUSHABLE_EVENT_TYPES as readonly string[]).includes(value);
}

export const NOTIFICATION_COPY: Record<
  PushableEventType,
  { title: string; body: (peerDisplayName: string) => string }
> = {
  request_received: {
    title: '友達申請',
    body: (peer) => `${peer}さんから友達申請が届きました`,
  },
  friendship_established: {
    title: '友達になりました',
    body: (peer) => `${peer}さんと友達になりました`,
  },
  request_expired: {
    title: '友達申請の期限',
    body: (peer) => `${peer}さんへの友達申請は期限切れで終了しました`,
  },
};

/** Exactly the public fields a delivery row exposes to the builder. */
export interface PushDelivery {
  delivery_id: string;
  event_id: string;
  device_id: string;
  recipient_user_id: string;
  event_type: PushableEventType;
  request_id: string;
  peer_display_name: string;
  push_token: string;
}

/** Build one Expo push message from a delivery row - public fields only. */
export function buildPushMessage(delivery: PushDelivery): PushMessage {
  const copy = NOTIFICATION_COPY[delivery.event_type];
  return {
    to: delivery.push_token,
    title: copy.title,
    body: copy.body(delivery.peer_display_name),
    sound: 'default',
    data: { event: delivery.event_type, request_id: delivery.request_id },
  };
}

// ---------------------------------------------------------------------------
// Provider outcomes -> delivery statuses (see 0013 for the full state
// machine). The rules:
// - accepted          -> sent (awaiting the push receipt)
// - DeviceNotRegistered -> invalid_token (and the device is invalidated)
// - rejected          -> failed (the provider answered; retrying cannot help)
// - retryable         -> pending (the provider REJECTED without accepting -
//                        429/5xx - so a bounded retry is honest)
// - result_unknown    -> result_unknown (the response was lost after the
//                        request MAY have been accepted: recorded as
//                        unknown, NEVER re-dispatched automatically - Task
//                        18 does not claim exactly-once for OS delivery)
// ---------------------------------------------------------------------------

export type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'receipt_ok'
  | 'invalid_token'
  | 'failed'
  | 'result_unknown';

export interface StatusUpdate {
  status: DeliveryStatus;
  last_error: string | null;
}

export function sendOutcomeToStatus(outcome: SendOutcome): StatusUpdate {
  switch (outcome.kind) {
    case 'accepted':
      return { status: 'sent', last_error: null };
    case 'invalid_token':
      return { status: 'invalid_token', last_error: 'DeviceNotRegistered' };
    case 'rejected':
      return { status: 'failed', last_error: outcome.code };
    case 'retryable':
      return { status: 'pending', last_error: outcome.code };
    case 'result_unknown':
      return { status: 'result_unknown', last_error: outcome.reason };
  }
}

export function receiptOutcomeToStatus(outcome: ReceiptOutcome): StatusUpdate {
  switch (outcome.kind) {
    case 'delivered':
      // Provider handoff confirmed (APNs/FCM accepted) - not an OS-level
      // delivery guarantee; the row name says receipt_ok, not delivered.
      return { status: 'receipt_ok', last_error: null };
    case 'invalid_token':
      return { status: 'invalid_token', last_error: 'DeviceNotRegistered' };
    case 'rejected':
      return { status: 'failed', last_error: outcome.code };
    case 'pending':
      return { status: 'sent', last_error: null };
  }
}

// Worker tuning, documented next to their SQL counterparts in 0013
// (claim TTL 10 min = stale 'sending' age; attempts bound lives in
// claim_notification_batch).
export const DISPATCH_BATCH_LIMIT = 100;
export const RECEIPT_AFTER_MINUTES = 15;
