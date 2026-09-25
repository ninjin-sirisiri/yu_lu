// Task 5: query execution over the `public.app_query` RPC.
//
// Ownership: the read counterpart of _shared/commands.ts - envelope
// validation, the fail-fast payload gate, the RPC transport and the HTTP
// error contract for the read boundary. `parseQueryBody` rejects malformed
// envelopes before any database work; `validateQueryPayload` applies the
// per-op field rules with messages byte-identical to the SQL handlers in
// supabase/migrations/0010_discovery_queries.sql - the database remains
// the authority (a bypassed gate still gets the same 400 from the RPC).
// `mapRpcError` (Task 2) maps SQLSTATEs to statuses, so 42501 becomes 403
// (unregistered actor), P0002 becomes 404 (hidden profile), 22023 becomes
// 400 (payload/cursor), and everything else stays a generic 500 with no
// database internals. Cursors are opaque strings: this layer only checks
// that they are strings, never their format.
//
// The handler factory takes injectable dependencies so tests exercise the
// real control flow offline; index.ts serves the default wiring. Queries
// carry no actor field - the Authorization header is forwarded verbatim so
// the database derives the actor from the same verified JWT.

import { jsonError, requireActor } from './auth.ts';
import {
  mapRpcError,
  UUID_RE,
  type RpcOutcome,
} from './commands.ts';

export const QUERY_OPS = [
  'search_profiles',
  'get_profile',
  'list_friends',
  'list_requests',
] as const;

export type QueryOp = (typeof QUERY_OPS)[number];

export const QUERY_MESSAGES = {
  opRequired: 'op is required',
  opType: 'op must be a string',
  opFormat: 'op must match ^[a-z][a-z0-9_]{0,62}$',
  payloadObject: 'payload must be a JSON object',
  invalidJson: 'invalid JSON body',
  queryRequired: 'query is required',
  queryType: 'query must be a string',
  queryEmpty: 'query must not be empty',
  cursorType: 'cursor must be a string or null',
  userIdRequired: 'user_id is required',
  userIdType: 'user_id must be a string',
  userIdUuid: 'user_id must be a UUID',
  directionRequired: 'direction is required',
  directionType: 'direction must be a string',
  directionValue: "direction must be 'incoming' or 'outgoing'",
  cursorInvalid: 'invalid cursor',
  cursorMismatch: 'cursor does not match this query',
  notRegistered: 'Confirm the User ID before using the app.',
  targetNotFound: 'Target user not found.',
} as const;

export const OP_RE = /^[a-z][a-z0-9_]{0,62}$/;

export const REQUEST_DIRECTIONS = ['incoming', 'outgoing'] as const;

export type RequestDirection = (typeof REQUEST_DIRECTIONS)[number];

export interface QueryRequest {
  op: string;
  payload: Record<string, unknown>;
}

export interface QueryRpcArgs {
  p_op: string;
  p_payload: Record<string, unknown>;
}

export type QueryTransport = (
  args: QueryRpcArgs,
  authorization: string,
) => Promise<RpcOutcome>;

export function parseQueryBody(
  body: unknown,
): { ok: true; value: QueryRequest } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;

  if (!('op' in record)) return { ok: false, error: QUERY_MESSAGES.opRequired };
  const op = record['op'];
  if (typeof op !== 'string') return { ok: false, error: QUERY_MESSAGES.opType };
  if (!OP_RE.test(op)) return { ok: false, error: QUERY_MESSAGES.opFormat };

  const payload = record['payload'];
  if (
    typeof payload !== 'object' || payload === null || Array.isArray(payload)
  ) {
    return { ok: false, error: QUERY_MESSAGES.payloadObject };
  }

  return {
    ok: true,
    value: { op, payload: payload as Record<string, unknown> },
  };
}

function readStringField(
  payload: Record<string, unknown>,
  key: string,
  required: string,
  typeError: string,
): string | null {
  if (!(key in payload)) return required;
  if (typeof payload[key] !== 'string') return typeError;
  return null;
}

function readOptionalStringField(
  payload: Record<string, unknown>,
  key: string,
  typeError: string,
): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return typeError;
  return null;
}

/**
 * Op -> payload validation. Field order matches the SQL handlers exactly,
 * so both layers reject the same input with the same message. Unknown ops
 * return null - the closed op list in public.app_query is the source of
 * truth for what exists (Task 4's registry pattern, minus the registry
 * table because the op set is static).
 */
export function validateQueryPayload(
  op: string,
  payload: Record<string, unknown>,
): string | null {
  switch (op) {
    case 'search_profiles': {
      const required = readStringField(
        payload,
        'query',
        QUERY_MESSAGES.queryRequired,
        QUERY_MESSAGES.queryType,
      );
      if (required !== null) return required;
      if ((payload['query'] as string).trim() === '') {
        return QUERY_MESSAGES.queryEmpty;
      }
      return readOptionalStringField(
        payload,
        'cursor',
        QUERY_MESSAGES.cursorType,
      );
    }
    case 'get_profile': {
      if (!('user_id' in payload)) return QUERY_MESSAGES.userIdRequired;
      const value = payload['user_id'];
      if (typeof value !== 'string') return QUERY_MESSAGES.userIdType;
      if (!UUID_RE.test(value)) return QUERY_MESSAGES.userIdUuid;
      return null;
    }
    case 'list_friends':
      return readOptionalStringField(
        payload,
        'cursor',
        QUERY_MESSAGES.cursorType,
      );
    case 'list_requests': {
      const required = readStringField(
        payload,
        'direction',
        QUERY_MESSAGES.directionRequired,
        QUERY_MESSAGES.directionType,
      );
      if (required !== null) return required;
      const direction = payload['direction'] as string;
      if (
        !(REQUEST_DIRECTIONS as readonly string[]).includes(direction)
      ) {
        return QUERY_MESSAGES.directionValue;
      }
      return readOptionalStringField(
        payload,
        'cursor',
        QUERY_MESSAGES.cursorType,
      );
    }
    default:
      return null;
  }
}

/** Default transport: one PostgREST RPC call with the caller's JWT forwarded. */
export const defaultQueryTransport: QueryTransport = async (
  args: QueryRpcArgs,
  authorization: string,
): Promise<RpcOutcome> => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY') ??
    Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) {
    return { ok: false, code: null, message: 'query endpoint is not configured' };
  }
  try {
    const res = await fetch(`${url}/rest/v1/rpc/app_query`, {
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
        return { ok: false, code: null, message: 'unexpected query response' };
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
        : 'query execution failed',
    };
  } catch {
    return { ok: false, code: null, message: 'query execution failed' };
  }
};

/**
 * Validate the envelope and execute one query through the RPC. The
 * request's Authorization header is forwarded verbatim so the database
 * derives the actor from the same verified JWT.
 */
export async function executeQuery(
  req: Request,
  authorization: string,
  transport: QueryTransport = defaultQueryTransport,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, QUERY_MESSAGES.invalidJson);
  }

  const parsed = parseQueryBody(raw);
  if (!parsed.ok) return jsonError(400, parsed.error);

  const payloadError = validateQueryPayload(
    parsed.value.op,
    parsed.value.payload,
  );
  if (payloadError !== null) return jsonError(400, payloadError);

  const outcome = await transport(
    { p_op: parsed.value.op, p_payload: parsed.value.payload },
    authorization,
  );

  if (!outcome.ok) {
    const mapped = mapRpcError(outcome.code);
    return jsonError(
      mapped.status,
      mapped.expose ? outcome.message : 'query execution failed',
    );
  }

  return new Response(JSON.stringify(outcome.data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export interface QueryHandlerDeps {
  requireActor: typeof requireActor;
  executeQuery: typeof executeQuery;
}

/**
 * The HTTP read boundary: method check -> verified actor (401 before
 * anything else) -> envelope validation plus one `public.app_query` RPC
 * call. Same shape as app-command's handler factory.
 */
export function createQueryHandler(
  overrides: Partial<QueryHandlerDeps> = {},
): (req: Request) => Promise<Response> {
  const deps: QueryHandlerDeps = {
    requireActor: overrides.requireActor ?? requireActor,
    executeQuery: overrides.executeQuery ?? executeQuery,
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return jsonError(405, 'method not allowed');
    }
    const actor = await deps.requireActor(req);
    if (actor instanceof Response) return actor;
    const authorization = req.headers.get('authorization');
    if (!authorization) return jsonError(401, 'authentication required');
    return deps.executeQuery(req, authorization);
  };
}

export const handler = createQueryHandler();
