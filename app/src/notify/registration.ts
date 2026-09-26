// Task 19: notification enablement — the ONLY place the OS permission
// prompt can be triggered, plus device registration with `device-session`.
//
// Ownership:
// - The permission gate: `enablePushNotifications` is called exclusively
//   from the friends-tab enable action (spec「友達タブの案内で本人が通知を
//   有効にする操作をしたときにOS許可を求める」). Nothing at launch, mount,
//   or resume ever calls `request()`.
// - Expo push token retrieval (Android channel created first — SDK 57
//   requires a channel before the Android 13 permission prompt and before
//   `getExpoPushTokenAsync`).
// - The `device-session` register call (Task 18 contract) through an
//   injectable transport; the default transport posts with the user JWT.
// - Idempotency per install: the registration record
//   (`notify.registration`, account-scoped device_settings) remembers the
//   registered token + device_id, so a repeat enable with the SAME token
//   does not re-hit the server, and a rotated token re-registers.
//
// Everything is injectable (permission / token / transport / clock) so the
// permission-denied and multi-device flows are unit-testable without a
// native module or a network.

import * as Notifications from 'expo-notifications';

import { getAppClient } from '../backend/client';
import type { Storage } from '../storage/database';
import { readAccountSetting, writeAccountSetting } from '../storage/settings';

/** Account-scoped setting key holding the install's registration record. */
export const REGISTRATION_SETTING_KEY = 'notify.registration';

/** Android channel created before the prompt / token fetch (SDK 57 docs). */
export const ANDROID_CHANNEL_ID = 'default';
export const ANDROID_CHANNEL_NAME = '一般的な通知';

export type PermissionState = 'granted' | 'denied' | 'undetermined';

export interface PermissionPort {
  /** Non-prompting status check. */
  get(): Promise<PermissionState>;
  /** The prompt. Only ever invoked from the explicit enable action. */
  request(): Promise<PermissionState>;
}

export interface TokenPort {
  /** Expo push token for this install; throws when unavailable. */
  getToken(): Promise<string>;
}

export interface DeviceSessionResponse {
  /** Server-generated device id (Task 18); null when absent/malformed. */
  deviceId: string | null;
  /** Server status string, when present. */
  status?: string | null;
}

export interface DeviceSessionTransport {
  register(pushToken: string): Promise<DeviceSessionResponse>;
}

export interface RegistrationRecord {
  accountId: string;
  deviceId: string | null;
  pushToken: string;
  registeredAt: number;
}

export type EnableFailure =
  | 'no-account'
  | 'token-unavailable'
  | 'unauthenticated'
  | 'rejected'
  | 'transient';

export type EnableResult =
  | { status: 'enabled'; deviceId: string | null; alreadyRegistered: boolean }
  /** OS permission denied — the entry point stays available. */
  | { status: 'denied' }
  | { status: 'failed'; reason: EnableFailure; message: string };

export interface EnableOptions {
  storage?: Storage | null;
  accountId?: string | null;
  /** Injected permission gate (tests); defaults to expo-notifications. */
  permission?: PermissionPort;
  /** Injected token source (tests); defaults to Expo push token. */
  token?: TokenPort;
  /** Injected device-session transport (tests); defaults to the app client. */
  transport?: DeviceSessionTransport;
  /** Injected channel setup (tests); defaults to a no-op off Android. */
  ensureChannel?: () => Promise<void>;
  now?: () => number;
}

/**
 * User-facing copy for an enable failure (UI never shows raw transport
 * errors; every reason maps to an actionable Japanese message).
 */
export function enableFailureMessage(reason: EnableFailure): string {
  switch (reason) {
    case 'no-account':
      return 'サインインしてからもう一度お試しください。';
    case 'token-unavailable':
      return '通知トークンを取得できませんでした。通信状況を確認してもう一度お試しください。';
    case 'unauthenticated':
      return 'セッションの有効期限が切れています。もう一度サインインしてください。';
    case 'rejected':
      return 'この端末では通知を登録できませんでした。';
    case 'transient':
      return '通信に失敗しました。時間をおいてもう一度お試しください。';
  }
}

// ---------------------------------------------------------------------------
// Default ports (device wiring)
// ---------------------------------------------------------------------------

function normalizePermission(raw: unknown): PermissionState {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return 'undetermined';
  }
  const record = raw as { status?: unknown; granted?: unknown };
  if (record.status === 'granted' || record.granted === true) return 'granted';
  if (record.status === 'denied') return 'denied';
  // iOS granular status: 2 = AUTHORIZED, 3 = PROVISIONAL.
  const ios = (raw as { ios?: { status?: unknown } }).ios;
  if (typeof ios?.status === 'number') {
    if (ios.status === 2 || ios.status === 3) return 'granted';
    if (ios.status === 1) return 'denied';
  }
  return 'undetermined';
}

/** Default permission port over expo-notifications (never prompts on get). */
export const expoPermissionPort: PermissionPort = {
  async get(): Promise<PermissionState> {
    try {
      return normalizePermission(await Notifications.getPermissionsAsync());
    } catch {
      return 'undetermined';
    }
  },
  async request(): Promise<PermissionState> {
    try {
      return normalizePermission(await Notifications.requestPermissionsAsync());
    } catch {
      return 'undetermined';
    }
  },
};

/**
 * Default channel setup: Android needs at least one channel before the
 * permission prompt appears and before a push token can be fetched
 * (SDK 57 expo-notifications docs). No-op elsewhere / on failure.
 */
export async function ensureDefaultChannel(): Promise<void> {
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: ANDROID_CHANNEL_NAME,
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  } catch {
    // Channel creation is best effort: the permission/token ports below
    // surface the real failure if it matters.
  }
}

/**
 * Default token port (SDK 57 `getExpoPushTokenAsync` with no options): the
 * SDK itself infers the EAS project id from the app config — this module
 * never invents one. When no project id is configured, or the native module
 * is unavailable, the fetch throws → `token-unavailable`.
 */
export const expoPushTokenPort: TokenPort = {
  async getToken(): Promise<string> {
    const result = await Notifications.getExpoPushTokenAsync();
    const token = (result as { data?: unknown } | null)?.data;
    if (typeof token !== 'string' || token === '') {
      throw new Error('Expo push token was not returned');
    }
    return token;
  },
};

/**
 * Default transport: POST `device-session` with the user JWT (Task 18
 * contract: `{action:'register', push_token}` → `{action, device_id,
 * status}`). The response is parsed TOLERANTLY — extra fields are ignored
 * and a missing/malformed `device_id` yields null instead of throwing, so
 * a multi-device server response (each install gets its own device_id,
 * re-registering a known token returns the same one) can never break the
 * enable flow.
 */
export function createDeviceSessionTransport(): DeviceSessionTransport {
  return {
    async register(pushToken: string): Promise<DeviceSessionResponse> {
      const client = getAppClient();
      const { data, error } = await client.functions.invoke('device-session', {
        body: { action: 'register', push_token: pushToken },
      });
      if (error) {
        const status = readInvokeStatus(error);
        const message = readInvokeMessage(error);
        if (status === 401) {
          throw new DeviceSessionError('unauthenticated', message);
        }
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
          throw new DeviceSessionError('rejected', message);
        }
        throw new DeviceSessionError('transient', message);
      }
      return parseDeviceSessionResponse(data);
    },
  };
}

export class DeviceSessionError extends Error {
  constructor(
    readonly kind: 'unauthenticated' | 'rejected' | 'transient',
    message: string,
  ) {
    super(message);
    this.name = 'DeviceSessionError';
  }
}

function readInvokeStatus(error: unknown): number {
  const context = (error as { context?: unknown } | null)?.context;
  if (context !== null && typeof context === 'object') {
    const status = (context as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return 0;
}

function readInvokeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'device-session failed';
}

/** Tolerant parser for the Task 18 register response (multi-device safe). */
export function parseDeviceSessionResponse(data: unknown): DeviceSessionResponse {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { deviceId: null, status: null };
  }
  const record = data as Record<string, unknown>;
  const deviceId =
    typeof record['device_id'] === 'string' && record['device_id'] !== ''
      ? record['device_id']
      : null;
  const status = typeof record['status'] === 'string' ? record['status'] : null;
  return { deviceId, status };
}

// ---------------------------------------------------------------------------
// Registration record (idempotent per install)
// ---------------------------------------------------------------------------

export async function readRegistrationRecord(
  storage: Storage | null,
  accountId: string | null,
): Promise<RegistrationRecord | null> {
  if (storage === null || accountId === null) return null;
  try {
    const raw = await readAccountSetting(storage, accountId, REGISTRATION_SETTING_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record['accountId'] !== 'string' ||
      typeof record['pushToken'] !== 'string' ||
      record['accountId'] !== accountId
    ) {
      // Another account's record can never satisfy this account's check.
      return null;
    }
    return {
      accountId: record['accountId'],
      deviceId: typeof record['deviceId'] === 'string' ? record['deviceId'] : null,
      pushToken: record['pushToken'],
      registeredAt: typeof record['registeredAt'] === 'number' ? record['registeredAt'] : 0,
    };
  } catch {
    // Unreadable record degrades to "not registered" (re-enable registers again).
    return null;
  }
}

async function writeRegistrationRecord(
  storage: Storage | null,
  record: RegistrationRecord,
): Promise<void> {
  if (storage === null) return;
  try {
    await writeAccountSetting(storage, record.accountId, REGISTRATION_SETTING_KEY, JSON.stringify(record));
  } catch {
    // A storage failure must not fail an already-registered device; the
    // next enable simply re-registers (server-side idempotent).
  }
}

// ---------------------------------------------------------------------------
// The enable flow
// ---------------------------------------------------------------------------

/**
 * The full explicit-enable flow, in order:
 *
 * 1. Android channel (before the prompt, per SDK 57 docs).
 * 2. Permission: `get()` first (no prompt); only when not granted does
 *    `request()` run — and this function is only reached from the
 *    friends-tab enable action.
 * 3. Denied → `{status:'denied'}` with NO token fetch and NO server call
 *    (申請確認・承認 remain available — never a dead end).
 * 4. Token fetch → failure is `token-unavailable` (e.g. no EAS project id).
 * 5. Idempotency: same account + same token already registered →
 *    `{alreadyRegistered:true}` WITHOUT a transport call.
 * 6. `device-session` register → record persisted → `{status:'enabled'}`.
 */
export async function enablePushNotifications(
  options: EnableOptions = {},
): Promise<EnableResult> {
  const accountId = options.accountId ?? null;
  const storage = options.storage ?? null;
  const permission = options.permission ?? expoPermissionPort;
  const tokenPort = options.token ?? expoPushTokenPort;
  const transport = options.transport ?? createDeviceSessionTransport();
  const ensureChannel = options.ensureChannel ?? ensureDefaultChannel;
  const now = options.now ?? (() => Date.now());

  await ensureChannel();

  let state = await permission.get();
  if (state !== 'granted') {
    state = await permission.request();
  }
  if (state !== 'granted') {
    return { status: 'denied' };
  }
  if (accountId === null) {
    return {
      status: 'failed',
      reason: 'no-account',
      message: 'No signed-in account to register this device for.',
    };
  }

  let pushToken: string;
  try {
    pushToken = await tokenPort.getToken();
  } catch (cause) {
    return {
      status: 'failed',
      reason: 'token-unavailable',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  // Idempotent per install: same account + same token → done already.
  const existing = await readRegistrationRecord(storage, accountId);
  if (existing !== null && existing.pushToken === pushToken) {
    return {
      status: 'enabled',
      deviceId: existing.deviceId,
      alreadyRegistered: true,
    };
  }

  try {
    const response = await transport.register(pushToken);
    await writeRegistrationRecord(storage, {
      accountId,
      deviceId: response.deviceId,
      pushToken,
      registeredAt: now(),
    });
    return { status: 'enabled', deviceId: response.deviceId, alreadyRegistered: false };
  } catch (cause) {
    if (cause instanceof DeviceSessionError) {
      return { status: 'failed', reason: cause.kind, message: cause.message };
    }
    return {
      status: 'failed',
      reason: 'transient',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** Current enablement state for UI (permission only; never prompts). */
export async function notificationEnableState(
  options: EnableOptions = {},
): Promise<{ permission: PermissionState; registered: boolean }> {
  const permission = options.permission ?? expoPermissionPort;
  const state = await permission.get();
  const record = await readRegistrationRecord(
    options.storage ?? null,
    options.accountId ?? null,
  );
  return { permission: state, registered: record !== null };
}
