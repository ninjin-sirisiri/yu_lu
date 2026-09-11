export const USER_ID_RESERVATION_HOLD = 'none';

export function normalizeUserId(value: string): string {
  return value.trim().toLowerCase();
}

export function assertUserIdConfirmed(userIdText: string | null, confirmedAt: string | null): void {
  if (!userIdText || userIdText.trim().length === 0 || !confirmedAt) {
    throw new Error('Confirm the User ID before using the app.');
  }
}

export function suggestSimilarUserIds(taken: string, count = 3): string[] {
  const base = taken.trim();
  if (!base) return [];
  return Array.from({ length: count }, (_, index) => `${base}${index + 2}`);
}
