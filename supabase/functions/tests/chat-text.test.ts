import { chatVisualLength, normalizeChatBody, validateChatBody } from '../_shared/chat-text.ts';
import corpus from '../../../scripts/data/unicode/17.0.0/grapheme-break-tests.generated.json' with { type: 'json' };

function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label);
}

Deno.test('all official Unicode 17 vectors and prefix boundaries conform in Edge', () => {
  equal(corpus.length, 766, 'complete official corpus');
  for (const { points, breaks, line } of corpus) {
    for (let end = 1; end <= points.length; end += 1) {
      const text = String.fromCodePoint(...points.slice(0, end));
      const expected = breaks.filter((offset) => offset < end).length;
      equal(chatVisualLength(text), expected, `Edge Unicode line ${line}, prefix ${end}`);
    }
  }
});

Deno.test('normalization, White_Space, images and cluster limits use the shared contract', () => {
  equal(normalizeChatBody(' x\r\ny\r '), ' x\ny\n ', 'LF without trimming');
  for (const text of ['', '\u0085', '\u00a0', '\u2028\u2029', '\u3000']) {
    equal(validateChatBody(text, 0).ok, false, 'White_Space-only refused');
    equal(validateChatBody(text, 1).ok, true, 'White_Space with image allowed');
  }
  for (const images of [5, -1, 0.5, NaN, Infinity]) equal(validateChatBody('x', images).ok, false, 'invalid image count');
  equal(validateChatBody(' x\r\n ', 0), { ok: true, value: ' x\n ' }, 'normalized value retained');
  equal(validateChatBody('\u0085', 0).ok, false, 'Unicode NEL is White_Space');
  equal(validateChatBody('\ufeff', 0).ok, true, 'BOM is not White_Space');
  equal(validateChatBody('', 4).ok, true, 'image-only');
  equal(validateChatBody('x', 5).ok, false, 'image limit');
  for (const cluster of ['a\u0301', '\u0600a', '\u0915\u094d\u0915', '👩\u200d👩', '🇯🇵', '\n']) {
    equal(validateChatBody(cluster.repeat(10000), 1).ok, true, '10,000 accepted');
    equal(validateChatBody(cluster.repeat(10001), 1).ok, false, '10,001 refused');
  }
});
