// Task 19: external entry classification — the boundary that keeps the
// THREE entry types from colliding (通知・招待・OAuth).
//
// Ownership: pure parsing/routing of external inputs to an in-app
// destination, with strict per-source payload validation:
//
// - A NOTIFICATION payload is only ever a notification: it must carry the
//   Task 18 `data` contract ({event, request_id}). A notification that
//   carries a `url` instead is REJECTED as a notification — it can never
//   smuggle an invitation or OAuth entry through the push path.
// - A URL is only ever a URL: path-first classification (auth/callback
//   path → OAuth, /invitation/<32hex> → invitation) so query keys can
//   never flip the type (an invitation link with ?code= stays an
//   invitation; an OAuth callback with an invitation-shaped query stays
//   rejected-or-OAuth, never an invitation).
// - Everything unknown or malformed is rejected with a precise reason —
//   the caller keeps the entry point available instead of failing.
//
// Nothing here imports expo-router or performs I/O: the listener (Task 19)
// and the tests drive it with plain data.

import { parseAuthCallback } from '../auth/oauth';
import { parseInvitationUrl } from '../invitations/links';

/** The three pushable events (Task 18 server contract, 0009 event names). */
export const NOTIFICATION_EVENTS = [
  'request_received',
  'friendship_established',
  'request_expired',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Server ids are UUIDs; used to reject malformed request_ids up front. */
export const REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isNotificationEvent(value: unknown): value is NotificationEvent {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_EVENTS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Parsed entries
// ---------------------------------------------------------------------------

export type NotificationEntry =
  | { kind: 'request-arrival'; requestId: string }
  | { kind: 'friendship-established'; requestId: string }
  | { kind: 'request-expired'; requestId: string };

export type UrlEntry =
  | { kind: 'invitation'; token: string }
  | { kind: 'oauth-callback'; code: string }
  | { kind: 'oauth-error'; error: string };

export type ExternalRejectReason =
  // notification-payload rejections
  | 'notification-not-an-object'
  | 'notification-unknown-event'
  | 'notification-missing-request-id'
  | 'notification-malformed-request-id'
  | 'notification-carries-url'
  // URL rejections
  | 'url-not-a-string'
  | 'url-malformed-invitation'
  | 'url-malformed-oauth-callback'
  | 'url-unknown';

export type ParseResult<T> =
  | { ok: true; entry: T }
  | { ok: false; reason: ExternalRejectReason };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notificationEntryFor(
  event: NotificationEvent,
  requestId: string,
): NotificationEntry {
  switch (event) {
    case 'request_received':
      return { kind: 'request-arrival', requestId };
    case 'friendship_established':
      return { kind: 'friendship-established', requestId };
    case 'request_expired':
      return { kind: 'request-expired', requestId };
  }
}

/**
 * Validates a push notification `data` payload (Task 18 contract:
 * `{event, request_id}`) and classifies it.
 *
 * A payload that fails the notification contract is NEVER re-interpreted
 * as a URL entry: if it carries a `url` but no valid event, the precise
 * reason is `notification-carries-url` — the push path must not open the
 * invitation or OAuth routes (通知・招待・OAuthの入口を混同しない).
 */
export function parseNotificationData(data: unknown): ParseResult<NotificationEntry> {
  if (!isPlainObject(data)) {
    return { ok: false, reason: 'notification-not-an-object' };
  }
  const event = data['event'];
  if (!isNotificationEvent(event)) {
    if (typeof data['url'] === 'string') {
      return { ok: false, reason: 'notification-carries-url' };
    }
    return { ok: false, reason: 'notification-unknown-event' };
  }
  const requestId = data['request_id'];
  if (typeof requestId !== 'string' || requestId === '') {
    return { ok: false, reason: 'notification-missing-request-id' };
  }
  if (!REQUEST_ID_RE.test(requestId)) {
    return { ok: false, reason: 'notification-malformed-request-id' };
  }
  return { ok: true, entry: notificationEntryFor(event, requestId) };
}

/**
 * Classifies an external URL (deep link) by PATH first, then validates the
 * payload of that path:
 *
 * - `…/auth/callback` with `code` → OAuth entry (with `error` → oauth-error
 *   so the callback route can explain it); without either → rejected.
 * - `…/invitation/<32hex>` → invitation entry (its own token validation —
 *   query keys such as `code` never flip an invitation to OAuth).
 * - anything else → rejected.
 *
 * Never accepts notification-shaped input (non-string → `url-not-a-string`).
 */
export function parseExternalUrl(url: unknown): ParseResult<UrlEntry> {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, reason: 'url-not-a-string' };
  }
  const trimmed = url.trim();
  const withoutQuery = trimmed.split(/[?#]/)[0];

  // Path-first: the auth/callback path decides OAuth before any query key.
  if (/(?:^|\/\/|\/)auth\/callback\/?$/.test(withoutQuery)) {
    const callback = parseAuthCallback(trimmed);
    if (callback.kind === 'code') {
      return { ok: true, entry: { kind: 'oauth-callback', code: callback.code } };
    }
    if (callback.kind === 'error') {
      return { ok: true, entry: { kind: 'oauth-error', error: callback.error } };
    }
    return { ok: false, reason: 'url-malformed-oauth-callback' };
  }

  const token = parseInvitationUrl(trimmed);
  if (token !== null) {
    return { ok: true, entry: { kind: 'invitation', token } };
  }
  if (/(?:^|\/\/|\/)invitation(?:\/|$)/.test(withoutQuery)) {
    // An invitation-shaped path whose token failed validation: precise
    // reason so the UI can explain 復元不能・不正リンク instead of guessing.
    return { ok: false, reason: 'url-malformed-invitation' };
  }
  return { ok: false, reason: 'url-unknown' };
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/** Server-side status of a request the notification pointed at. */
export type RequestVerification =
  | { state: 'pending' }
  | { state: 'ended'; status: string }
  | { state: 'missing' }
  | { state: 'unavailable' };

export type RequestNotice = 'ended' | 'stale';

export type ExternalDestination =
  | {
      kind: 'requests';
      direction: 'incoming' | 'outgoing';
      focus: string | null;
      notice: RequestNotice | null;
    }
  | { kind: 'friends' }
  | { kind: 'invitation'; token: string }
  | { kind: 'oauth-callback'; code: string }
  | { kind: 'oauth-error'; error: string };

/**
 * Routes a parsed notification to its destination.
 *
 * The arrival event is verified against the server BEFORE navigation
 * (spec「古い申請到着通知を開いたら受信一覧で最新状態を確認し、終了済みなら
 * 説明する。有効なら対象が分かる位置を表示する」):
 *
 * - pending          → focus the row (target identifiable in the list)
 * - ended (non-pending status still listed) → focus + `ended` explanation
 * - missing (not listed: ended beyond the 7-day window / pruned) →
 *   `stale` explanation, no focus — an explanation instead of a failure
 * - unavailable (offline during verification) → plain list; the screen's
 *   own offline/error states take over (never a dead end)
 *
 * Established/expired notifications map to the friends list / the sender's
 * outgoing list respectively (Task 18: those events notify the requester).
 */
export function notificationDestination(
  entry: NotificationEntry,
  verification?: RequestVerification,
): ExternalDestination {
  switch (entry.kind) {
    case 'request-arrival': {
      const state = verification?.state ?? 'unavailable';
      switch (state) {
        case 'pending':
          return {
            kind: 'requests',
            direction: 'incoming',
            focus: entry.requestId,
            notice: null,
          };
        case 'ended':
          return {
            kind: 'requests',
            direction: 'incoming',
            focus: entry.requestId,
            notice: 'ended',
          };
        case 'missing':
          return {
            kind: 'requests',
            direction: 'incoming',
            focus: null,
            notice: 'stale',
          };
        case 'unavailable':
          return {
            kind: 'requests',
            direction: 'incoming',
            focus: null,
            notice: null,
          };
      }
      break;
    }
    case 'friendship-established':
      return { kind: 'friends' };
    case 'request-expired':
      return {
        kind: 'requests',
        direction: 'outgoing',
        focus: entry.requestId,
        notice: null,
      };
  }
  /* c8 ignore next */
  return { kind: 'requests', direction: 'incoming', focus: null, notice: null };
}

/** Routes a parsed URL entry to its destination (own route, own validation). */
export function urlDestination(entry: UrlEntry): ExternalDestination {
  switch (entry.kind) {
    case 'invitation':
      return { kind: 'invitation', token: entry.token };
    case 'oauth-callback':
      return { kind: 'oauth-callback', code: entry.code };
    case 'oauth-error':
      return { kind: 'oauth-error', error: entry.error };
  }
}

/** A router target: pathname plus the query params the screen reads. */
export interface ExternalRoute {
  pathname: string;
  params: Record<string, string>;
}

/**
 * Turns a destination into the concrete route the router pushes. Pure
 * string building — the listener (Task 19) navigates with it and the tests
 * assert the exact href without mounting the router:
 *
 * - requests  → `/friends/requests?tab=<direction>[&focus=<id>][&notice=…]`
 *               (the screen reads all three via useLocalSearchParams)
 * - friends   → `/friends`
 * - invitation→ `/invitation/<token>` (Task 14 route)
 * - oauth     → `/auth/callback?code|error=…` (Task 10 route)
 *
 * Notification entries only ever produce `requests` / `friends` — the two
 * URL-only kinds exist so URL entries can be routed through the same
 * helper without the notification path ever reaching them.
 */
export function destinationRoute(destination: ExternalDestination): ExternalRoute {
  switch (destination.kind) {
    case 'requests': {
      const params: Record<string, string> = { tab: destination.direction };
      if (destination.focus !== null) params.focus = destination.focus;
      if (destination.notice !== null) params.notice = destination.notice;
      return { pathname: '/friends/requests', params };
    }
    case 'friends':
      return { pathname: '/friends', params: {} };
    case 'invitation':
      return { pathname: `/invitation/${destination.token}`, params: {} };
    case 'oauth-callback':
      return { pathname: '/auth/callback', params: { code: destination.code } };
    case 'oauth-error':
      return { pathname: '/auth/callback', params: { error: destination.error } };
  }
}
