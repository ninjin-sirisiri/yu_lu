// Task 18: scheduled notification dispatch (service-role only).
//
// Ownership: this function owns the periodic push run. It is invoked on a
// schedule (pg_cron / Supabase Scheduler / an external cron - the schedule
// itself lives outside this repo worktree, like request-expiry's) and
// demands `Authorization: Bearer <service key>` via requireServiceCall: the
// platform verify_jwt check already requires a project-signed header, the
// gate narrows that to the service credential and fails closed when it is
// not configured. End-user JWTs and anonymous calls get 401.
//
// The run, in order:
// 1. CLAIM the single 'dispatch' row in the database (claim RPC). A second
//    invocation that finds a live claim answers "dispatch busy" and
//    dispatches NOTHING - double-starts are claimed in the DB, not by
//    process luck. The claim expires after 10 minutes; release only succeeds
//    for the current holder.
// 2. GENERATE delivery rows from the confirmed events (request_received,
//    friendship_established, request_expired) x the recipients' valid
//    devices. Generation is idempotent (unique event_id x device_id), so
//    re-running over the same events creates nothing new. Rejection and
//    invitation expiry have no event rows at all and are never pushed.
// 3. CLAIM a batch of pending rows (status -> 'sending') and send through
//    the Expo adapter. Outcomes are recorded exactly as classified:
//    accepted -> sent + ticket id, DeviceNotRegistered -> invalid_token +
//    device invalidated, provider rejection -> failed, provider 429/5xx
//    (rejected WITHOUT accepting) -> back to pending for the bounded retry,
//    lost/ambiguous response -> result_unknown which is NEVER re-sent
//    automatically (no blind redelivery after a possible acceptance; no
//    exactly-once claim for OS delivery). Rows the batch rule found stale
//    or device-invalidated are finalized by the same SQL call.
// 4. RECEIPTS: sent rows older than 15 minutes are looked up idempotently;
//    a failed lookup leaves them untouched for a later run. A receipt of
//    DeviceNotRegistered invalidates the token (Expo's instruction: stop
//    sending to it).
//
// Credentials: Expo HTTP calls happen ONLY when EXPO_ACCESS_TOKEN exists.
// Without it the sender reports disabled: generation still queues rows so
// the backlog is ready, no batch is claimed and no network call is made.
// Tests never reach this code path against the real API - the adapter takes
// an injected transport (supabase/functions/tests/notifications.test.ts).
//
// Import convention: '@supabase/supabase-js' resolved through
// supabase/functions/deno.json; plain-text responses match the other
// scheduled functions ('expiry ok' style).

import { createClient } from '@supabase/supabase-js';
import { requireServiceCall } from '../_shared/auth.ts';
import { createExpoPushSender, type ReceiptOutcome, type SendOutcome } from '../_shared/expo-push.ts';
import {
  buildPushMessage,
  DISPATCH_BATCH_LIMIT,
  RECEIPT_AFTER_MINUTES,
  receiptOutcomeToStatus,
  sendOutcomeToStatus,
  type PushDelivery,
  type PushableEventType,
} from '../_shared/notifications.ts';

const url = Deno.env.get('SUPABASE_URL') as string;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
const admin = createClient(url, key);

// No credential -> enabled = false -> zero network calls (see header).
const sender = createExpoPushSender({
  accessToken: Deno.env.get('EXPO_ACCESS_TOKEN') ?? null,
});

interface BatchRow {
  delivery_id: string;
  event_id: string;
  device_id: string;
  recipient_user_id: string;
  event_type: string;
  request_id: string;
  peer_display_name: string;
}

interface DeviceRow {
  device_id: string;
  push_token: string;
  invalidated_at: string | null;
}

interface SentRow {
  delivery_id: string;
  device_id: string;
  provider_ticket_id: string;
}

function text(message: string, status = 200): Response {
  return new Response(message, { status });
}

function now(): string {
  return new Date().toISOString();
}

async function invalidateDevice(deviceId: string): Promise<void> {
  await admin
    .from('user_devices')
    .update({ invalidated_at: now(), updated_at: now() })
    .eq('device_id', deviceId)
    .is('invalidated_at', null);
}

async function recordSendOutcome(
  row: BatchRow,
  outcome: SendOutcome,
): Promise<void> {
  const { status, last_error } = sendOutcomeToStatus(outcome);
  const update: Record<string, unknown> = {
    status,
    claimed_at: null,
    updated_at: now(),
  };
  if (last_error !== null) update.last_error = last_error;
  if (outcome.kind === 'accepted') {
    update.provider_ticket_id = outcome.ticketId;
    update.sent_at = now();
  }
  // Guarded on status='sending': a late write can never overwrite a row
  // that was already reaped, and a failed write leaves the row 'sending'
  // so the stale rule records result_unknown instead of redelivering.
  await admin
    .from('notification_deliveries')
    .update(update)
    .eq('delivery_id', row.delivery_id)
    .eq('status', 'sending');
  if (status === 'invalid_token') await invalidateDevice(row.device_id);
}

async function claimAndSend(): Promise<Response | null> {
  const { data: batch, error } = await admin.rpc('claim_notification_batch', {
    p_limit: DISPATCH_BATCH_LIMIT,
  });
  if (error) return text('dispatch batch failed', 500);
  const rows = (batch ?? []) as BatchRow[];
  if (rows.length === 0) return null;

  const deviceIds = [...new Set(rows.map((r) => r.device_id))];
  const { data: devices, error: deviceError } = await admin
    .from('user_devices')
    .select('device_id, push_token, invalidated_at')
    .in('device_id', deviceIds);
  if (deviceError) return text('dispatch batch failed', 500);
  const byId = new Map<string, DeviceRow>(
    ((devices ?? []) as DeviceRow[]).map((d) => [d.device_id, d]),
  );

  const sendable: { row: BatchRow; delivery: PushDelivery }[] = [];
  for (const row of rows) {
    const device = byId.get(row.device_id);
    if (!device || device.invalidated_at !== null) {
      // The device was unregistered or invalidated after the claim: a
      // known-dead token is finalized without poking it.
      await admin
        .from('notification_deliveries')
        .update({
          status: 'invalid_token',
          claimed_at: null,
          last_error: 'device unavailable',
          updated_at: now(),
        })
        .eq('delivery_id', row.delivery_id)
        .eq('status', 'sending');
      continue;
    }
    sendable.push({
      row,
      delivery: {
        delivery_id: row.delivery_id,
        event_id: row.event_id,
        device_id: row.device_id,
        recipient_user_id: row.recipient_user_id,
        event_type: row.event_type as PushableEventType,
        request_id: row.request_id,
        peer_display_name: row.peer_display_name,
        push_token: device.push_token,
      },
    });
  }
  if (sendable.length === 0) return null;

  const outcomes = await sender.send(
    sendable.map((entry) => buildPushMessage(entry.delivery)),
  );
  for (let i = 0; i < sendable.length; i++) {
    const outcome = outcomes[i];
    // A missing/short outcome array leaves the row 'sending' -> the stale
    // rule records result_unknown; it is never re-sent on a guess.
    if (outcome === undefined) continue;
    await recordSendOutcome(sendable[i].row, outcome);
  }
  return null;
}

async function checkReceipts(): Promise<Response | null> {
  const cutoff = new Date(Date.now() - RECEIPT_AFTER_MINUTES * 60_000).toISOString();
  const { data: sentRows, error } = await admin
    .from('notification_deliveries')
    .select('delivery_id, device_id, provider_ticket_id')
    .eq('status', 'sent')
    .not('provider_ticket_id', 'is', null)
    .lt('sent_at', cutoff)
    .limit(DISPATCH_BATCH_LIMIT);
  if (error) return text('dispatch receipts failed', 500);
  const rows = (sentRows ?? []) as SentRow[];
  if (rows.length === 0) return null;

  let receipts: Map<string, ReceiptOutcome>;
  try {
    receipts = await sender.fetchReceipts(rows.map((r) => r.provider_ticket_id));
  } catch {
    // Reading receipts is idempotent: rows stay 'sent' and the next run
    // tries again. This is not a redelivery of anything.
    return null;
  }
  for (const row of rows) {
    const outcome: ReceiptOutcome = receipts.get(row.provider_ticket_id) ?? {
      kind: 'pending',
    };
    if (outcome.kind === 'pending') continue; // not available yet
    const { status, last_error } = receiptOutcomeToStatus(outcome);
    const update: Record<string, unknown> = {
      status,
      claimed_at: null,
      updated_at: now(),
    };
    if (last_error !== null) update.last_error = last_error;
    await admin
      .from('notification_deliveries')
      .update(update)
      .eq('delivery_id', row.delivery_id)
      .eq('status', 'sent');
    if (status === 'invalid_token') await invalidateDevice(row.device_id);
  }
  return null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const denied = requireServiceCall(req);
  if (denied) return denied;

  const { data: claimId, error: claimError } = await admin.rpc(
    'claim_notification_dispatch',
    { p_claimed_by: 'notification-dispatch' },
  );
  if (claimError) return text('dispatch claim failed', 500);
  if (!claimId) return text('dispatch busy');

  try {
    const { error: generateError } = await admin.rpc(
      'generate_notification_deliveries',
    );
    if (generateError) return text('dispatch generate failed', 500);

    // Without a credential no batch is claimed at all: queued rows stay
    // pending for the first run that has one (zero network calls).
    if (sender.enabled) {
      const failure = await claimAndSend();
      if (failure) return failure;
    }

    const receiptFailure = await checkReceipts();
    if (receiptFailure) return receiptFailure;

    return text('dispatch ok');
  } finally {
    await admin.rpc('release_notification_dispatch', {
      p_claim_id: claimId,
    });
  }
});
