// Task 2: command execution over the `public.app_command` RPC.
//
// Ownership: envelope validation, the RPC transport, and the HTTP error
// contract for the write boundary. `parseCommandBody` rejects malformed
// commands before they reach the database; `validateCommandPayload` (Task 3)
// applies the shared input rules to the kinds that have registered them,
// failing fast with the same 400 message the SQL handler would raise - the
// database remains the authority. `mapRpcError` turns known
// SQLSTATEs into HTTP statuses (409 operation conflict, 400 validation,
// 403 privilege) and hides everything else behind a generic 500 so raw
// database internals never reach a client. Task 7 adds one structured
// outcome: a settled `result.status = 'conflict'` is answered as HTTP 409
// with `{error, conflict}` because the conflict payload (latest published
// profile + version + differing fields) does not fit a message-only body.
// The transport is injectable for tests; the default one forwards the
// caller's verified Authorization
// header so the database derives the actor from the same JWT — no actor
// field exists anywhere in this envelope.

import { jsonError } from './auth.ts';
import { validateCommandPayload } from './profile-validation.ts';
import { validateInvitationCommandPayload } from './invitation-commands.ts';
import { validateProfileCommandPayload } from './profile-commands.ts';
import { validateRequestCommandPayload } from './request-commands.ts';
import { prepareChatMedia, type MediaBackend } from './chat-media.ts';

export interface CommandRequest {
  operationId: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface RpcArgs {
  p_operation_id: string;
  p_kind: string;
  p_payload: Record<string, unknown>;
}

export type RpcOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: string | null; message: string };

export type RpcTransport = (
  args: RpcArgs,
  authorization: string,
) => Promise<RpcOutcome>;

export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const KIND_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function parseCommandBody(
  body: unknown,
): { ok: true; value: CommandRequest } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;

  const operationId = record['operation_id'];
  if (typeof operationId !== 'string' || !UUID_RE.test(operationId)) {
    return { ok: false, error: 'operation_id must be a UUID' };
  }

  const kind = record['kind'];
  if (typeof kind !== 'string' || !KIND_RE.test(kind)) {
    return { ok: false, error: 'kind must match ^[a-z][a-z0-9_]{0,62}$' };
  }

  const payload = record['payload'];
  if (
    typeof payload !== 'object' || payload === null || Array.isArray(payload)
  ) {
    return { ok: false, error: 'payload must be a JSON object' };
  }

  return {
    ok: true,
    value: {
      operationId,
      kind,
      payload: payload as Record<string, unknown>,
    },
  };
}

/**
 * Map RPC SQLSTATEs to the HTTP contract. `expose: true` forwards the
 * server message (these are boundary-authored messages: conflicts and
 * validation); everything else falls back to a generic 500 body.
 *
 * Task 4 adds P0002 (no_data_found): request commands raise it when the
 * named request row or target user does not exist (or is not visible to
 * the actor), which is a 404 - never a 500.
 */
export function mapRpcError(code: string | null): {
  status: number;
  expose: boolean;
} {
  switch (code) {
    case '23505':
      return { status: 409, expose: true };
    case '22023':
      return { status: 400, expose: true };
    case '42501':
      return { status: 403, expose: true };
    case 'P0002':
      return { status: 404, expose: true };
    default:
      return { status: 500, expose: false };
  }
}

/** Default transport: one PostgREST RPC call with the caller's JWT forwarded. */
export const defaultTransport: RpcTransport = async (
  args: RpcArgs,
  authorization: string,
): Promise<RpcOutcome> => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY') ??
    Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) {
    return { ok: false, code: null, message: 'command endpoint is not configured' };
  }
  try {
    const res = await fetch(`${url}/rest/v1/rpc/app_command`, {
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
    if (res.ok) {
      const data = body as Record<string, unknown> | null;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return { ok: false, code: null, message: 'unexpected command response' };
      }
      return { ok: true, data };
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
        : 'command execution failed',
    };
  } catch {
    return { ok: false, code: null, message: 'command execution failed' };
  }
};

/**
 * Validate the envelope and execute one command through the RPC. The
 * request's Authorization header is forwarded verbatim so the database
 * derives the actor from the same verified JWT.
 */
export async function executeCommand(
  req: Request,
  authorization: string,
  transport: RpcTransport = defaultTransport,
  context?: { actorId: string; mediaBackend?: MediaBackend },
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'invalid JSON body');
  }

  const parsed = parseCommandBody(raw);
  if (!parsed.ok) return jsonError(400, parsed.error);

  // This kind must never reach app_command: only the HTTP boundary has verified
  // the actor and can inspect staging bytes using a server-only Storage client.
  if (parsed.value.kind === 'prepare_chat_media') {
    if (!context?.actorId) return jsonError(403, 'verified media actor required');
    return prepareChatMedia(context.actorId, parsed.value.payload, context.mediaBackend);
  }

  const payloadError = validateCommandPayload(
    parsed.value.kind,
    parsed.value.payload,
  ) ?? validateRequestCommandPayload(
    parsed.value.kind,
    parsed.value.payload,
  ) ?? validateInvitationCommandPayload(
    parsed.value.kind,
    parsed.value.payload,
  ) ?? validateProfileCommandPayload(
    parsed.value.kind,
    parsed.value.payload,
  );
  if (payloadError !== null) return jsonError(400, payloadError);

  const outcome = await transport(
    {
      p_operation_id: parsed.value.operationId,
      p_kind: parsed.value.kind,
      p_payload: parsed.value.payload,
    },
    authorization,
  );

  if (!outcome.ok) {
    const mapped = mapRpcError(outcome.code);
    return jsonError(
      mapped.status,
      mapped.expose ? outcome.message : 'command execution failed',
    );
  }

  // Structured state conflicts (Task 7): a handler that reports
  // `result.status = 'conflict'` has settled the operation WITHOUT
  // changing anything and carries data a message-only error body cannot
  // hold (the latest published profile, its version, the differing
  // fields). The boundary answers 409 with `{error, conflict}` so conflict
  // screens get the payload; every other outcome stays a 200 envelope,
  // including replays of a stored conflict.
  const settled = outcome.data['result'];
  if (isStateConflictResult(settled)) {
    const conflict = settled as Record<string, unknown>;
    const message = typeof conflict['message'] === 'string'
      ? conflict['message']
      : 'conflict';
    return new Response(JSON.stringify({ error: message, conflict }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(outcome.data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** True when a settled handler result is the boundary's conflict shape. */
export function isStateConflictResult(result: unknown): boolean {
  return typeof result === 'object' &&
    result !== null &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>)['status'] === 'conflict';
}
