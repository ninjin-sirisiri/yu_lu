// Task 3: offline tests for the shared profile-validation rules (Edge).
//
// The suite is deterministic and offline (exact command:
// `npx deno test --allow-env --allow-net --config supabase/functions/deno.json
// supabase/functions/tests/profile-validation.test.ts`). What it owns:
// - the Edge implementation agrees with the client implementation
//   (app/src/profiles/validation.ts) on every shared fixture vector, so a
//   rule edited on one side without the other fails here;
// - both agree with the Intl.Segmenter oracle (Deno provides it), which is
//   how the fixture's expected grapheme counts were derived;
// - the payload gate routes register/mark_onboarding_seen and rejects with
//   the byte-identical messages the SQL handlers raise;
// - real HTTP/DB behavior is covered by
//   supabase/tests/database/registration.test.sql (pgTAP) and
//   scripts/test-local-backend.mjs --suite registration.

import {
  DISPLAY_NAME_REQUIRED_ERROR,
  DISPLAY_NAME_TYPE_ERROR,
  USER_ID_ERROR,
  USER_ID_REQUIRED_ERROR,
  USER_ID_TYPE_ERROR,
  validateCommandPayload,
  validateDisplayNameInput,
  validateIntroductionInput,
  validateRegisterPayload,
  trimVisual as edgeTrim,
  validateUserIdInput,
  visualLength,
} from '../_shared/profile-validation.ts';
import {
  DISPLAY_NAME_FIXTURE as CLIENT_NAME_FIXTURE,
  INTRODUCTION_FIXTURE as CLIENT_INTRO_FIXTURE,
  USER_ID_FIXTURE as CLIENT_ID_FIXTURE,
  VISUAL_LENGTH_FIXTURE,
  trimVisual as clientTrim,
  validateDisplayNameInput as clientValidateDisplayName,
  validateIntroductionInput as clientValidateIntroduction,
  validateUserIdInput as clientValidateUserId,
  visualLength as clientVisualLength,
} from '../../../app/src/profiles/validation.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

const FAMILY = String.fromCodePoint(
  0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466,
);
const COMBINING = 'a\u0301';

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
function intlLength(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n += 1;
  return n;
}

// --- shared fixture: visual length ----------------------------------------

Deno.test('Edge visualLength matches every shared fixture vector', () => {
  for (const vector of VISUAL_LENGTH_FIXTURE) {
    assertEquals(
      visualLength(vector.text),
      vector.graphemes,
      `fixture vector ${JSON.stringify(vector.text).slice(0, 40)}`,
    );
  }
});

Deno.test('Edge visualLength agrees with the Intl.Segmenter oracle', () => {
  for (const vector of VISUAL_LENGTH_FIXTURE) {
    assertEquals(
      visualLength(vector.text),
      intlLength(vector.text),
      `oracle vector ${JSON.stringify(vector.text).slice(0, 40)}`,
    );
  }
});

Deno.test('Edge and client implementations count identically', () => {
  const corpus = [
    ...VISUAL_LENGTH_FIXTURE.map((v) => v.text),
    'こんにちは世界',
    'A\u0301E\u0301',
    '한글',
    '각',
    `${FAMILY}${FAMILY} tail`,
    'a\u200Db',
    '\u{1f1ef}\u{1f1f1}\u{1f1f0}', // odd regional-indicator run
    `${COMBINING}${COMBINING}`,
    'a\r\nb\tc',
    'ｱｲｳ',
    '\u304b\u3099',
  ];
  for (const text of corpus) {
    assertEquals(visualLength(text), clientVisualLength(text), JSON.stringify(text).slice(0, 40));
    assertEquals(visualLength(text), intlLength(text), `oracle ${JSON.stringify(text).slice(0, 40)}`);
  }
});

Deno.test('a newline counts as one visual character', () => {
  assertEquals(visualLength('\n'), 1, 'lone newline');
  assertEquals(visualLength('a\n'.repeat(100)), 200, 'newlines count as 1');
  assertEquals(visualLength(FAMILY), 1, 'ZWJ family is one character');
  assertEquals(visualLength(COMBINING), 1, 'combining mark is one character');
});

// --- shared fixture: rule vectors -----------------------------------------

Deno.test('Edge and client validate User IDs identically', () => {
  assertEquals(CLIENT_ID_FIXTURE.length, 17, 'fixture size unchanged');
  for (const vector of CLIENT_ID_FIXTURE) {
    const edge = validateUserIdInput(vector.input);
    const client = clientValidateUserId(vector.input);
    assertEquals(edge, client, `drift for ${JSON.stringify(vector.input)}`);
    assertEquals(edge.ok, vector.ok, `ok flag for ${JSON.stringify(vector.input)}`);
    if (vector.ok && edge.ok) {
      assertEquals(edge.value, vector.normalized, 'normalized value');
    } else if (!edge.ok) {
      assertEquals(edge.error, vector.error ?? USER_ID_ERROR, 'error message');
    }
  }
});

Deno.test('Edge and client validate display names identically', () => {
  assertEquals(CLIENT_NAME_FIXTURE.length, 19, 'fixture size unchanged');
  for (const vector of CLIENT_NAME_FIXTURE) {
    const edge = validateDisplayNameInput(vector.input);
    const client = clientValidateDisplayName(vector.input);
    assertEquals(edge, client, `drift for ${JSON.stringify(vector.input)}`);
    assertEquals(edge.ok, vector.ok, `ok flag for ${JSON.stringify(vector.input)}`);
    if (vector.ok && edge.ok) {
      assertEquals(edge.value, vector.normalized, 'normalized value');
    } else if (!edge.ok) {
      assert(vector.error !== undefined, 'rejection carries an expected message');
      assertEquals(edge.error, vector.error, 'error message');
    }
  }
});

Deno.test('Edge and client validate introductions identically', () => {
  assertEquals(CLIENT_INTRO_FIXTURE.length, 9, 'fixture size unchanged');
  for (const vector of CLIENT_INTRO_FIXTURE) {
    const edge = validateIntroductionInput(vector.input);
    const client = clientValidateIntroduction(vector.input);
    assertEquals(edge, client, `drift for ${JSON.stringify(vector.input).slice(0, 40)}`);
    assertEquals(edge.ok, vector.ok, 'ok flag');
    if (vector.ok && edge.ok) {
      assertEquals(edge.value, vector.normalized, 'normalized value (null = deleted)');
    } else if (!edge.ok) {
      assertEquals(edge.error, vector.error, 'error message');
    }
  }
});

Deno.test('trim rules match ECMAScript String#trim on both sides', () => {
  const tricky = [
    '  padded  ',
    '\u3000\u3000padded\u3000',
    '\u00a0padded\u00a0',
    '\n\tpadded\r\n',
    'a\u3000b',
    '',
  ];
  for (const text of tricky) {
    assertEquals(text.trim(), clientTrim(text), 'client trim');
    assertEquals(text.trim(), edgeTrim(text), 'edge trim');
  }
});

// --- payload gate ----------------------------------------------------------

Deno.test('a valid register payload passes the gate', () => {
  assertEquals(
    validateRegisterPayload({
      user_id_text: '  Alice_Yamada  ',
      display_name: '  花子 Hanako  ',
    }),
    null,
    'valid payload',
  );
});

Deno.test('the gate reports missing and non-string fields', () => {
  assertEquals(
    validateRegisterPayload({ display_name: 'Hanako' }),
    USER_ID_REQUIRED_ERROR,
    'missing user_id_text',
  );
  assertEquals(
    validateRegisterPayload({ user_id_text: 'hanako' }),
    DISPLAY_NAME_REQUIRED_ERROR,
    'missing display_name',
  );
  assertEquals(
    validateRegisterPayload({ user_id_text: 42, display_name: 'Hanako' }),
    USER_ID_TYPE_ERROR,
    'non-string user_id_text',
  );
  assertEquals(
    validateRegisterPayload({ user_id_text: 'hanako', display_name: 42 }),
    DISPLAY_NAME_TYPE_ERROR,
    'non-string display_name',
  );
});

Deno.test('the gate applies the shared rule messages', () => {
  assertEquals(
    validateRegisterPayload({ user_id_text: 'a', display_name: 'Hanako' }),
    USER_ID_ERROR,
    'short User ID',
  );
  assertEquals(
    validateRegisterPayload({ user_id_text: 'hanako', display_name: '   ' }),
    'Display name must not be blank.',
    'blank display name',
  );
  assertEquals(
    validateRegisterPayload({
      user_id_text: 'hanako',
      display_name: 'a\nb',
    }),
    'Display name must not contain a newline.',
    'newline display name',
  );
  assertEquals(
    validateRegisterPayload({
      user_id_text: 'hanako',
      display_name: 'あ'.repeat(16),
    }),
    'Display name must be 15 visual characters or fewer.',
    '16 visual characters',
  );
  assertEquals(
    validateRegisterPayload({
      user_id_text: 'hanako',
      display_name: FAMILY.repeat(16),
    }),
    'Display name must be 15 visual characters or fewer.',
    '16 ZWJ families',
  );
  assertEquals(
    validateRegisterPayload({
      user_id_text: 'hanako',
      display_name: COMBINING.repeat(16),
    }),
    'Display name must be 15 visual characters or fewer.',
    '16 combining characters',
  );
});

Deno.test('the gate passes 15-grapheme boundaries', () => {
  assertEquals(
    validateRegisterPayload({
      user_id_text: 'hanako',
      display_name: FAMILY.repeat(15),
    }),
    null,
    '15 ZWJ families accepted',
  );
  assertEquals(
    validateRegisterPayload({
      user_id_text: 'x'.repeat(20),
      display_name: 'あ'.repeat(15),
    }),
    null,
    '20-char User ID and 15-char display accepted',
  );
});

Deno.test('validateCommandPayload routes only the registered kinds', () => {
  assertEquals(
    validateCommandPayload('register', { user_id_text: 'ab', display_name: 'A' }),
    null,
    'valid register',
  );
  assertEquals(
    validateCommandPayload('register', {}),
    USER_ID_REQUIRED_ERROR,
    'register with empty payload',
  );
  assertEquals(
    validateCommandPayload('mark_onboarding_seen', {}),
    null,
    'onboarding command has no fields',
  );
  assertEquals(
    validateCommandPayload('ping', { n: 1 }),
    null,
    'unknown kinds fall through to the database registry',
  );
  assertEquals(
    validateCommandPayload('other_kind', { n: 1 }),
    null,
    'unregistered kinds are not gated here',
  );
});

Deno.test('extra payload keys are ignored like the SQL handler ignores them', () => {
  assertEquals(
    validateRegisterPayload({
      user_id_text: 'hanako',
      display_name: 'Hanako',
      introduction: 'set later',
      future_field: true,
    }),
    null,
    'unknown keys do not trip the gate',
  );
});
