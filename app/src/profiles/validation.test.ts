// Task 3: shared input-rule tests (client side).
//
// Ownership: proves the client half of the shared fixture — visual length
// counts grapheme clusters (Intl.Segmenter is the test-only oracle; the
// production path never depends on it), rule order and normalization match
// the messages documented for the server, and the rule fixtures behave as
// declared. The same vectors run against the SQL implementation in
// supabase/tests/database/registration.test.sql ("両環境一致").

import {
  DISPLAY_NAME_FIXTURE,
  DISPLAY_NAME_TOO_LONG_ERROR,
  INTRODUCTION_FIXTURE,
  USER_ID_FIXTURE,
  USER_ID_ERROR,
  VISUAL_LENGTH_FIXTURE,
  normalizeUserIdInput,
  trimVisual,
  validateDisplayNameInput,
  validateIntroductionInput,
  validateRegistrationInput,
  validateUserIdInput,
  visualLength,
} from './validation';

// Minimal structural typing so `npm run typecheck` does not depend on the
// TypeScript lib version exposing Intl.Segmenter.
interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}
const SegmenterCtor = (
  Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { granularity?: string },
    ) => GraphemeSegmenter;
  }
).Segmenter;

function intlGraphemeLength(text: string): number {
  const segmenter = new SegmenterCtor!('en', { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

describe('shared fixture prerequisites', () => {
  it('the test runtime provides Intl.Segmenter (oracle only)', () => {
    expect(typeof SegmenterCtor).toBe('function');
  });
});

describe('visualLength against the shared fixture', () => {
  it.each(VISUAL_LENGTH_FIXTURE.map((v) => [JSON.stringify(v.text), v] as const))(
    'counts %s as declared',
    (_label, vector) => {
      expect(visualLength(vector.text)).toBe(vector.graphemes);
    },
  );

  it('agrees with the Intl.Segmenter oracle for every fixture vector', () => {
    for (const vector of VISUAL_LENGTH_FIXTURE) {
      expect(intlGraphemeLength(vector.text)).toBe(vector.graphemes);
      expect(visualLength(vector.text)).toBe(intlGraphemeLength(vector.text));
    }
  });

  it('agrees with the Intl.Segmenter oracle on a mixed corpus', () => {
    const corpus = [
      'こんにちは世界',
      'ÁÉÍ',
      'A\u0301E\u0301I\u0301', // decomposed accents
      '\u0301',
      '한글',
      '각', // Hangul jamo L+V+T = one cluster
      'a\u200Db',
      '\u{1F600}\u200D\u{1F600}',
      '\u{1F1EF}\u{1F1F1}\u{1F1F0}\u{1F1F7}', // two flags
      '\u{1F1EF}\u{1F1F1}\u{1F1F0}', // odd RI run = pair + single
      '\u{1F44D}\u{1F3FF}\u{1F44D}\u{1F3FF}',
      '\u304B\u3099\u304B\u3099',
      'a\r\n',
      '\ta\n',
      '\u0001\u0301',
      'a\u00A0b',
      '\uFEFF',
      '  spaced   out  ',
      'ｱｲｳｴｵ',
      '👍🏽 family 👨‍👩‍👧‍👦 ❤️‍🔥 end',
    ];
    for (const text of corpus) {
      expect(visualLength(text)).toBe(intlGraphemeLength(text));
    }
  });

  it('is grapheme-aware where String#length is not', () => {
    const combining = 'a\u0301'; // decomposed: 2 UTF-16 units, 1 grapheme
    expect(combining.length).toBe(2); // UTF-16 units…
    expect(visualLength(combining)).toBe(1); // …but one visible character
    expect('\u{1F600}'.length).toBe(2);
    expect(visualLength('\u{1F600}')).toBe(1);
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
    expect(family.length).toBe(11);
    expect(visualLength(family)).toBe(1);
  });

  it('counts a newline as exactly one character', () => {
    expect(visualLength('\n')).toBe(1);
    expect(visualLength('a\n\nb')).toBe(4);
    expect('a\n\nb'.length).toBe(4); // happens to coincide; fixture above does not
    expect(visualLength('あ\n'.repeat(100))).toBe(200);
  });
});

describe('rule fixtures: User ID', () => {
  it.each(USER_ID_FIXTURE.map((v) => [JSON.stringify(v.input), v] as const))(
    'validates %s',
    (_label, vector) => {
      const result = validateUserIdInput(vector.input);
      expect(result.ok).toBe(vector.ok);
      if (vector.ok && result.ok) {
        expect(result.value).toBe(vector.normalized);
      } else if (!vector.ok && !result.ok) {
        expect(result.error).toBe(vector.error);
      }
    },
  );

  it('preserves display case while identity stays case-insensitive', () => {
    const result = validateUserIdInput('  Alice_Yamada  ');
    expect(result.ok && result.value).toBe('Alice_Yamada');
    expect(normalizeUserIdInput('  Alice_Yamada  ')).toBe('Alice_Yamada');
    const a = normalizeUserIdInput('  Alice_Yamada  ');
    const b = normalizeUserIdInput('ALICE_YAMADA  ');
    expect(a.toLowerCase()).toBe(b.toLowerCase()); // same identity
    expect(a).not.toBe(b); // display case preserved
  });

  it('rejects exactly at the 1 and 21 character boundaries', () => {
    expect(validateUserIdInput('a').ok).toBe(false);
    expect(validateUserIdInput('ab').ok).toBe(true);
    expect(validateUserIdInput('x'.repeat(20)).ok).toBe(true);
    expect(validateUserIdInput('x'.repeat(21)).ok).toBe(false);
    expect(USER_ID_ERROR).toContain('2-20');
  });
});

describe('rule fixtures: display name', () => {
  it.each(DISPLAY_NAME_FIXTURE.map((v) => [JSON.stringify(v.input), v] as const))(
    'validates %s',
    (_label, vector) => {
      const result = validateDisplayNameInput(vector.input);
      expect(result.ok).toBe(vector.ok);
      if (vector.ok && result.ok) {
        expect(result.value).toBe(vector.normalized);
      } else if (!vector.ok && !result.ok) {
        expect(result.error).toBe(vector.error);
      }
    },
  );

  it('counts emoji and combining marks toward the 15-character limit', () => {
    expect(visualLength('\u{1F600}'.repeat(15))).toBe(15);
    expect(validateDisplayNameInput('\u{1F600}'.repeat(15)).ok).toBe(true);
    expect(validateDisplayNameInput('\u{1F600}'.repeat(16)).ok).toBe(false);
    expect(DISPLAY_NAME_FIXTURE).toHaveLength(19);
  });
});

describe('rule fixtures: introduction', () => {
  it.each(INTRODUCTION_FIXTURE.map((v) => [JSON.stringify(v.input), v] as const))(
    'validates %s',
    (_label, vector) => {
      const result = validateIntroductionInput(vector.input);
      expect(result.ok).toBe(vector.ok);
      if (vector.ok && result.ok) {
        expect(result.value).toBe(vector.normalized);
      } else if (!vector.ok && !result.ok) {
        expect(result.error).toBe(vector.error);
      }
    },
  );

  it('maps an empty introduction to deletion (null)', () => {
    expect(validateIntroductionInput('')).toEqual({ ok: true, value: null });
  });
});

describe('trimVisual', () => {
  it('matches ECMAScript String#trim, including ideographic spaces', () => {
    expect(trimVisual('  abc  ')).toBe('abc');
    expect(trimVisual('\u3000\u3000abc\u3000')).toBe('abc');
    expect(trimVisual('\u00A0abc\u00A0')).toBe('abc');
    expect(trimVisual('\n\tabc\r\n')).toBe('abc');
    expect(trimVisual('')).toBe('');
  });

  it('only trims the edges', () => {
    expect(trimVisual('a b')).toBe('a b');
    expect(trimVisual('a\nb')).toBe('a\nb');
  });
});

describe('validateRegistrationInput', () => {
  it('accepts a valid draft and returns both normalized values', () => {
    const result = validateRegistrationInput({
      userIdText: '  Alice_Yamada  ',
      displayName: '  花子 Hanako  ',
    });
    expect(result).toEqual({
      ok: true,
      value: { userIdText: 'Alice_Yamada', displayName: '花子 Hanako' },
    });
  });

  it('reports the User ID error first when both fields are invalid', () => {
    const result = validateRegistrationInput({
      userIdText: 'bad id',
      displayName: '   ',
    });
    expect(result).toEqual({ ok: false, error: USER_ID_ERROR });
  });

  it('reports the display name error when only it is invalid', () => {
    const result = validateRegistrationInput({
      userIdText: 'good_id',
      displayName: 'あ'.repeat(16),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(DISPLAY_NAME_TOO_LONG_ERROR);
  });
});
