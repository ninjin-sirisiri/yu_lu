// Task 2: shared authentication helpers for the authenticated command boundary.
//
// Ownership: every function that acts on behalf of a user derives the actor
// here, from a JWT that Supabase Auth verifies (GET /auth/v1/user), never
// from request body fields. Checks fail closed: a missing or invalid
// credential produces 401 before any database work happens.
//
// `requireServiceCall` gates the scheduled service-to-service functions
// (request-expiry). The platform verify_jwt check already demands a
// project-signed Authorization header; this narrows that to the service
// credential itself, so an authenticated end user cannot trigger privileged
// jobs. If the credential is not configured the function stays locked. The
// comparison is constant time and the value is never logged.

export type GetUser = (token: string) => Promise<string | null>;

export interface Actor {
  actorId: string;
}

export function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function readBearer(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Default verifier: asks local/remote Auth whether the token is a live user session. */
export const defaultGetUser: GetUser = async (token: string): Promise<string | null> => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY') ??
    Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === 'string' && body.id.length > 0 ? body.id : null;
  } catch {
    return null;
  }
};

/**
 * Resolve the verified actor for a request, or return a 401 Response.
 * Inject `getUser` in tests; the default performs the real Auth lookup.
 */
export async function requireActor(
  req: Request,
  getUser: GetUser = defaultGetUser,
): Promise<Actor | Response> {
  const token = readBearer(req);
  if (!token) return jsonError(401, 'authentication required');
  let actorId: string | null = null;
  try {
    actorId = await getUser(token);
  } catch {
    actorId = null;
  }
  if (!actorId) return jsonError(401, 'invalid or expired session');
  return { actorId };
}

/** Constant-time string comparison so credential checks do not leak timing. */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Gate for scheduled/service-to-service functions. Returns null when the
 * request presents the expected service credential as its Bearer token,
 * otherwise a 401 Response. Fails closed when no credential is configured.
 * The expected value is never echoed or logged.
 */
export function requireServiceCall(
  req: Request,
  expected?: string,
): Response | null {
  const credential = expected ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const token = readBearer(req);
  if (!credential || !token || !constantTimeEquals(token, credential)) {
    return jsonError(401, 'service credential required');
  }
  return null;
}
