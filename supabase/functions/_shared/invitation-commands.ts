// Task 6: invitation command payloads and the shared token contract (Edge side).
//
// Ownership: the fail-fast payload gate for the three invitation command
// kinds (`get_or_create_invitation`, `reissue_invitation`,
// `invalidate_invitation`), the optional `invitation_token` field on the
// Task 4 `request` command, and the `resolve_invitation` query field - plus
// every message string the SQL handlers in
// supabase/migrations/0011_invitation_lifecycle.sql raise byte-identically.
// Like Tasks 3-5, rejecting here is only fail-fast: public.app_command and
// public.app_query remain authoritative, so a bypassed gate cannot violate
// a rule. The three invitation commands carry NO payload fields; the gate
// exists so the kind set and future fields stay one place.
//
// Token contract (shared with the SQL side): 32 lowercase hex characters =
// 128 bits from the server's CSPRNG, looked up by EXACT equality only.
// There is no way to list invitations on either boundary - resolve needs
// the exact token, status reads only the caller's own row.

export const INVITATION_TOKEN_RE = /^[0-9a-f]{32}$/;

export const INVITATION_MESSAGES = {
  tokenRequired: 'invitation_token is required',
  tokenType: 'invitation_token must be a string',
  tokenFormat:
    'invitation_token must be a 32-character lowercase hexadecimal string',
  notFound: 'invitation not found',
  notForTarget: 'This invitation is for a different user.',
  invalidated: 'This invitation is no longer valid. Ask for a new invitation.',
  expired: 'This invitation expired. Ask for a new invitation.',
  notRegistered: 'Confirm the User ID before using the app.',
} as const;

export const INVITATION_COMMAND_KINDS = [
  'get_or_create_invitation',
  'reissue_invitation',
  'invalidate_invitation',
] as const;

export type InvitationCommandKind = (typeof INVITATION_COMMAND_KINDS)[number];

/**
 * Kind -> payload validation for the invitation command kinds. All three
 * take an empty payload today, so every kind returns null - the handler
 * registry is the source of truth for what exists, exactly like the
 * request gate. Unknown kinds return null for the same reason.
 */
export function validateInvitationCommandPayload(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  switch (kind) {
    case 'get_or_create_invitation':
    case 'reissue_invitation':
    case 'invalidate_invitation':
      return null;
    default:
      return null;
  }
}

/**
 * Shape check for an `invitation_token` field. `required` mirrors the SQL
 * reader (absent -> required message, null -> type message); when the
 * field is optional (the `request` command) absent and JSON null pass.
 * Returns the message to reject with (HTTP 400), or null when the field is
 * usable - existence and state are the database's judgement.
 */
export function readInvitationTokenField(
  payload: Record<string, unknown>,
  options: { required: boolean },
): string | null {
  if (!('invitation_token' in payload)) {
    return options.required ? INVITATION_MESSAGES.tokenRequired : null;
  }
  const value = payload['invitation_token'];
  if (!options.required && (value === undefined || value === null)) {
    return null;
  }
  if (typeof value !== 'string') return INVITATION_MESSAGES.tokenType;
  if (!INVITATION_TOKEN_RE.test(value)) return INVITATION_MESSAGES.tokenFormat;
  return null;
}
