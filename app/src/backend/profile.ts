import type { SupabaseClient } from '@supabase/supabase-js';

import { validImageSize } from '../media/images';
import { getAppClient } from './client';

// Task 7: client adapter for profile publication (write side) and the
// dedicated profile-image upload flow.
//
// Ownership: one place that knows the wire contract of the
// `update_profile` command on the app-command boundary (snake_case
// payload with `base_version`, the structured HTTP 409
// `{error, conflict}` body) and of the `profile-images` bucket layout
// (`<actor uuid>/<operation id>/<file name>`). The adapter never
// re-implements server rules: existence, ownership, accepted format, size
// and the version compare-and-swap are re-verified by the database, so
// the checks here only fail fast with wording shared with the server.
//
// Upload is NOT publication: `uploadProfileImage` only places bytes in
// the caller's own folder and returns the path; nothing is publicly
// visible until `update_profile` publishes that path in ONE command (the
// server rejects text+image split flows, and a failed or conflicted
// publication leaves every field unchanged). Conflict handling is a
// result value, not an exception, because Task 17's conflict screen needs
// the latest published fields, the current version and the differing
// fields - exactly what the 409 body carries.
//
// `defaultClient()` shares AuthProvider's persisted session; tests inject a fake client.

function defaultClient(): SupabaseClient {
  return getAppClient();
}

export const PROFILE_IMAGE_BUCKET = 'profile-images';

/** Content types the server accepts for a referenced profile image. */
export const PROFILE_IMAGE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
] as const;

export type ProfileImageContentType = (typeof PROFILE_IMAGE_CONTENT_TYPES)[number];

/** Body types storage upload accepts in React Native / web builds. */
export type ProfileImageBody = ArrayBuffer | ArrayBufferView | Blob | FormData;

/** Byte size is validated with the shared 10MB rule (media/images.ts). */
export const PROFILE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export class ProfileUpdateError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProfileUpdateError';
    this.status = status;
  }
}

export interface ProfilePublicationFields {
  displayName: string;
  introduction: string | null;
  avatarPath: string | null;
}

export interface ProfilePublication extends ProfilePublicationFields {
  profileVersion: number;
  /**
   * The visible User ID of the confirmed row (Task 17: the edit screen
   * shows it read-only — User ID is immutable after confirmation, so it
   * rides along with the own-row read instead of costing a second query).
   */
  userIdText: string | null;
}

export interface ProfileUpdateInput {
  /** The profile_version the client last saw (compare-and-swap base). */
  baseVersion: number;
  /** Absent fields keep their published value. */
  displayName?: string;
  /** `''` clears the introduction; absent keeps the published value. */
  introduction?: string;
  /** `null` clears the image; absent keeps the published value. */
  avatarPath?: string | null;
}

export type ProfileUpdateResult =
  | { status: 'updated'; version: number; profile: ProfilePublicationFields }
  | {
    status: 'conflict';
    message: string;
    /** The latest published version (the base the next attempt needs). */
    version: number;
    /** The latest published fields - unchanged by this operation. */
    profile: ProfilePublicationFields;
    /** Submitted fields that differ from the published content. */
    differingFields: string[];
  };

export interface ProfileImageUpload {
  /** Single path segment: no `/`, not `.` or `..`. */
  fileName: string;
  contentType: string;
  data: ProfileImageBody;
  /** Optional pre-known size; validated against the 10MB rule. */
  sizeBytes?: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Build the storage path for a profile image: strictly actor- and
 * operation-scoped, so a user can never reference a path outside their
 * own account (the server enforces the same shape).
 */
export function profileImagePath(
  userId: string,
  operationId: string,
  fileName: string,
): string {
  if (!UUID_RE.test(userId)) {
    throw new ProfileUpdateError('avatar_path must be an image path under your account', 400);
  }
  if (!UUID_RE.test(operationId)) {
    throw new ProfileUpdateError('avatar_path must be an image path under your account', 400);
  }
  if (
    fileName === '' || fileName === '.' || fileName === '..' ||
    fileName.includes('/')
  ) {
    throw new ProfileUpdateError('avatar_path must be an image path under your account', 400);
  }
  return `${userId}/${operationId}/${fileName}`;
}

function assertUploadShape(upload: ProfileImageUpload): void {
  if (!PROFILE_IMAGE_CONTENT_TYPES.includes(
    upload.contentType as ProfileImageContentType,
  )) {
    throw new ProfileUpdateError(
      'Profile image must be a JPEG, PNG, or HEIC image.',
      400,
    );
  }
  if (upload.sizeBytes !== undefined && !validImageSize(upload.sizeBytes)) {
    throw new ProfileUpdateError('Profile image must be 10MB or smaller.', 400);
  }
}

async function requireUserId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    throw new ProfileUpdateError('authentication required', 401);
  }
  return data.user.id;
}

/**
 * Upload one profile image into the caller's own
 * `<user id>/<operation id>/<file name>` folder. Success returns the
 * storage path - it publishes nothing; pass the path to `updateProfile`
 * to make it part of the published profile. Re-uploading the same path is
 * an idempotent overwrite (`upsert: true`), so a retried operation never
 * fails on "already exists".
 */
export async function uploadProfileImage(
  operationId: string,
  upload: ProfileImageUpload,
  client: SupabaseClient = defaultClient(),
): Promise<string> {
  assertUploadShape(upload);
  const userId = await requireUserId(client);
  const path = profileImagePath(userId, operationId, upload.fileName);
  const { error } = await client.storage.from(PROFILE_IMAGE_BUCKET).upload(
    path,
    upload.data,
    { contentType: upload.contentType, upsert: true },
  );
  if (error) {
    throw new ProfileUpdateError(error.message, 0);
  }
  return path;
}

interface WireProfileFields {
  display_name: string;
  introduction: string | null;
  avatar_path: string | null;
}

interface WireConflict {
  status: string;
  message?: string;
  version: number;
  profile: WireProfileFields;
  differing_fields?: string[];
}

function toFields(wire: WireProfileFields): ProfilePublicationFields {
  return {
    displayName: wire.display_name,
    introduction: wire.introduction ?? null,
    avatarPath: wire.avatar_path ?? null,
  };
}

function toConflict(wire: WireConflict): ProfileUpdateResult {
  return {
    status: 'conflict',
    message: typeof wire.message === 'string'
      ? wire.message
      : 'profile version conflict',
    version: wire.version,
    profile: toFields(wire.profile),
    differingFields: Array.isArray(wire.differing_fields)
      ? wire.differing_fields
      : [],
  };
}

interface InvokeErrorLike {
  message?: unknown;
  context?: unknown;
}

/** Extract {status, message, body} from a supabase-js functions error. */
async function readInvokeError(error: unknown): Promise<{
  status: number;
  message: string;
  body: Record<string, unknown> | null;
}> {
  let status = 0;
  let message = error instanceof Error ? error.message : 'command failed';
  let body: Record<string, unknown> | null = null;
  const context = (error as InvokeErrorLike | null)?.context;
  if (context !== null && typeof context === 'object') {
    const candidate = context as { status?: unknown; json?: unknown };
    if (typeof candidate.status === 'number') status = candidate.status;
    if (typeof candidate.json === 'function') {
      try {
        const parsed = await (candidate.json as () => Promise<unknown>)();
        if (
          parsed !== null && typeof parsed === 'object' &&
          !Array.isArray(parsed)
        ) {
          body = parsed as Record<string, unknown>;
          if (typeof body['error'] === 'string') message = body['error'];
        }
      } catch {
        // Keep the fallback message when the error body is unreadable.
      }
    }
  }
  return { status, message, body };
}

function toResult(data: unknown): ProfileUpdateResult {
  const envelope = data as { result?: unknown } | null;
  const result = envelope?.result as WireConflict | undefined;
  if (
    result === null || typeof result !== 'object' ||
    typeof result.version !== 'number' ||
    typeof result.profile !== 'object' || result.profile === null
  ) {
    throw new ProfileUpdateError('unexpected command response', 0);
  }
  if (result.status === 'conflict') return toConflict(result);
  if (result.status === 'updated') {
    return {
      status: 'updated',
      version: result.version,
      profile: toFields(result.profile),
    };
  }
  throw new ProfileUpdateError('unexpected command response', 0);
}

/**
 * Publish the profile through the `update_profile` command. Only the
 * fields present in `input` are sent (absent fields keep their published
 * value); `base_version` must match the current published version or the
 * result is a `conflict` carrying the latest published content, its
 * version and the differing fields - the caller rebases and saves a NEW
 * operation (Task 9), it never reuses this operation id for a changed
 * payload. The database rejects stale images (missing, foreign, wrong
 * format, oversized) with HTTP 400 and leaves every field unchanged.
 */
export async function updateProfile(
  operationId: string,
  input: ProfileUpdateInput,
  client: SupabaseClient = defaultClient(),
): Promise<ProfileUpdateResult> {
  const payload: Record<string, unknown> = { base_version: input.baseVersion };
  if (input.displayName !== undefined) payload['display_name'] = input.displayName;
  if (input.introduction !== undefined) payload['introduction'] = input.introduction;
  if (input.avatarPath !== undefined) payload['avatar_path'] = input.avatarPath;

  const { data, error } = await client.functions.invoke('app-command', {
    body: { operation_id: operationId, kind: 'update_profile', payload },
  });

  if (error) {
    const { status, message, body } = await readInvokeError(error);
    const conflict = body?.['conflict'] as WireConflict | undefined;
    if (status === 409 && conflict && conflict.status === 'conflict') {
      return toConflict(conflict);
    }
    throw new ProfileUpdateError(message, status);
  }
  return toResult(data);
}

interface WireOwnProfileRow {
  display_name: string;
  introduction: string | null;
  avatar_path: string | null;
  profile_version: number;
  user_id_text: string | null;
}

/**
 * Read the actor's own publication state (the Data API owner-read path),
 * mainly to obtain the `base_version` for the next `updateProfile`.
 */
export async function getOwnPublication(
  client: SupabaseClient = defaultClient(),
): Promise<ProfilePublication> {
  const userId = await requireUserId(client);
  const { data, error } = await client
    .from('profiles')
    .select('display_name, introduction, avatar_path, profile_version, user_id_text')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new ProfileUpdateError(error.message, 0);
  if (!data) throw new ProfileUpdateError('profile not found', 404);
  const row = data as WireOwnProfileRow;
  return {
    ...toFields(row),
    profileVersion: row.profile_version,
    userIdText: row.user_id_text ?? null,
  };
}

/** Lifetime of the short-lived signed URL used to preview an own avatar. */
export const PROFILE_IMAGE_URL_TTL_SECONDS = 600;

/**
 * A short-lived signed URL for a published profile image, or null when the
 * bucket cannot sign it (offline, path unknown). The bucket is private
 * (Task 7): upload is never publication and only a confirmed profile row
 * opens the read — a signed URL therefore only ever exists for the caller
 * to PREVIEW an image; failing to sign degrades to "no preview", never to
 * a fabricated placeholder path.
 */
export async function profileImageUrl(
  path: string,
  client: SupabaseClient = defaultClient(),
): Promise<string | null> {
  if (path === '') return null;
  const { data, error } = await client.storage
    .from(PROFILE_IMAGE_BUCKET)
    .createSignedUrl(path, PROFILE_IMAGE_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
