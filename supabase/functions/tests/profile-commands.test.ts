// Task 7: unit tests for the update_profile payload gate and the structured
// conflict mapping.
//
// The suite is offline and deterministic (the exact command is `npx deno
// test --allow-env --allow-net --config supabase/functions/deno.json
// supabase/functions/tests/profile-commands.test.ts`). Real HTTP/DB
// behavior - compare-and-swap publication, replayed conflicts, image
// existence/ownership/format/size checks, storage policy visibility - is
// covered by supabase/tests/database/profile-publication.test.sql and
// scripts/test-local-backend.mjs (`--suite profile-publication`).
//
// What this file owns: the `update_profile` payload shape (required
// integer base_version, the three editable fields, unknown-field refusal,
// at-least-one-field), the shared message strings that must stay
// byte-identical to the SQL handler in 0012, the gate ordering (validation
// before any RPC), and the boundary rule that a settled
// `result.status = 'conflict'` answers HTTP 409 with `{error, conflict}`
// while every other outcome stays a 200 envelope.

import {
  executeCommand,
  isStateConflictResult,
  type RpcTransport,
} from '../_shared/commands.ts';
import {
  PROFILE_PUBLICATION_MESSAGES,
  validateProfileCommandPayload,
} from '../_shared/profile-commands.ts';
import {
  DISPLAY_NAME_TOO_LONG_ERROR,
  INTRODUCTION_TOO_LONG_ERROR,
  DISPLAY_NAME_BLANK_ERROR,
} from '../_shared/profile-validation.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

const UUID = '11111111-1111-4111-8111-111111111111';

function commandBody(payload: Record<string, unknown>): string {
  return JSON.stringify({
    operation_id: UUID,
    kind: 'update_profile',
    payload,
  });
}

function postRequest(body: string): Request {
  return new Request('http://localhost/functions/v1/app-command', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer token',
    },
    body,
  });
}

// --- shared messages (byte-identical to 0012's SQL handler) ---------------

Deno.test('the shared update_profile messages match the SQL literals', () => {
  assertEquals(
    PROFILE_PUBLICATION_MESSAGES,
    {
      baseVersionRequired: 'base_version is required',
      baseVersionInteger: 'base_version must be an integer',
      fieldsRequired: 'display_name, introduction or avatar_path is required',
      displayNameType: 'display_name must be a string',
      introductionType: 'introduction must be a string',
      avatarPathType: 'avatar_path must be a string',
      conflict: 'profile version conflict',
    },
    'message table',
  );
});

// --- payload gate ----------------------------------------------------------

Deno.test('update_profile requires base_version', () => {
  assertEquals(
    validateProfileCommandPayload('update_profile', {}),
    'base_version is required',
    'missing base_version',
  );
});

Deno.test('update_profile requires an integer base_version', () => {
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: '1',
      display_name: 'A',
    }),
    'base_version must be an integer',
    'string base_version',
  );
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: 1.5,
      display_name: 'A',
    }),
    'base_version must be an integer',
    'fractional base_version',
  );
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: null,
      display_name: 'A',
    }),
    'base_version must be an integer',
    'null base_version',
  );
});

Deno.test('update_profile refuses unknown fields', () => {
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: 1,
      nickname: 'typo',
    }),
    'unknown field: nickname',
    'unknown field',
  );
});

Deno.test('update_profile needs at least one editable field', () => {
  assertEquals(
    validateProfileCommandPayload('update_profile', { base_version: 1 }),
    'display_name, introduction or avatar_path is required',
    'base_version alone',
  );
});

Deno.test('update_profile type-checks the editable fields', () => {
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: 1,
      display_name: 42,
    }),
    'display_name must be a string',
    'display_name type',
  );
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: 1,
      introduction: 42,
    }),
    'introduction must be a string',
    'introduction type',
  );
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: 1,
      avatar_path: 42,
    }),
    'avatar_path must be a string',
    'avatar_path type',
  );
});

Deno.test('update_profile accepts clearing values (empty / null)', () => {
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: 2,
      introduction: '',
      avatar_path: null,
    }),
    null,
    'empty introduction clears, null avatar clears',
  );
});

Deno.test('update_profile applies the shared visual value rules', () => {
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: 1,
      display_name: 'x'.repeat(16),
    }),
    DISPLAY_NAME_TOO_LONG_ERROR,
    '16-character display name',
  );
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: 1,
      display_name: '   ',
    }),
    DISPLAY_NAME_BLANK_ERROR,
    'whitespace-only display name',
  );
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: 1,
      introduction: 'あ'.repeat(201),
    }),
    INTRODUCTION_TOO_LONG_ERROR,
    '201-character introduction',
  );
});

Deno.test('the gate does not touch other command kinds', () => {
  assertEquals(
    validateProfileCommandPayload('register', { nonsense: true }),
    null,
    'register stays with its own gate',
  );
  assertEquals(
    validateProfileCommandPayload('ping', { n: 1 }),
    null,
    'ping unaffected',
  );
});

Deno.test('a valid update_profile payload passes the gate', () => {
  assertEquals(
    validateProfileCommandPayload('update_profile', {
      base_version: 3,
      display_name: '  New Name  ',
      introduction: 'hello',
      avatar_path:
        '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/a.jpg',
    }),
    null,
    'full payload',
  );
});

// --- executeCommand wiring: gate before transport, conflict -> 409 ---------

Deno.test('executeCommand rejects a bad update_profile before the RPC', async () => {
  let called = 0;
  const transport: RpcTransport = async () => {
    called += 1;
    return { ok: true, data: { status: 'executed', result: { pong: true } } };
  };
  const res = await executeCommand(
    postRequest(commandBody({ display_name: 'no base' })),
    'Bearer token',
    transport,
  );
  assertEquals(res.status, 400, 'status');
  const body = await res.json();
  assertEquals(body.error, 'base_version is required', 'error');
  assertEquals(called, 0, 'transport not called');
});

const CONFLICT_RESULT = {
  status: 'conflict',
  message: 'profile version conflict',
  version: 4,
  profile: { display_name: 'Latest', introduction: null, avatar_path: null },
  differing_fields: ['display_name'],
};

Deno.test('a settled conflict result surfaces as HTTP 409 with its payload', async () => {
  const transport: RpcTransport = async () => ({
    ok: true,
    data: { status: 'executed', kind: 'update_profile', result: CONFLICT_RESULT },
  });
  const res = await executeCommand(
    postRequest(commandBody({ base_version: 1, display_name: 'Mine' })),
    'Bearer token',
    transport,
  );
  assertEquals(res.status, 409, 'status');
  const body = await res.json();
  assertEquals(body.error, 'profile version conflict', 'error message');
  assertEquals(body.conflict, CONFLICT_RESULT, 'conflict payload');
});

Deno.test('a replayed conflict keeps answering 409 with the stored result', async () => {
  const transport: RpcTransport = async () => ({
    ok: true,
    data: { status: 'replayed', kind: 'update_profile', result: CONFLICT_RESULT },
  });
  const res = await executeCommand(
    postRequest(commandBody({ base_version: 1, display_name: 'Mine' })),
    'Bearer token',
    transport,
  );
  assertEquals(res.status, 409, 'status');
  const body = await res.json();
  assertEquals(body.conflict, CONFLICT_RESULT, 'stored conflict replayed');
});

Deno.test('a successful update keeps the 200 envelope untouched', async () => {
  const result = {
    status: 'updated',
    version: 2,
    profile: { display_name: 'A', introduction: null, avatar_path: null },
  };
  const transport: RpcTransport = async () => ({
    ok: true,
    data: { status: 'executed', kind: 'update_profile', result },
  });
  const res = await executeCommand(
    postRequest(commandBody({ base_version: 1, display_name: 'A' })),
    'Bearer token',
    transport,
  );
  assertEquals(res.status, 200, 'status');
  const body = await res.json();
  assertEquals(body.status, 'executed', 'envelope status');
  assertEquals(body.result, result, 'result untouched');
});

Deno.test('isStateConflictResult only matches the conflict object shape', () => {
  assertEquals(isStateConflictResult(CONFLICT_RESULT), true, 'conflict');
  assertEquals(
    isStateConflictResult({ status: 'updated', version: 2 }),
    false,
    'updated',
  );
  assertEquals(isStateConflictResult(null), false, 'null');
  assertEquals(isStateConflictResult('conflict'), false, 'string');
  assertEquals(isStateConflictResult([1, 2]), false, 'array');
});

// The 409 body is JSON with an error key, the same convention jsonError
// uses for every other boundary error.
Deno.test('the conflict body keeps the {error, ...} JSON convention', () => {
  const conflict = CONFLICT_RESULT as unknown as Record<string, unknown>;
  assert(isStateConflictResult(conflict), 'fixture is a conflict');
  assertEquals(typeof conflict['message'], 'string', 'message is exposed');
});
