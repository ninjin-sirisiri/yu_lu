// Task 4: shared friend-request command payloads (Edge side).
//
// Ownership: the fail-fast payload gate for the four request command kinds
// (`request`, `approve`, `reject`, `cancel`) plus the message constants the
// SQL handlers raise byte-identically. Like Task 3's profile-validation
// gate, rejecting here is only fail-fast: public.app_command and its
// handlers remain authoritative, so a bypassed gate cannot violate any
// rule. The payload shapes are fixed by the operation boundary:
// - `request` carries `target_user_id` (the peer's uuid) - never the
//   actor's own id (the SQL handler re-checks self requests because the
//   gate here has no actor).
// - decision kinds carry `request_id`; identity (existence + participant
//   role) is validated by the SQL handler against the row itself, so a
//   stale id from before a re-request never applies to the newer row.
// - Task 6: `request` also accepts an OPTIONAL `invitation_token` (apply
//   through an invitation). This gate only shape-checks it; whether the
//   token exists, belongs to the target, is valid and unexpired is judged
//   by the SQL handler against server state at request time, so a reissue
//   after the confirm screen cannot be bypassed.

import { UUID_RE } from './commands.ts';
import { readInvitationTokenField } from './invitation-commands.ts';

export const REQUEST_MESSAGES = {
  targetRequired: 'target_user_id is required',
  targetType: 'target_user_id must be a string',
  targetUuid: 'target_user_id must be a UUID',
  requestIdRequired: 'request_id is required',
  requestIdType: 'request_id must be a string',
  requestIdUuid: 'request_id must be a UUID',
  selfRequest: 'self request is not allowed',
  notRegistered: 'Confirm the User ID before using the app.',
  targetNotFound: 'Target user not found.',
  requestNotFound: 'request not found',
  blocked: 'Requests cannot be sent to a blocked recipient. Re-request after unblock.',
  duplicate: 'A request is already pending. Open the existing request.',
  alreadyFriends: 'Already friends. No new request is needed.',
  notPending: 'The request is no longer pending.',
  expired: 'This request has expired.',
  mustBeRecipient: 'the authenticated actor must be the recipient',
  mustBeSender: 'the authenticated actor must be the sender',
} as const;

export const REQUEST_COMMAND_KINDS = [
  'request',
  'approve',
  'reject',
  'cancel',
] as const;

export type RequestCommandKind = (typeof REQUEST_COMMAND_KINDS)[number];

function readUuidField(
  payload: Record<string, unknown>,
  key: string,
  required: string,
  typeError: string,
  uuidError: string,
): string | null {
  if (!(key in payload)) return required;
  const value = payload[key];
  if (typeof value !== 'string') return typeError;
  if (!UUID_RE.test(value)) return uuidError;
  return null;
}

/**
 * Kind -> payload validation for the request command kinds. Returns the
 * message to reject with (HTTP 400), or null when the payload may proceed
 * to the database. Unknown kinds return null - the handler registry is the
 * source of truth for what exists.
 */
export function validateRequestCommandPayload(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  switch (kind) {
    case 'request': {
      const targetError = readUuidField(
        payload,
        'target_user_id',
        REQUEST_MESSAGES.targetRequired,
        REQUEST_MESSAGES.targetType,
        REQUEST_MESSAGES.targetUuid,
      );
      if (targetError !== null) return targetError;
      return readInvitationTokenField(payload, { required: false });
    }
    case 'approve':
    case 'reject':
    case 'cancel':
      return readUuidField(
        payload,
        'request_id',
        REQUEST_MESSAGES.requestIdRequired,
        REQUEST_MESSAGES.requestIdType,
        REQUEST_MESSAGES.requestIdUuid,
      );
    default:
      return null;
  }
}
