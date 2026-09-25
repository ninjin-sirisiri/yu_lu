import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Task 5: client adapter for the app-query read boundary.
//
// Ownership: one place that knows the wire contract of the `app-query`
// Edge Function (snake_case, `{op, result}` envelope, opaque cursor
// strings) and hands the rest of the app camelCase domain objects. The
// adapter never re-implements server rules: ordering, paging, privacy
// (self/block exclusion, streak visibility, rejection masking) are the
// server's, and this file only preserves them - notably it copies the
// `streak` key through only when the server sent one, so a DTO without a
// streak can never grow one locally. `defaultClient()` follows the
// existing module convention (EXPO_PUBLIC_SUPABASE_URL / ANON_KEY); tests
// inject a fake client.

const url = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;

function defaultClient(): SupabaseClient {
  return createClient(url, anon);
}

export type QueryOp =
  | 'search_profiles'
  | 'get_profile'
  | 'list_friends'
  | 'list_requests';

export type RequestDirection = 'incoming' | 'outgoing';

export type Relationship =
  | 'self'
  | 'friend'
  | 'request_outgoing'
  | 'request_incoming'
  | 'none';

/** `ended` is the sender-facing neutral form of a rejection (Task 4). */
export type RequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'ended';

export interface ProfileSummary {
  userId: string;
  userIdText: string;
  displayName: string;
  avatarPath: string | null;
}

export interface ProfileDetail extends ProfileSummary {
  introduction: string | null;
  relationship: Relationship;
  /** The streak count, present ONLY for friends and for the actor's own
   *  profile. The server omits the key entirely otherwise. */
  streak?: number;
}

export interface RequestEntry {
  requestId: string;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
  /** Null while pending; the end moment for ended rows (rejection stays
   *  neutral - no reason field exists anywhere in the DTO). */
  endedAt: string | null;
  counterpart: ProfileSummary;
}

export interface QueryPage<T> {
  items: T[];
  /** Opaque cursor for the next page, or null on the last page. */
  nextCursor: string | null;
}

export class QueryError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'QueryError';
    this.status = status;
  }
}

interface WireProfile {
  user_id: string;
  user_id_text: string;
  display_name: string;
  avatar_path: string | null;
  introduction?: string | null;
  relationship?: string;
  streak?: number;
}

interface WirePage<T> {
  items: T[];
  next_cursor: string | null;
}

interface WireRequest {
  request_id: string;
  status: string;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
  counterpart: WireProfile;
}

interface WireEnvelope {
  op?: unknown;
  result?: unknown;
}

function toSummary(wire: WireProfile): ProfileSummary {
  return {
    userId: wire.user_id,
    userIdText: wire.user_id_text,
    displayName: wire.display_name,
    avatarPath: wire.avatar_path,
  };
}

function toDetail(wire: WireProfile): ProfileDetail {
  const detail: ProfileDetail = {
    ...toSummary(wire),
    introduction: wire.introduction ?? null,
    relationship: (wire.relationship ?? 'none') as Relationship,
  };
  // Copy the streak through only when the server sent a number: a DTO for
  // a non-friend structurally stays without one.
  if (typeof wire.streak === 'number') {
    detail.streak = wire.streak;
  }
  return detail;
}

function toRequest(wire: WireRequest): RequestEntry {
  return {
    requestId: wire.request_id,
    status: wire.status as RequestStatus,
    createdAt: wire.created_at,
    expiresAt: wire.expires_at,
    endedAt: wire.ended_at,
    counterpart: toSummary(wire.counterpart),
  };
}

async function readError(error: unknown): Promise<QueryError> {
  let message = error instanceof Error ? error.message : 'query failed';
  let status = 0;
  const context = (error as { context?: unknown } | null)?.context;
  if (context !== null && typeof context === 'object') {
    const candidate = context as { status?: unknown; json?: unknown };
    if (typeof candidate.status === 'number') {
      status = candidate.status;
    }
    if (typeof candidate.json === 'function') {
      try {
        const body = await (candidate.json as () => Promise<unknown>)();
        if (
          body !== null &&
          typeof body === 'object' &&
          typeof (body as { error?: unknown }).error === 'string'
        ) {
          message = (body as { error: string }).error;
        }
      } catch {
        // Keep the fallback message when the error body is unreadable.
      }
    }
  }
  return new QueryError(message, status);
}

async function invokeQuery<T>(
  op: QueryOp,
  payload: Record<string, unknown>,
  client: SupabaseClient,
): Promise<T> {
  const { data, error } = await client.functions.invoke('app-query', {
    body: { op, payload },
  });
  if (error) throw await readError(error);
  const envelope = data as WireEnvelope | null;
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    !('result' in envelope)
  ) {
    throw new QueryError('unexpected query response', 0);
  }
  return envelope.result as T;
}

export async function searchProfiles(
  query: string,
  cursor: string | null = null,
  client: SupabaseClient = defaultClient(),
): Promise<QueryPage<ProfileDetail>> {
  const page = await invokeQuery<WirePage<WireProfile>>(
    'search_profiles',
    { query, cursor },
    client,
  );
  return {
    items: (page.items ?? []).map(toDetail),
    nextCursor: page.next_cursor ?? null,
  };
}

export async function getProfile(
  userId: string,
  client: SupabaseClient = defaultClient(),
): Promise<ProfileDetail> {
  const wire = await invokeQuery<WireProfile>(
    'get_profile',
    { user_id: userId },
    client,
  );
  return toDetail(wire);
}

export async function listFriends(
  cursor: string | null = null,
  client: SupabaseClient = defaultClient(),
): Promise<QueryPage<ProfileDetail>> {
  const page = await invokeQuery<WirePage<WireProfile>>(
    'list_friends',
    { cursor },
    client,
  );
  return {
    items: (page.items ?? []).map(toDetail),
    nextCursor: page.next_cursor ?? null,
  };
}

export async function listRequests(
  direction: RequestDirection,
  cursor: string | null = null,
  client: SupabaseClient = defaultClient(),
): Promise<QueryPage<RequestEntry>> {
  const page = await invokeQuery<WirePage<WireRequest>>(
    'list_requests',
    { direction, cursor },
    client,
  );
  return {
    items: (page.items ?? []).map(toRequest),
    nextCursor: page.next_cursor ?? null,
  };
}
