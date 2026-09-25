import { trimVisual, validateRegistrationInput } from './validation';

export const USER_ID_RESERVATION_HOLD = 'none';

/**
 * Identity normalization: trimmed + lower-cased. Comparison keys use this;
 * the stored/displayed User ID keeps its original case (Task 3's
 * validation.ts owns the display-form rules).
 */
export function normalizeUserId(value: string): string {
  return trimVisual(value).toLowerCase();
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

export interface ConfirmedRegistration {
  userIdText: string;
  displayName: string;
}

/**
 * Task 3: registration draft gate. Validates against the shared rules
 * (User ID format and immutability input, display name visual limits) and
 * returns the normalized values to submit; throws the server-identical
 * error message when the draft is not registrable.
 */
export function assertRegistrationInput(
  userIdText: string,
  displayName: string,
): ConfirmedRegistration {
  const result = validateRegistrationInput({ userIdText, displayName });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
