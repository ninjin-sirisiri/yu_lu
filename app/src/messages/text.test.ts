import { chatVisualLength, normalizeChatBody, validateChatBody } from './text';
import corpus from '../../../scripts/data/unicode/17.0.0/grapheme-break-tests.generated.json';

describe('Unicode 17.0.0 chat text', () => {
  test.each([
    ['combining', 'a\u0301', 1],
    ['Prepend', '\u0600a', 1],
    ['GB9c', '\u0915\u094d\u0915', 1],
    ['GB9c requires a linker', '\u0915\u093c\u0915', 2],
    ['GB11', '👩\u0301\u200d👩', 1],
    ['GB11 requires an earlier pictograph', 'a\u200d👩', 2],
    ['GB11 cannot skip SpacingMark', '👩\u0903\u200d👩', 2],
    ['GB11 uses exact pictographic data', '👩\u200d\u2606', 2],
    ['flags pair left to right', '🇯🇵🇺', 2],
    ['LF breaks before combining marks', 'a\n\u0301b', 4],
    ['Hangul', '\u1100\u1161\u11a8', 1],
    ['empty', '', 0],
  ])('%s', (_name, text, count) => {
    expect(chatVisualLength(text)).toBe(count);
  });

  test('normalizes CRLF and CR to LF without trimming or Unicode normalization', () => {
    expect(normalizeChatBody(' a\r\nb\rc\n a\u0301 ')).toBe(' a\nb\nc\n a\u0301 ');
    expect(chatVisualLength('a\r\nb\rc')).toBe(5);
  });

  test('rejects every Unicode White_Space-only body without an image', () => {
    const spaces = '\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
    for (const space of spaces) expect(validateChatBody(space, 0).ok).toBe(false);
    expect(validateChatBody('', 0).ok).toBe(false);
    expect(validateChatBody(spaces, 1).ok).toBe(true);
    // Neither BOM nor ZWSP is White_Space (String.trim is not the contract).
    expect(validateChatBody('\ufeff', 0).ok).toBe(true);
    expect(validateChatBody('\u200b', 0).ok).toBe(true);
    expect(validateChatBody(' x\r\n ', 0)).toEqual({ ok: true, value: ' x\n ' });
  });

  test('validates image-only messages and refuses invalid image counts', () => {
    expect(validateChatBody('', 4)).toEqual({ ok: true, value: '' });
    for (const count of [-1, 5, 0.5, NaN, Infinity]) {
      expect(validateChatBody('x', count).ok).toBe(false);
    }
  });

  test('enforces the actual 10,000-cluster boundary even with images', () => {
    for (const cluster of ['a\u0301', '\u0600a', '\u0915\u094d\u0915', '👩\u200d👩', '🇯🇵', '\n']) {
      expect(validateChatBody(cluster.repeat(10000), 1).ok).toBe(true);
      expect(validateChatBody(cluster.repeat(10001), 1).ok).toBe(false);
    }
  });

  test('passes every official GraphemeBreakTest vector and every prefix boundary', () => {
    expect(corpus.length).toBe(766);
    for (const { points, breaks, line } of corpus) {
      for (let end = 1; end <= points.length; end += 1) {
        const expected = breaks.filter((offset) => offset < end).length;
        expect({ line, end, count: chatVisualLength(String.fromCodePoint(...points.slice(0, end))) })
          .toEqual({ line, end, count: expected });
      }
    }
  });
});
