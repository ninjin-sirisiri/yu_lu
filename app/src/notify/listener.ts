// プッシュ通知は一時的に無効 (Apple Developer Program 未加入のため)。
//
// expo-notifications に依存せず、OS 許可要求・トークン取得・
// device-session 登録は一切行わない。到着バス (arrival bus) と
// 応答ハンドリング (response handling) は公開契約だけ温存する:
// 将来 Apple Developer Program 加入後に実配信を復活させるとき、
// 呼び出し側を直さずにこのファイルの中身だけを実配信実装へ
// 差し替えればよい。
//
// - subscribeNotificationArrived / emitNotificationArrival:
//   到着バス。プッシュ無効中は emit されることがない (到着自体が無い)。
//   友達タブの未読件数更新はこのバスではなく復帰/成立イベントで行う。
// - handleNotificationResponse / verifyArrivalRequest /
//   isNotificationSeen / markNotificationSeen: 通知タップ遷移の共有経路。
//   通知自体は届かないが、遷移ロジック (focus/notice) は残す。
// - setupForegroundSuppression / attachArrivalListener /
//   attachResponseListener / readInitialResponse / setNotificationsPort:
//   実通知ハンドラへの接続点。プッシュ無効中は no-op / null を返す。
// - setInitialUrlSource / readInitialUrl / externalUrlOwnsLaunch /
//   blocksNotificationEntry: 招待・OAuth との入口分離。通知とは無関係に
//   残す (NotificationHost の URL 所有判定が使う)。

import * as Linking from 'expo-linking';

import { listRequests, type QueryPage, type RequestEntry } from '../backend/queries';
import {
  notificationDestination,
  parseExternalUrl,
  parseNotificationData,
  type ExternalDestination,
  type RequestVerification,
} from '../navigation/externalEntry';
import type { Storage } from '../storage/database';
import { readAccountSetting, writeAccountSetting } from '../storage/settings';

// ---------------------------------------------------------------------------
// Structural ports (injectable for tests; プッシュ無効中は注入 port のみ)
// ---------------------------------------------------------------------------

export interface NotificationsPort {
  setNotificationHandler(handler: unknown): void;
  addNotificationResponseReceivedListener(cb: (response: unknown) => void): {
    remove(): void;
  };
  addNotificationReceivedListener(cb: (notification: unknown) => void): { remove(): void };
  getLastNotificationResponse(): unknown;
}

let notificationsOverride: NotificationsPort | null = null;

/** Replaces the notifications port (tests); null で未設定に戻る. */
export function setNotificationsPort(port: NotificationsPort | null): void {
  notificationsOverride = port;
}

function notifications(): NotificationsPort | null {
  return notificationsOverride;
}

// ---------------------------------------------------------------------------
// Foreground suppression
// ---------------------------------------------------------------------------

export interface ForegroundBehavior {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

/** No OS banner/list/sound/badge in the foreground — in-app notice instead. */
export const FOREGROUND_SUPPRESSED: ForegroundBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/**
 * Installs the foreground handler. プッシュ無効中は no-op
 * (ハンドラを付けても通知自体が届かない)。
 */
export function setupForegroundSuppression(port: NotificationsPort | null = notifications()): void {
  if (port === null) return;
  try {
    port.setNotificationHandler({
      handleNotification: async (): Promise<ForegroundBehavior> => FOREGROUND_SUPPRESSED,
    });
  } catch {
    // No notification handler available in this environment.
  }
}

// ---------------------------------------------------------------------------
// Arrival bus (foreground receipt → in-app notice + count + list refresh)
// ---------------------------------------------------------------------------

export interface NotificationArrival {
  event: string | null;
  requestId: string | null;
  title: string | null;
  body: string | null;
}

type ArrivalListener = (arrival: NotificationArrival) => void;

const arrivalListeners = new Set<ArrivalListener>();

/** Subscribes to foreground arrivals; returns the unsubscribe function. */
export function subscribeNotificationArrived(listener: ArrivalListener): () => void {
  arrivalListeners.add(listener);
  return () => {
    arrivalListeners.delete(listener);
  };
}

export function emitNotificationArrival(arrival: NotificationArrival): void {
  for (const listener of [...arrivalListeners]) {
    try {
      listener(arrival);
    } catch {
      // One bad subscriber must never break delivery to the others.
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function contentOf(notification: unknown): Record<string, unknown> | null {
  const request = asRecord(asRecord(notification)?.['request']);
  return asRecord(request?.['content']);
}

function eventOfEntryKind(kind: string): string {
  switch (kind) {
    case 'request-arrival':
      return 'request_received';
    case 'friendship-established':
      return 'friendship_established';
    case 'request-expired':
      return 'request_expired';
    /* c8 ignore next 2 */
    default:
      return 'unknown';
  }
}

function arrivalFrom(notification: unknown): NotificationArrival {
  const content = contentOf(notification);
  const parsed = parseNotificationData(content?.['data']);
  const title = typeof content?.['title'] === 'string' ? content['title'] : null;
  const body = typeof content?.['body'] === 'string' ? content['body'] : null;
  return {
    event: parsed.ok ? eventOfEntryKind(parsed.entry.kind) : null,
    requestId: parsed.ok ? parsed.entry.requestId : null,
    title,
    body,
  };
}

/**
 * Attaches the foreground receipt listener (notification ARRIVED, not
 * tapped) → arrival bus. プッシュ無効中は port 未設定なら no-op を返す。
 */
export function attachArrivalListener(port: NotificationsPort | null = notifications()): () => void {
  if (port === null) {
    return () => {
      // Push disabled: no receiver in this build.
    };
  }
  try {
    const subscription = port.addNotificationReceivedListener((notification) => {
      emitNotificationArrival(arrivalFrom(notification));
    });
    return () => {
      try {
        subscription.remove();
      } catch {
        // Already removed.
      }
    };
  } catch {
    return () => {
      // No receiver in this environment.
    };
  }
}

/**
 * Attaches the response (TAP) listener → the shared handling path.
 * プッシュ無効中は port 未設定なら no-op を返す。
 */
export function attachResponseListener(
  onResponse: (response: unknown) => void,
  port: NotificationsPort | null = notifications(),
): () => void {
  if (port === null) {
    void onResponse;
    return () => {
      // Push disabled: no receiver in this build.
    };
  }
  try {
    const subscription = port.addNotificationResponseReceivedListener((response) =>
      onResponse(response),
    );
    return () => {
      try {
        subscription.remove();
      } catch {
        // Already removed.
      }
    };
  } catch {
    return () => {
      // No receiver in this environment.
    };
  }
}

/**
 * The last (possibly previous-process) response for cold-start handling.
 * プッシュ無効中は port 未設定なら null (cold-start 応答なし)。
 */
export function readInitialResponse(port: NotificationsPort | null = notifications()): unknown | null {
  if (port === null) return null;
  try {
    return port.getLastNotificationResponse() ?? null;
  } catch {
    return null;
  }
}

/** Source of the URL that launched the process (tests override it). */
export type InitialUrlSource = () => string | null | Promise<string | null>;

let initialUrlSource: InitialUrlSource | null = null;

/** Overrides the launch-URL source (tests); null restores expo-linking. */
export function setInitialUrlSource(source: InitialUrlSource | null): void {
  initialUrlSource = source;
}

/** The URL that launched this process, or null (throws → null). */
export async function readInitialUrl(): Promise<string | null> {
  try {
    const url =
      initialUrlSource !== null ? await initialUrlSource() : await Linking.getInitialURL();
    return typeof url === 'string' && url !== '' ? url : null;
  } catch {
    return null;
  }
}

/**
 * True when THIS cold start was owned by an external URL entry (an
 * invitation link or an OAuth callback): the router handles that entry, so
 * a pending notification response must NOT navigate over it — the three
 * entry types never collide. The response stays unseen and is retried on a
 * later, URL-free launch.
 */
export function externalUrlOwnsLaunch(url: string | null): boolean {
  if (url === null) return false;
  return parseExternalUrl(url).ok;
}

/**
 * True while the pathname is an entry the notification must not hijack:
 * the entry guard is still deciding ('' , '/'), the auth screens are up
 * (未登録ガード — a deferred response waits for registration instead of
 * yanking the user away), or another entry type owns the route
 * (招待 / OAuth callback — the three entry types never collide).
 */
export function blocksNotificationEntry(pathname: string): boolean {
  if (pathname === '' || pathname === '/') return true; // entry guard still deciding
  if (pathname === '/login' || pathname === '/register') return true; // auth/registration gate
  if (pathname.startsWith('/invitation')) return true; // invitation entry
  if (pathname.startsWith('/auth/')) return true; // OAuth callback entry
  return false;
}

// ---------------------------------------------------------------------------
// Seen-notification store (account-scoped, persisted per notification id)
// ---------------------------------------------------------------------------

export const SEEN_IDS_SETTING_KEY = 'notify.seen_ids';
export const SEEN_IDS_LIMIT = 50;

const memorySeen = new Set<string>();

/** Drops the in-memory layer (tests / account switch). */
export function resetSeenNotificationMemory(): void {
  memorySeen.clear();
}

function seenKey(accountId: string, id: string): string {
  return `${accountId}::${id}`;
}

async function readSeenIds(storage: Storage, accountId: string): Promise<string[]> {
  try {
    const raw = await readAccountSetting(storage, accountId, SEEN_IDS_SETTING_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export async function isNotificationSeen(
  storage: Storage | null,
  accountId: string | null,
  id: string,
): Promise<boolean> {
  if (accountId === null) return false;
  if (memorySeen.has(seenKey(accountId, id))) return true;
  if (storage === null) return false;
  const ids = await readSeenIds(storage, accountId);
  const seen = ids.includes(id);
  if (seen) memorySeen.add(seenKey(accountId, id));
  return seen;
}

export async function markNotificationSeen(
  storage: Storage | null,
  accountId: string | null,
  id: string,
): Promise<void> {
  if (accountId === null) return;
  memorySeen.add(seenKey(accountId, id));
  if (storage === null) return;
  try {
    const current = await readSeenIds(storage, accountId);
    const next = [id, ...current.filter((seen) => seen !== id)].slice(0, SEEN_IDS_LIMIT);
    await writeAccountSetting(storage, accountId, SEEN_IDS_SETTING_KEY, JSON.stringify(next));
  } catch {
    // A storage failure degrades to in-process dedupe only; navigation has
    // already happened and must never be rolled back by a settings write.
  }
}

// ---------------------------------------------------------------------------
// Server verification (before navigating to the incoming list)
// ---------------------------------------------------------------------------

export type FetchIncoming = () => Promise<QueryPage<RequestEntry>>;

/**
 * Checks the notification's `request_id` against the server's incoming
 * list (first page — pending rows sort first):
 *
 * - pending               → `pending` (focus the row)
 * - listed, non-pending   → `ended` (explain 終了済み)
 * - not listed            → `missing` (stale: beyond the 7-day window)
 * - fetch threw/offline   → `unavailable` (the screen shows its own state)
 */
export async function verifyArrivalRequest(
  requestId: string,
  fetchIncoming: FetchIncoming = () => listRequests('incoming', null),
): Promise<RequestVerification> {
  try {
    const page = await fetchIncoming();
    const items = Array.isArray(page?.items) ? page.items : [];
    const found = items.find((item) => item.requestId === requestId);
    if (found === undefined) return { state: 'missing' };
    if (found.status === 'pending') return { state: 'pending' };
    return { state: 'ended', status: found.status };
  } catch {
    return { state: 'unavailable' };
  }
}

// ---------------------------------------------------------------------------
// The ONE response-handling path (initial + while running)
// ---------------------------------------------------------------------------

export type ResponseOutcome =
  /** No usable response object. */
  | 'ignored'
  /** Already handled (persisted seen store or an in-flight duplicate). */
  | 'duplicate'
  /** Payload failed validation — no navigation, nothing persisted. */
  | 'rejected'
  /** Auth/registration not ready — entry preserved for later processing. */
  | 'deferred'
  /** Verified and navigated (destination carries focus/notice). */
  | 'navigated';

export interface HandleResponseDeps {
  storage: Storage | null;
  accountId: string | null;
  registration: 'loading' | 'unregistered' | 'registered';
  navigate: (destination: ExternalDestination) => void;
  /** Injected server read (tests); defaults to list_requests incoming. */
  fetchIncoming?: FetchIncoming;
}

/** In-process guard: two callbacks for the same id can't double-navigate. */
const inFlight = new Set<string>();

/** Clears the in-flight guard (tests). */
export function resetInFlightNotifications(): void {
  inFlight.clear();
}

function identifierOf(response: unknown): string | null {
  const notification = asRecord(response)?.['notification'];
  const request = asRecord(asRecord(notification)?.['request']);
  const identifier = request?.['identifier'];
  return typeof identifier === 'string' && identifier !== '' ? identifier : null;
}

function dataOf(response: unknown): unknown {
  const notification = asRecord(response)?.['notification'];
  const request = asRecord(asRecord(notification)?.['request']);
  const content = asRecord(request?.['content']);
  return content?.['data'];
}

/**
 * Handles one notification response through the shared path:
 *
 * 1. Parse the payload (strict Task 18 contract) — malformed → `rejected`,
 *    never re-routed to invitation/OAuth.
 * 2. Auth gate — signed out / unregistered → `deferred` (entry kept, NOT
 *    marked seen, retried when registration completes).
 * 3. Dedupe — persisted seen ids + in-flight guard → `duplicate`.
 * 4. Verify the arrival request against the server, then navigate with the
 *    verified destination (focus / ended / stale / plain).
 * 5. Mark the notification id seen (after navigation succeeded).
 */
export async function handleNotificationResponse(
  response: unknown,
  deps: HandleResponseDeps,
): Promise<ResponseOutcome> {
  const notification = asRecord(asRecord(response)?.['notification']);
  if (notification === null) return 'ignored';

  const parsed = parseNotificationData(dataOf(response));
  const identifier = identifierOf(response);
  const id = identifier ?? (parsed.ok ? `${parsed.entry.kind}:${parsed.entry.requestId}` : null);
  if (id === null) return 'rejected';
  if (!parsed.ok) return 'rejected';

  // Auth + registration gate: the entry is preserved, never dropped.
  if (deps.registration !== 'registered' || deps.accountId === null) {
    return 'deferred';
  }

  if (await isNotificationSeen(deps.storage, deps.accountId, id)) return 'duplicate';
  if (inFlight.has(id)) return 'duplicate';
  inFlight.add(id);
  try {
    const entry = parsed.entry;
    let destination: ExternalDestination;
    if (entry.kind === 'request-arrival') {
      const verification = await verifyArrivalRequest(entry.requestId, deps.fetchIncoming).catch(
        (): RequestVerification => ({ state: 'unavailable' }),
      );
      destination = notificationDestination(entry, verification);
    } else {
      destination = notificationDestination(entry);
    }
    deps.navigate(destination);
    await markNotificationSeen(deps.storage, deps.accountId, id);
    return 'navigated';
  } finally {
    inFlight.delete(id);
  }
}
