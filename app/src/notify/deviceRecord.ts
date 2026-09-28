// プッシュ通知は一時的に無効 (Apple Developer Program 未加入のため実プッシュ不可)。
//
// このモジュールは expo-notifications に一切依存しない端末登録レコードの
// 読みと DeviceSessionError だけを置く。notify/registration から分離した
// 理由: ログアウト (auth/logout) が登録レコード参照のために
// expo-notifications をバンドルへ引き込まないようにするため。
// notify/registration は互換のためここから再エクスポートする。

import type { Storage } from '../storage/database';
import { readAccountSetting } from '../storage/settings';

/** Account-scoped setting key holding the install's registration record. */
export const REGISTRATION_SETTING_KEY = 'notify.registration';

export interface RegistrationRecord {
  accountId: string;
  deviceId: string | null;
  pushToken: string;
  registeredAt: number;
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

export interface DeviceSessionResponse {
  /** Server-generated device id (Task 18); null when absent/malformed. */
  deviceId: string | null;
  /** Server status string, when present. */
  status?: string | null;
}

export interface DeviceSessionTransport {
  register(pushToken: string): Promise<DeviceSessionResponse>;
}

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
