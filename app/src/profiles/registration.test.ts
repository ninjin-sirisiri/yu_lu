import {
  assertRegistrationInput,
  assertUserIdConfirmed,
  normalizeUserId,
  suggestSimilarUserIds,
  USER_ID_RESERVATION_HOLD,
} from './registration';
import { USER_ID_ERROR } from './validation';

describe('USER_ID_RESERVATION_HOLD', () => {
  it('is none', () => {
    expect(USER_ID_RESERVATION_HOLD).toBe('none');
  });
});

describe('normalizeUserId', () => {
  it('lowercases and trims', () => {
    expect(normalizeUserId('  Alice_Yamada  ')).toBe('alice_yamada');
  });

  it('treats differently cased IDs as the same identity', () => {
    expect(normalizeUserId('Hanako')).toBe(normalizeUserId('HANAKO'));
    expect(normalizeUserId('Hanako')).toBe(normalizeUserId('  hanako '));
  });

  it('maps blank input to an empty string', () => {
    expect(normalizeUserId('')).toBe('');
    expect(normalizeUserId('   ')).toBe('');
  });

  it('trims ideographic spaces with the shared trim rules', () => {
    expect(normalizeUserId('\u3000Hanako\u3000')).toBe('hanako');
  });
});

describe('assertRegistrationInput', () => {
  it('returns the normalized values of a valid draft', () => {
    expect(
      assertRegistrationInput('  Alice_Yamada  ', '  花子 Hanako  '),
    ).toEqual({ userIdText: 'Alice_Yamada', displayName: '花子 Hanako' });
  });

  it('throws the shared User ID error for an invalid ID', () => {
    expect(() => assertRegistrationInput('a', 'Hanako')).toThrow(USER_ID_ERROR);
    expect(() => assertRegistrationInput('bad id', 'Hanako')).toThrow(
      USER_ID_ERROR,
    );
    expect(() => assertRegistrationInput('x'.repeat(21), 'Hanako')).toThrow(
      USER_ID_ERROR,
    );
  });

  it('throws the shared display name errors', () => {
    expect(() => assertRegistrationInput('hanako', '   ')).toThrow(
      'Display name must not be blank.',
    );
    expect(() => assertRegistrationInput('hanako', 'a\nb')).toThrow(
      'Display name must not contain a newline.',
    );
    expect(() =>
      assertRegistrationInput('hanako', '\u{1F600}'.repeat(16)),
    ).toThrow('Display name must be 15 visual characters or fewer.');
  });

  it('accepts 15 emoji as a display name (visual counting)', () => {
    const draft = assertRegistrationInput(
      'hanako',
      '\u{1F600}'.repeat(15),
    );
    expect(draft.displayName).toBe('\u{1F600}'.repeat(15));
  });
});

describe('assertUserIdConfirmed', () => {
  it('passes for a confirmed User ID', () => {
    expect(() => assertUserIdConfirmed('hanako', '2026-09-11T00:00:00+09:00')).not.toThrow();
  });

  it('rejects blank IDs', () => {
    expect(() => assertUserIdConfirmed(null, '2026-09-11T00:00:00+09:00')).toThrow(
      'Confirm the User ID before using the app.',
    );
    expect(() => assertUserIdConfirmed('', '2026-09-11T00:00:00+09:00')).toThrow(
      'Confirm the User ID before using the app.',
    );
    expect(() => assertUserIdConfirmed('   ', '2026-09-11T00:00:00+09:00')).toThrow(
      'Confirm the User ID before using the app.',
    );
  });

  it('rejects unconfirmed profiles', () => {
    expect(() => assertUserIdConfirmed('hanako', null)).toThrow(
      'Confirm the User ID before using the app.',
    );
    expect(() => assertUserIdConfirmed(null, null)).toThrow(
      'Confirm the User ID before using the app.',
    );
  });
});

describe('suggestSimilarUserIds', () => {
  it('suggests numbered alternatives for a taken ID', () => {
    expect(suggestSimilarUserIds('hanako')).toEqual(['hanako2', 'hanako3', 'hanako4']);
  });

  it('honours the requested count', () => {
    expect(suggestSimilarUserIds('hanako', 1)).toEqual(['hanako2']);
    expect(suggestSimilarUserIds('hanako', 5)).toHaveLength(5);
  });

  it('returns no suggestions for blank input', () => {
    expect(suggestSimilarUserIds('')).toEqual([]);
    expect(suggestSimilarUserIds('   ')).toEqual([]);
  });
});
