export const FRIEND_REQUEST_VALID_DAYS = 7;
export const REJECTION_DISPLAY = '今回は成立しませんでした';

export function requestExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + FRIEND_REQUEST_VALID_DAYS * 24 * 60 * 60 * 1000);
}

export function assertNoDuplicatePending(pendingCount: number): void {
  if (pendingCount > 0) {
    throw new Error('A request is already pending. Open the existing request.');
  }
}

export function crossedRequestEstablished(outgoingPending: boolean, incomingPending: boolean): boolean {
  return outgoingPending && incomingPending;
}
