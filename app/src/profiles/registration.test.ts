import {
  assertUserIdConfirmed,
  normalizeUserId,
  suggestSimilarUserIds,
  USER_ID_RESERVATION_HOLD,
} from './registration';

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
