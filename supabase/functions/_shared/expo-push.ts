// Task 18: Expo push adapter - a SEPARATE module from the dispatch logic.
//
// Ownership: talking to the Expo Push Service HTTP API (send + receipt
// lookup) and classifying every transport/API outcome. The dispatch worker
// (notification-dispatch/index.ts) only consumes the classified outcomes;
// tests inject a fake transport and NEVER touch the real Expo API, and no
// test fabricates a real-looking push token (fixtures are clearly marked
// fake values).
//
// Credentials: the default transport attaches `Authorization: Bearer
// $EXPO_ACCESS_TOKEN` and the sender reports `enabled = false` when no
// access token credential exists - in that state send() performs NO
// network calls (the worker hands queued rows back untouched instead).
//
// Outcome contract (see _shared/notifications.ts for the status mapping):
// - accepted          -> push ticket ok; ticket id stored for receipts
// - invalid_token     -> DeviceNotRegistered: stop sending to this token
// - rejected          -> the provider ANSWERED with a permanent error
//                        (4xx, or a ticket error): no automatic resend
// - retryable         -> the provider rejected WITHOUT accepting (429/5xx):
//                        a bounded retry (claim_notification_batch's 5
//                        attempts) is safe and honest
// - result_unknown    -> the response was lost or ambiguous AFTER the
//                        request may have been accepted: recorded as
//                        unknown and never re-sent automatically. Task 18
//                        deliberately does NOT claim exactly-once delivery
//                        for OS notifications.
// Receipts are read idempotently (Expo keeps them ~24h): a failed lookup
// leaves rows untouched and is retried on a later run - reading a receipt
// is never a redelivery.

export const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPT_ENDPOINT = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo accepts up to 100 messages per send request. */
export const EXPO_SEND_CHUNK = 100;
/** Expo accepts up to 1000 ids per receipt request. */
export const EXPO_RECEIPT_CHUNK = 1000;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  data: { event: string; request_id: string };
}

export type SendOutcome =
  | { kind: 'accepted'; ticketId: string }
  | { kind: 'invalid_token' }
  | { kind: 'rejected'; code: string }
  | { kind: 'retryable'; code: string }
  | { kind: 'result_unknown'; reason: string };

export type ReceiptOutcome =
  | { kind: 'delivered' }
  | { kind: 'invalid_token' }
  | { kind: 'rejected'; code: string }
  | { kind: 'pending' };

export interface PushHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type PushTransport = (request: {
  url: string;
  accessToken: string | null;
  body: unknown;
}) => Promise<PushHttpResponse>;

/** Real transport: plain fetch. Only ever reached with a credential. */
export const defaultPushTransport: PushTransport = (request) =>
  fetch(request.url, {
    method: 'POST',
    headers: {
      host: 'exp.host',
      accept: 'application/json',
      'content-type': 'application/json',
      ...(request.accessToken
        ? { Authorization: `Bearer ${request.accessToken}` }
        : {}),
    },
    body: JSON.stringify(request.body),
  });

export interface ExpoPushSender {
  /** False without an access token credential: send() makes no calls. */
  readonly enabled: boolean;
  send(messages: PushMessage[]): Promise<SendOutcome[]>;
  /** Idempotent receipt read; throws when the lookup itself failed. */
  fetchReceipts(ticketIds: string[]): Promise<Map<string, ReceiptOutcome>>;
}

function errorCodeOf(value: {
  details?: { error?: unknown } | undefined;
}): string {
  const detail = value.details?.error;
  if (typeof detail === 'string' && detail.length > 0) return detail;
  return 'unknown_error';
}

/** Classify one push ticket (Expo answers one per message, in order). */
export function classifyTicket(ticket: unknown): SendOutcome {
  if (typeof ticket !== 'object' || ticket === null) {
    return { kind: 'result_unknown', reason: 'missing push ticket' };
  }
  const t = ticket as {
    status?: unknown;
    id?: unknown;
    details?: { error?: unknown };
  };
  if (t.status === 'ok' && typeof t.id === 'string' && t.id.length > 0) {
    return { kind: 'accepted', ticketId: t.id };
  }
  if (t.status === 'error') {
    const code = errorCodeOf(t);
    if (code === 'DeviceNotRegistered') return { kind: 'invalid_token' };
    return { kind: 'rejected', code };
  }
  return { kind: 'result_unknown', reason: 'unrecognized push ticket' };
}

/** Classify one receipt entry (absent entry = not available yet). */
export function classifyReceipt(receipt: unknown): ReceiptOutcome {
  if (typeof receipt !== 'object' || receipt === null) {
    return { kind: 'pending' };
  }
  const r = receipt as { status?: unknown; details?: { error?: unknown } };
  if (r.status === 'ok') return { kind: 'delivered' };
  if (r.status === 'error') {
    const code = errorCodeOf(r);
    if (code === 'DeviceNotRegistered') return { kind: 'invalid_token' };
    return { kind: 'rejected', code };
  }
  return { kind: 'pending' };
}

export function createExpoPushSender(options: {
  accessToken?: string | null;
  transport?: PushTransport;
} = {}): ExpoPushSender {
  const accessToken = options.accessToken ?? null;
  const transport = options.transport ?? defaultPushTransport;
  const enabled = typeof accessToken === 'string' && accessToken.trim().length > 0;

  async function sendChunk(chunk: PushMessage[]): Promise<SendOutcome[]> {
    let res: PushHttpResponse;
    try {
      res = await transport({
        url: EXPO_PUSH_ENDPOINT,
        accessToken,
        body: chunk,
      });
    } catch (error) {
      // The request may already be sitting in Expo's queue: only the
      // response is lost. Record the unknown - never resend blindly.
      const reason = error instanceof Error ? error.message : String(error);
      return chunk.map(() => ({
        kind: 'result_unknown',
        reason: `response lost: ${reason}`,
      }));
    }
    if (res.ok) {
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return chunk.map(() => ({
          kind: 'result_unknown',
          reason: 'unreadable response body',
        }));
      }
      const data = (typeof payload === 'object' && payload !== null
        ? (payload as { data?: unknown }).data
        : undefined);
      if (!Array.isArray(data) || data.length !== chunk.length) {
        // Ambiguous shape: we cannot tell per message what happened.
        return chunk.map(() => ({
          kind: 'result_unknown',
          reason: 'unexpected response shape',
        }));
      }
      return data.map(classifyTicket);
    }
    if (res.status === 429 || res.status >= 500) {
      // Rejected WITHOUT accepting: a bounded retry is safe.
      return chunk.map(() => ({ kind: 'retryable', code: `HTTP ${res.status}` }));
    }
    // 4xx: malformed payload or bad credentials - retrying unchanged
    // cannot succeed.
    return chunk.map(() => ({ kind: 'rejected', code: `HTTP ${res.status}` }));
  }

  return {
    enabled,
    async send(messages: PushMessage[]): Promise<SendOutcome[]> {
      if (!enabled) {
        // No credential: no network call (the worker requeues instead).
        return messages.map(() => ({ kind: 'retryable', code: 'sender_disabled' }));
      }
      const outcomes: SendOutcome[] = [];
      for (let i = 0; i < messages.length; i += EXPO_SEND_CHUNK) {
        outcomes.push(...(await sendChunk(messages.slice(i, i + EXPO_SEND_CHUNK))));
      }
      return outcomes;
    },
    async fetchReceipts(ticketIds: string[]): Promise<Map<string, ReceiptOutcome>> {
      const out = new Map<string, ReceiptOutcome>();
      if (ticketIds.length === 0) return out;
      if (!enabled) {
        for (const id of ticketIds) out.set(id, { kind: 'pending' });
        return out;
      }
      for (let i = 0; i < ticketIds.length; i += EXPO_RECEIPT_CHUNK) {
        const chunk = ticketIds.slice(i, i + EXPO_RECEIPT_CHUNK);
        let res: PushHttpResponse;
        try {
          res = await transport({
            url: EXPO_RECEIPT_ENDPOINT,
            accessToken,
            body: { ids: chunk },
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`receipt lookup failed: ${reason}`);
        }
        if (!res.ok) {
          throw new Error(`receipt lookup failed: HTTP ${res.status}`);
        }
        let payload: unknown;
        try {
          payload = await res.json();
        } catch {
          throw new Error('receipt lookup failed: unreadable response body');
        }
        const data = (typeof payload === 'object' && payload !== null
          ? (payload as { data?: unknown }).data
          : undefined);
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
          throw new Error('receipt lookup failed: unexpected response shape');
        }
        const map = data as Record<string, unknown>;
        for (const id of chunk) {
          out.set(id, classifyReceipt(map[id]));
        }
      }
      return out;
    },
  };
}
