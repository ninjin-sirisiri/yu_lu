// Task 14: the pending invitation stored on the device across the auth
// boundary.
//
// Ownership: product rules on top of the storage primitives
// (storage/invitations.ts keeps rows keyed by `(account_id, invitation_key)`):
//
// - **Pre-login bucket.** `pending_invitation` is account-scoped, but an
//   invitation is opened BEFORE the user signs in. Rows saved while signed
//   out go under `PRE_LOGIN_ACCOUNT_ID` and are ATTACHED to the real
//   account after OAuth (`attachPendingInvitations`), so OAuth復帰で招待
//   情報を失わない. The row itself is never rewritten during attach.
// - **First invitation wins.** Opening a second invitation while the first
//   is still live keeps the first (spec「別の招待を開いても最初の招待を
//   維持する」); a dead (expired) first invitation is replaced so the user
//   is never stuck on a link that cannot work.
// - **Clear** removes the bucket rows (used when the pending invitation
//   has served its purpose or an account is discarded).
//
// The storage layer stays primitive: this module decides when to keep,
// replace or move rows.

import { requireNonEmpty, type Storage } from '../storage/database';
import {
  deletePendingInvitation,
  listPendingInvitations,
  readPendingInvitation,
  savePendingInvitation as writePendingRow,
} from '../storage/invitations';

/**
 * Bucket for invitations saved before any account exists (same convention
 * as storage/persistenceProbe.ts `__device_probe`).
 */
export const PRE_LOGIN_ACCOUNT_ID = '__pre_login__';

/**
 * Single-row key per bucket: the pending invitation is one slot (first
 * wins), not a list.
 */
export const PENDING_KEY = 'current';

/** Where the invitation came from (recorded for diagnostics). */
export type InvitationSource = 'link' | 'qr' | 'paste' | 'referrer' | 'route';

export interface PendingInvitationPayload {
  token: string;
  url: string;
  source: InvitationSource;
  /** Server ISO time when known (filled in after a successful resolve). */
  expiresAt?: string | null;
  /** Local epoch of the last successful resolve, for 取得時点 offline. */
  fetchedAt?: number | null;
  /**
   * Cached confirmation from the last successful resolve so an offline
   * relaunch can still show WHO the inviter is, labelled with 取得時点.
   * Never presented as currently valid — validity is re-checked on open.
   */
  resolution?: {
    status: 'valid' | 'invalidated' | 'expired';
    inviter: { displayName: string; userIdText: string };
    expiresAt: string;
    fetchedAt: number;
  } | null;
}

export interface SavedPendingInvitation {
  /** The invitation that is now the account/bucket's pending one. */
  payload: PendingInvitationPayload;
  /** True when an existing live invitation was kept over the new one. */
  keptExisting: boolean;
}

function bucketOf(accountId: string | null | undefined): string {
  return accountId === null || accountId === undefined || accountId === ''
    ? PRE_LOGIN_ACCOUNT_ID
    : accountId;
}

function isLive(payload: PendingInvitationPayload, now: number): boolean {
  if (payload.expiresAt === undefined || payload.expiresAt === null) {
    // Expiry not learned yet (opened before the first resolve): treat as
    // live so the FIRST invitation is the one kept, per spec.
    return true;
  }
  const expires = Date.parse(payload.expiresAt);
  return Number.isFinite(expires) ? expires > now : true;
}

async function readBucket(
  db: Storage,
  accountId: string | null | undefined,
): Promise<PendingInvitationPayload | null> {
  const record = await readPendingInvitation(db, bucketOf(accountId), PENDING_KEY);
  if (record === null) return null;
  const payload = record.payload as PendingInvitationPayload | null;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.token !== 'string' ||
    payload.token === ''
  ) {
    // A corrupt row must never block registration (復元不能でも登録を止めない).
    await deletePendingInvitation(db, bucketOf(accountId), PENDING_KEY).catch(() => {
      // Best effort: an unreadable row is dropped on a later save anyway.
    });
    return null;
  }
  return payload;
}

/**
 * Saves the pending invitation into a bucket (`accountId`, or the
 * pre-login bucket when null/empty).
 *
 * Keep-first: an existing row is NEVER replaced — neither by a different
 * still-live invitation (spec「別の招待を開いても最初の招待を維持する」)
 * nor by a re-save of the same token (source/url metadata of the first
 * save wins). Only a known-DEAD first invitation is replaced, so the user
 * is never stuck on a link that cannot work.
 */
export async function savePendingInvitation(
  db: Storage,
  input: {
    accountId?: string | null;
    payload: PendingInvitationPayload;
    /** Injected clock (tests); defaults to Date.now. */
    now?: number;
  },
): Promise<SavedPendingInvitation> {
  requireNonEmpty('payload.token', input.payload.token);
  const now = input.now ?? Date.now();
  const existing = await readBucket(db, input.accountId);
  if (existing !== null) {
    if (existing.token === input.payload.token) {
      // Same token: keep the original row (first source/metadata wins).
      return { payload: existing, keptExisting: true };
    }
    if (isLive(existing, now)) {
      return { payload: existing, keptExisting: true };
    }
    // Dead first invitation: fall through and replace it.
  }
  await writePendingRow(db, {
    accountId: bucketOf(input.accountId),
    invitationKey: PENDING_KEY,
    payload: input.payload,
    expiresAt:
      input.payload.expiresAt !== undefined && input.payload.expiresAt !== null
        ? Date.parse(input.payload.expiresAt)
        : null,
  });
  return { payload: input.payload, keptExisting: false };
}

/**
 * The pending invitation of a bucket, or null. A corrupt row is deleted
 * and reported as null — never thrown at the caller.
 */
export async function loadPendingInvitation(
  db: Storage,
  accountId: string | null | undefined,
): Promise<PendingInvitationPayload | null> {
  return readBucket(db, accountId);
}

/**
 * Moves every pre-login row to the signed-in account after OAuth, keeping
 * the account's own live invitation when both exist (first wins). The
 * pre-login bucket is emptied afterwards — the row is MOVED, not copied.
 * Returns the account's pending invitations after the merge.
 */
export async function attachPendingInvitations(
  db: Storage,
  accountId: string,
): Promise<PendingInvitationPayload[]> {
  requireNonEmpty('accountId', accountId);
  const preLoginRows = await listPendingInvitations(db, PRE_LOGIN_ACCOUNT_ID);
  const now = Date.now();
  for (const row of preLoginRows) {
    const payload = row.payload as PendingInvitationPayload | null;
    if (
      payload === null ||
      typeof payload !== 'object' ||
      typeof payload.token !== 'string' ||
      payload.token === ''
    ) {
      continue; // corrupt pre-login row: drop it below with the rest
    }
    await savePendingInvitation(db, { accountId, payload, now });
    await deletePendingInvitation(db, PRE_LOGIN_ACCOUNT_ID, row.invitationKey);
  }
  const merged = await listPendingInvitations(db, accountId);
  return merged
    .map((row) => row.payload as PendingInvitationPayload)
    .filter(
      (payload): payload is PendingInvitationPayload =>
        payload !== null &&
        typeof payload === 'object' &&
        typeof payload.token === 'string' &&
        payload.token !== '',
    );
}

/**
 * Records the server's resolution (status, inviter confirmation info,
 * expiry + fetch time) on the pending row so an offline relaunch can still
 * show the confirmation with 取得時点 (取得済み招待は取得時点の期限を表示し、
 * 現在の有効性は保証しない). Only applied when the stored invitation is the
 * SAME token that was resolved.
 */
export async function recordInvitationResolution(
  db: Storage,
  accountId: string | null | undefined,
  input: {
    token: string;
    status: 'valid' | 'invalidated' | 'expired';
    expiresAt: string;
    inviter: { displayName: string; userIdText: string };
    fetchedAt: number;
  },
): Promise<boolean> {
  const current = await readBucket(db, accountId);
  if (current === null || current.token !== input.token) return false;
  const next: PendingInvitationPayload = {
    ...current,
    expiresAt: input.expiresAt,
    fetchedAt: input.fetchedAt,
    resolution: {
      status: input.status,
      inviter: input.inviter,
      expiresAt: input.expiresAt,
      fetchedAt: input.fetchedAt,
    },
  };
  await writePendingRow(db, {
    accountId: bucketOf(accountId),
    invitationKey: PENDING_KEY,
    payload: next,
    expiresAt: Date.parse(input.expiresAt),
  });
  return true;
}

/** Removes the pending invitation of a bucket (no-op when absent). */
export async function clearPendingInvitation(
  db: Storage,
  accountId: string | null | undefined,
): Promise<void> {
  await deletePendingInvitation(db, bucketOf(accountId), PENDING_KEY);
}

// ---------------------------------------------------------------------------
// Post-auth return target (process-scoped memory, same pattern as
// navigation/entry.ts destination memory).
//
// Spec「招待・通知による起動は通常起動と区別し、ログイン・登録を経て目的の
// 画面へ進む」「招待経則では登録後に招待先確認へ直接戻る」: when the
// invitation route shows its login/register CTA it records where to return
// to AFTER auth completes. Login / register / OAuth callback consult it;
// reaching the confirmation consumes it. Process memory only — a process
// death during OAuth simply falls back to the normal destination (the
// pending invitation row itself survives in SQLite either way).
// ---------------------------------------------------------------------------

let postAuthInvitation: string | null = null;

/** Records the invitation token to return to after login/registration. */
export function setPostAuthInvitation(token: string): void {
  postAuthInvitation = token;
}

/** Reads the pending post-auth target without consuming it. */
export function peekPostAuthInvitation(): string | null {
  return postAuthInvitation;
}

/** Consumes the post-auth target (register success / confirmation reached). */
export function takePostAuthInvitation(): string | null {
  const token = postAuthInvitation;
  postAuthInvitation = null;
  return token;
}

/** Clears the post-auth target (test isolation / abandoning the flow). */
export function clearPostAuthInvitation(): void {
  postAuthInvitation = null;
}
