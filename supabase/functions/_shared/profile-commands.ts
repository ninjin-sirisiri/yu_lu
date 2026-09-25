// Task 7: profile publication command payloads (Edge side).
//
// Ownership: the fail-fast payload gate for the `update_profile` command
// plus the message constants the SQL handler raises byte-identically.
// Like Task 3's profile-validation gate, rejecting here is only fail-fast:
// public.app_command and command_boundary.update_profile_handler remain
// authoritative, so a bypassed gate cannot violate any rule.
//
// Payload shape (fixed by the operation boundary):
// - `base_version` is required and must be a JSON integer - the version
//   the client last saw. Whether it still matches is judged ONLY by the
//   database (compare-and-swap on profiles.profile_version); a stale base
//   is not an error here but a settled `status: 'conflict'` result that
//   the Edge boundary answers as HTTP 409 with the latest published
//   profile, its version and the differing fields.
// - `display_name`, `introduction`, `avatar_path` are the three editable
//   fields (app/src/profiles/edit.ts); at least one must be present.
//   `introduction: ''` clears the introduction, `avatar_path: null` clears
//   the image - both are valid payloads, so types are checked, not
//   presence-of-value.
// - avatar_path VALUE checks (shape `<actor>/<operation id>/<file>`,
//   ownership, existence in the bucket, JPEG/PNG/HEIC, <= 10MB) happen in
//   SQL only: they need the actor (derived from the verified JWT inside
//   the database, never from this envelope) and the storage rows. This
//   gate therefore type-checks avatar_path and nothing more - two gates
//   with two different predicates would drift.
// - Unknown fields are refused so a typo can never silently no-op a
//   version bump.

import {
  validateDisplayNameInput,
  validateIntroductionInput,
} from './profile-validation.ts';

export const PROFILE_COMMAND_KINDS = ['update_profile'] as const;

export type ProfileCommandKind = (typeof PROFILE_COMMAND_KINDS)[number];

/** Byte-identical to the strings raised by 0012's SQL handler. */
export const PROFILE_PUBLICATION_MESSAGES = {
  baseVersionRequired: 'base_version is required',
  baseVersionInteger: 'base_version must be an integer',
  fieldsRequired: 'display_name, introduction or avatar_path is required',
  displayNameType: 'display_name must be a string',
  introductionType: 'introduction must be a string',
  avatarPathType: 'avatar_path must be a string',
  conflict: 'profile version conflict',
} as const;

export const EDITABLE_PROFILE_PAYLOAD_FIELDS = [
  'display_name',
  'introduction',
  'avatar_path',
] as const;

function unknownFieldError(key: string): string {
  return `unknown field: ${key}`;
}

/**
 * Payload gate for `update_profile`. Returns the shared message to reject
 * with (HTTP 400), or null when the payload may proceed to the database.
 * The check order mirrors the SQL handler exactly: base_version -> unknown
 * fields -> at-least-one-field -> types -> values. Unknown kinds return
 * null - the handler registry is the source of truth for what exists.
 */
export function validateProfileCommandPayload(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  if (kind !== 'update_profile') return null;

  if (!('base_version' in payload)) {
    return PROFILE_PUBLICATION_MESSAGES.baseVersionRequired;
  }
  const base = payload['base_version'];
  if (typeof base !== 'number' || !Number.isInteger(base)) {
    return PROFILE_PUBLICATION_MESSAGES.baseVersionInteger;
  }

  const allowed = new Set<string>([
    'base_version',
    ...EDITABLE_PROFILE_PAYLOAD_FIELDS,
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) return unknownFieldError(key);
  }

  const hasField = EDITABLE_PROFILE_PAYLOAD_FIELDS.some((field) =>
    field in payload
  );
  if (!hasField) return PROFILE_PUBLICATION_MESSAGES.fieldsRequired;

  if (
    'display_name' in payload && typeof payload['display_name'] !== 'string'
  ) {
    return PROFILE_PUBLICATION_MESSAGES.displayNameType;
  }
  if (
    'introduction' in payload && typeof payload['introduction'] !== 'string'
  ) {
    return PROFILE_PUBLICATION_MESSAGES.introductionType;
  }
  if ('avatar_path' in payload) {
    const avatar = payload['avatar_path'];
    if (avatar !== null && typeof avatar !== 'string') {
      return PROFILE_PUBLICATION_MESSAGES.avatarPathType;
    }
  }

  // Value rules, same order as SQL (display name -> introduction).
  if ('display_name' in payload) {
    const result = validateDisplayNameInput(payload['display_name'] as string);
    if (!result.ok) return result.error;
  }
  if ('introduction' in payload) {
    const result = validateIntroductionInput(
      payload['introduction'] as string,
    );
    if (!result.ok) return result.error;
  }
  return null;
}
