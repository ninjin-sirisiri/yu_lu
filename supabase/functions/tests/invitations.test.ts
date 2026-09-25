// Task 6: unit tests for the invitation payload gates and their wiring.
//
// The suite is offline and deterministic (the exact command is `npx deno
// test --allow-env --allow-net --config supabase/functions/deno.json
// supabase/functions/tests/invitations.test.ts`). Real HTTP/DB behavior -
// issuance, one-transaction reissue, expiry on server time, concurrent
// reissue, multi-person reuse and enumeration closure - is covered by
// supabase/tests/database/invitations.test.sql and
// scripts/test-local-backend.mjs (`--suite invitations`).
//
// What this file owns: the three invitation command kinds (empty payloads),
// the optional invitation_token on the `request` command, the required
// token on `resolve_invitation`, the shared message strings that must stay
// byte-identical to the SQL handlers in 0011, and the gate ordering
// (validation before any RPC).

import { executeCommand } from '../_shared/commands.ts';
import {
  INVITATION_COMMAND_KINDS,
  INVITATION_MESSAGES,
  INVITATION_TOKEN_RE,
  readInvitationTokenField,
  validateInvitationCommandPayload,
} from '../_shared/invitation-commands.ts';
import {
  executeQuery,
  QUERY_OPS,
  validateQueryPayload,
} from '../_shared/queries.ts';
import { validateRequestCommandPayload } from '../_shared/request-commands.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

const UUID = '11111111-1111-4111-8111-111111111111';
const FIXTURE_TOKEN = '0123456789abcdef0123456789abcdef';

// --- token contract --------------------------------------------------------

Deno.test('the token contract is 32 lowercase hex characters', () => {
  assertEquals(INVITATION_TOKEN_RE.test(FIXTURE_TOKEN), true, 'a minted token passes');
  assertEquals(
    INVITATION_TOKEN_RE.test(FIXTURE_TOKEN.toUpperCase()),
    false,
    'uppercase hex is not accepted (tokens are stored lowercase)',
  );
  assertEquals(
    INVITATION_TOKEN_RE.test('0123456789abcdef0123456789abcde'),
    false,
    '31 characters fail',
  );
  assertEquals(
    INVITATION_TOKEN_RE.test('0123456789abcdef0123456789abcdeg'),
    false,
    'non-hex characters fail',
  );
  // 32 hex chars = 128 bits, the floor the brief requires.
  assert(FIXTURE_TOKEN.length * 4 >= 128, 'at least 128 bits of entropy space');
});

// --- command kinds ---------------------------------------------------------

Deno.test('the three invitation kinds are the registered set', () => {
  assertEquals(
    [...INVITATION_COMMAND_KINDS],
    ['get_or_create_invitation', 'reissue_invitation', 'invalidate_invitation'],
    'kind list',
  );
});

Deno.test('invitation commands take empty payloads', () => {
  for (const kind of INVITATION_COMMAND_KINDS) {
    assertEquals(
      validateInvitationCommandPayload(kind, {}),
      null,
      `${kind}: empty payload passes`,
    );
    // Unknown fields are the registry's business, not this gate's - the
    // shape rules live in SQL where the actor is known.
    assertEquals(
      validateInvitationCommandPayload(kind, { stray: 1 }),
      null,
      `${kind}: unknown fields are left to the handler`,
    );
  }
  assertEquals(
    validateInvitationCommandPayload('unknown_kind', {}),
    null,
    'unknown kinds are left to the handler registry',
  );
});

// --- optional token on the request command ---------------------------------

Deno.test('the request command accepts an absent, null or valid token', () => {
  assertEquals(
    validateRequestCommandPayload('request', { target_user_id: UUID }),
    null,
    'no token: a plain apply still passes',
  );
  assertEquals(
    validateRequestCommandPayload('request', {
      target_user_id: UUID,
      invitation_token: null,
    }),
    null,
    'an explicit JSON null is treated as absent',
  );
  assertEquals(
    validateRequestCommandPayload('request', {
      target_user_id: UUID,
      invitation_token: FIXTURE_TOKEN,
    }),
    null,
    'a well-formed token passes the shape gate',
  );
});

Deno.test('the request command refuses a malformed token', () => {
  assertEquals(
    validateRequestCommandPayload('request', {
      target_user_id: UUID,
      invitation_token: 42,
    }),
    INVITATION_MESSAGES.tokenType,
    'a non-string token is refused',
  );
  assertEquals(
    validateRequestCommandPayload('request', {
      target_user_id: UUID,
      invitation_token: 'not-a-token',
    }),
    INVITATION_MESSAGES.tokenFormat,
    'a malformed token is refused',
  );
  // Target error still wins: the field order matches the SQL handler.
  assertEquals(
    validateRequestCommandPayload('request', { invitation_token: 'x' }),
    'target_user_id is required',
    'a missing target is reported before the token',
  );
});

Deno.test('the token field reader matches the SQL readers', () => {
  assertEquals(
    readInvitationTokenField({}, { required: true }),
    INVITATION_MESSAGES.tokenRequired,
    'required and absent -> required message',
  );
  assertEquals(
    readInvitationTokenField({ invitation_token: null }, { required: true }),
    INVITATION_MESSAGES.tokenType,
    'required and null -> type message (parity with payload_token_required)',
  );
  assertEquals(
    readInvitationTokenField({ invitation_token: FIXTURE_TOKEN }, { required: true }),
    null,
    'required and present -> null',
  );
  assertEquals(
    readInvitationTokenField({}, { required: false }),
    null,
    'optional and absent -> null',
  );
  assertEquals(
    readInvitationTokenField({ invitation_token: null }, { required: false }),
    null,
    'optional and null -> null (parity with payload_token_optional)',
  );
});

// --- resolve / status query gates ------------------------------------------

Deno.test('resolve_invitation demands an exact-format token', () => {
  assertEquals(
    validateQueryPayload('resolve_invitation', {}),
    INVITATION_MESSAGES.tokenRequired,
    'a missing token is refused',
  );
  assertEquals(
    validateQueryPayload('resolve_invitation', { invitation_token: 7 }),
    INVITATION_MESSAGES.tokenType,
    'a non-string token is refused',
  );
  assertEquals(
    validateQueryPayload('resolve_invitation', {
      invitation_token: 'ABCDEF0123456789ABCDEF0123456789',
    }),
    INVITATION_MESSAGES.tokenFormat,
    'an uppercase token is refused',
  );
  assertEquals(
    validateQueryPayload('resolve_invitation', { invitation_token: FIXTURE_TOKEN }),
    null,
    'a well-formed token passes',
  );
});

Deno.test('get_invitation_status takes no fields', () => {
  assertEquals(
    validateQueryPayload('get_invitation_status', {}),
    null,
    'empty payload passes',
  );
  assertEquals(
    validateQueryPayload('get_invitation_status', { invitation_token: FIXTURE_TOKEN }),
    null,
    'the gate does not judge fields the handler ignores',
  );
  assert(
    (QUERY_OPS as readonly string[]).includes('resolve_invitation') &&
      (QUERY_OPS as readonly string[]).includes('get_invitation_status'),
    'both invitation ops are in the closed list',
  );
});

// --- shared messages stay byte-identical to the SQL handlers ---------------

Deno.test('invitation messages match the SQL handlers', () => {
  // These strings are asserted verbatim in
  // supabase/tests/database/invitations.test.sql; drift on either side
  // fails the pgTAP suite, drift on this side fails here.
  assertEquals(
    INVITATION_MESSAGES.tokenRequired,
    'invitation_token is required',
    'token required',
  );
  assertEquals(
    INVITATION_MESSAGES.tokenType,
    'invitation_token must be a string',
    'token type',
  );
  assertEquals(
    INVITATION_MESSAGES.tokenFormat,
    'invitation_token must be a 32-character lowercase hexadecimal string',
    'token format',
  );
  assertEquals(
    INVITATION_MESSAGES.notFound,
    'invitation not found',
    'unknown token message',
  );
  assertEquals(
    INVITATION_MESSAGES.notForTarget,
    'This invitation is for a different user.',
    'mismatched inviter message',
  );
  assertEquals(
    INVITATION_MESSAGES.invalidated,
    'This invitation is no longer valid. Ask for a new invitation.',
    'invalidated guidance',
  );
  assertEquals(
    INVITATION_MESSAGES.expired,
    'This invitation expired. Ask for a new invitation.',
    'expiry guidance (byte-identical to app/src/invitations/open.ts)',
  );
  assertEquals(
    INVITATION_MESSAGES.notRegistered,
    'Confirm the User ID before using the app.',
    'registration gate message',
  );
});

// --- gate ordering ---------------------------------------------------------

function postCommand(body: string): Request {
  return new Request('http://localhost/functions/v1/app-command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

function postQuery(body: string): Request {
  return new Request('http://localhost/functions/v1/app-query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

Deno.test('a malformed invitation_token on request fails before any RPC', async () => {
  const res = await executeCommand(
    postCommand(JSON.stringify({
      operation_id: UUID,
      kind: 'request',
      payload: { target_user_id: UUID, invitation_token: 'nope' },
    })),
    'Bearer tok',
    () => {
      throw new Error('transport must not run');
    },
  );
  assertEquals(res.status, 400, 'status');
  const body = await res.json();
  assertEquals(body.error, INVITATION_MESSAGES.tokenFormat, 'error message');
});

Deno.test('an invitation command reaches the RPC unchanged', async () => {
  let seen: unknown = null;
  const res = await executeCommand(
    postCommand(JSON.stringify({
      operation_id: UUID,
      kind: 'get_or_create_invitation',
      payload: {},
    })),
    'Bearer user-jwt',
    async (args) => {
      seen = args;
      return {
        ok: true,
        data: {
          status: 'executed',
          kind: 'get_or_create_invitation',
          result: { result: 'created', invitation_token: FIXTURE_TOKEN },
        },
      };
    },
  );
  assertEquals(res.status, 200, 'status');
  assertEquals(
    seen,
    {
      p_operation_id: UUID,
      p_kind: 'get_or_create_invitation',
      p_payload: {},
    },
    'rpc args',
  );
});

Deno.test('the resolve gate rejects before any RPC', async () => {
  const res = await executeQuery(
    postQuery(JSON.stringify({ op: 'resolve_invitation', payload: {} })),
    'Bearer tok',
    () => {
      throw new Error('transport must not run');
    },
  );
  assertEquals(res.status, 400, 'status');
  const body = await res.json();
  assertEquals(body.error, INVITATION_MESSAGES.tokenRequired, 'error message');
});

Deno.test('a valid resolve reaches the RPC unchanged', async () => {
  let seen: unknown = null;
  const res = await executeQuery(
    postQuery(JSON.stringify({
      op: 'resolve_invitation',
      payload: { invitation_token: FIXTURE_TOKEN },
    })),
    'Bearer user-jwt',
    async (args) => {
      seen = args;
      return {
        ok: true,
        data: {
          op: 'resolve_invitation',
          result: {
            status: 'valid',
            inviter: { user_id: UUID, user_id_text: 'inv_one' },
          },
        },
      };
    },
  );
  assertEquals(res.status, 200, 'status');
  assertEquals(
    seen,
    {
      p_op: 'resolve_invitation',
      p_payload: { invitation_token: FIXTURE_TOKEN },
    },
    'rpc args',
  );
});

Deno.test('an invitation state conflict surfaces as HTTP 409', async () => {
  const res = await executeCommand(
    postCommand(JSON.stringify({
      operation_id: '22222222-2222-4222-8222-222222222222',
      kind: 'request',
      payload: { target_user_id: UUID, invitation_token: FIXTURE_TOKEN },
    })),
    'Bearer tok',
    async () => ({
      ok: false,
      code: '23505',
      message: INVITATION_MESSAGES.invalidated,
    }),
  );
  assertEquals(res.status, 409, 'status');
  const body = await res.json();
  assertEquals(body.error, INVITATION_MESSAGES.invalidated, 'error message');
});

Deno.test('an unknown token maps to HTTP 404', async () => {
  const res = await executeQuery(
    postQuery(JSON.stringify({
      op: 'resolve_invitation',
      payload: { invitation_token: FIXTURE_TOKEN },
    })),
    'Bearer tok',
    async () => ({
      ok: false,
      code: 'P0002',
      message: INVITATION_MESSAGES.notFound,
    }),
  );
  assertEquals(res.status, 404, 'status');
  const body = await res.json();
  assertEquals(body.error, INVITATION_MESSAGES.notFound, 'error message');
});
