// プッシュ通知は一時的に無効 (Apple Developer Program 未加入のため)。
//
// このモジュールは OS 許可要求・トークン取得・device-session 登録を行わない。
// 友達タブの通知 UI が消えたため、enablePushNotifications /
// notificationEnableState の公開契約だけを「無効な状態」で温存する:
// 将来 Apple Developer Program 加入後に実配信を復活させるとき、
// 呼び出し側 (friends/index.tsx — 現在は未使用) を直さずに
// このファイルの中身だけを実配信実装へ差し替えればよい。
//
// expo-notifications I/O (get/requestPermissionsAsync, getExpoPushTokenAsync,
// setNotificationChannelAsync)・device-session 登録・device_settings への
// 新規 I/O は一切ない。readRegistrationRecord は互換の再エクスポートのみ。

import type { Storage } from '../storage/database';
import {
  REGISTRATION_SETTING_KEY,
  readRegistrationRecord,
  DeviceSessionError,
  type DeviceSessionResponse,
  type DeviceSessionTransport,
  type RegistrationRecord,
} from './deviceRecord';

export {
  REGISTRATION_SETTING_KEY,
  readRegistrationRecord,
  DeviceSessionError,
  type DeviceSessionResponse,
  type DeviceSessionTransport,
  type RegistrationRecord,
} from './deviceRecord';

export {
  setNotificationsPort,
  attachArrivalListener,
  attachResponseListener,
  setupForegroundSuppression,
  readInitialResponse,
  emitNotificationArrival,
  FOREGROUND_SUPPRESSED,
} from './listener';

export const ANDROID_CHANNEL_ID = 'default';
export const ANDROID_CHANNEL_NAME = '一般的な通知';

export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unavailable';

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
  /** Injected permission gate (tests); プッシュ無効中は未使用. */
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
      return '通知は現在利用できません。申請の確認はこの画面からできます。';
    case 'unauthenticated':
      return 'セッションの有効期限が切れています。もう一度サインインしてください。';
    case 'rejected':
      return '通知は現在利用できません。申請の確認はこの画面からできます。';
    case 'transient':
      return '通知は現在利用できません。申請の確認はこの画面からできます。';
  }
}

/** Default permission port: プッシュ無効中は常に unavailable (prompt なし)。 */
export const expoPermissionPort: PermissionPort = {
  async get(): Promise<PermissionState> {
    return 'unavailable';
  },
  async request(): Promise<PermissionState> {
    return 'unavailable';
  },
};

/**
 * Default channel setup: プッシュ無効中は no-op。
 */
export async function ensureDefaultChannel(): Promise<void> {
  return undefined;
}

/**
 * Default token port: プッシュ無効中は常に token-unavailable。
 */
export const expoPushTokenPort: TokenPort = {
  async getToken(): Promise<string> {
    throw new Error('Push notifications are disabled in this build');
  },
};

/**
 * Default transport: プッシュ無効中はサーバーへ送らず transient 扱い。
 */
export function createDeviceSessionTransport(): DeviceSessionTransport {
  return {
    async register(): Promise<DeviceSessionResponse> {
      throw new DeviceSessionError('transient', 'Push notifications are disabled in this build');
    },
  };
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

/**
 * プッシュ無効中の enable フロー: OS 許可・トークン・サーバー登録の
 * いずれにも触れず、常に `token-unavailable` で失敗を返す。UI は
 * enableFailureMessage を出して申請確認の導線を残す。
 */
export async function enablePushNotifications(
  options: EnableOptions = {},
): Promise<EnableResult> {
  const accountId = options.accountId ?? null;
  await options.ensureChannel?.();
  await options.permission?.get();
  if (accountId === null) {
    return {
      status: 'failed',
      reason: 'no-account',
      message: 'No signed-in account to register this device for.',
    };
  }
  try {
    await (options.token ?? expoPushTokenPort).getToken();
  } catch (cause) {
    return {
      status: 'failed',
      reason: 'token-unavailable',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return {
    status: 'failed',
    reason: 'token-unavailable',
    message: 'Push notifications are disabled in this build',
  };
}

/** Current enablement state for UI (permission only; never prompts). */
export async function notificationEnableState(
  options: EnableOptions = {},
): Promise<{ permission: PermissionState; registered: boolean }> {
  const permission = options.permission
    ? await options.permission.get().catch((): PermissionState => 'unavailable')
    : 'unavailable';
  return { permission, registered: false };
}
