// Task 3: fail-fast payload gate for the shared preset command.
//
// Ownership: shape and closed-value checks for `set_chat_appearance`. The
// database remains authoritative for the actor (auth.uid()), registration,
// conversation membership, the current friendship epoch, blocks and the
// catalog; this module only rejects obviously malformed input before an RPC.
// The payload is deliberately closed: peer, relationship generation and the
// required preset key (JSON null = return to automatic). No actor, growth,
// colour or other user IDs are accepted.

import { UUID_RE } from './commands.ts';

/** Fixed v1 catalog IDs. Never replace an ID's meaning or auto mapping in place. */
export const CHAT_APPEARANCE_PRESET_IDS = [
  'b-pop',
  'b-candy',
  'b-soda',
] as const;

export type ChatAppearancePresetId = (typeof CHAT_APPEARANCE_PRESET_IDS)[number];

export const INVALID_APPEARANCE_PAYLOAD = 'Invalid set_chat_appearance payload.';

const PAYLOAD_KEYS = ['peer_id', 'friendship_epoch', 'preset_id'] as const;

/**
 * Returns the HTTP 400 message for a malformed `set_chat_appearance`
 * payload, or null for every other kind / a usable payload.
 */
export function validateAppearanceCommandPayload(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  if (kind !== 'set_chat_appearance') return null;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return INVALID_APPEARANCE_PAYLOAD;
  }
  if (
    Object.keys(payload).length !== PAYLOAD_KEYS.length ||
    PAYLOAD_KEYS.some((key) => !(key in payload))
  ) {
    return INVALID_APPEARANCE_PAYLOAD;
  }
  for (const key of ['peer_id', 'friendship_epoch']) {
    const value = payload[key];
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      return INVALID_APPEARANCE_PAYLOAD;
    }
  }
  // `preset_id` is required: JSON null explicitly means "return to automatic",
  // and any string must be one of the fixed v1 IDs. Do not rewrite the value.
  const preset = payload['preset_id'];
  if (
    preset !== null &&
    (typeof preset !== 'string' ||
      !(CHAT_APPEARANCE_PRESET_IDS as readonly string[]).includes(preset))
  ) {
    return INVALID_APPEARANCE_PAYLOAD;
  }
  return null;
}
