# Friend Registration and Approval Implementation Plan

**Goal:** Build OAuth registration, profiles, discovery, invitations, friend requests, and zero-friend handling for iOS and Android.

**Architecture:** The Expo client talks to Supabase for Auth, data, image storage, and push integration. One migration owns new registration tables and profile extensions. Server-side functions own uniqueness, transitions, friendship creation, and expiry. The client owns session, confirmation, inbox and outbox, invitation return, and zero-friend guidance.

**Tech Stack:** Expo React Native TypeScript, Supabase Postgres Auth Storage Edge Functions pg_cron, EAS Build, Expo Notifications with FCM and APNs, Jest

**Spec:** docs/sdd/specs/2026-09-11-friend-registration-approval-design.md

## Global Constraints

- Auth uses Apple or Google OAuth only.
- No shared mandatory contact.
- Apple and Google logins that share the same verified email are accepted as one account under Supabase Auth standard behavior.
- OAuth logins with different emails are never auto-linked.
- Adding a different-email method requires explicit linking after signing into the existing account and verifying the new method.
- Do not use Apple private relay addresses for contact purposes.
- Do not allow app use before User ID confirmation.
- Do not allow User ID changes after confirmation.
- User ID reservation hold: None.
- User ID case handling: Case-insensitive identity with display preserved.
- User ID collisions reject confirmation and suggest similar IDs.
- Do not create a separate add code apart from the User ID.
- Invitation validity: 7 days.
- Friend Request validity: 7 days.
- Expired Invitations cannot start a request and guide the user to reissue.
- Expired requests lapse automatically and guide the user to re-request.
- Recipient approval establishes friendship, while crossed requests establish immediately with notice to both.
- Related requests are cleared at establishment.
- No unanswered request remains after friendship establishment.
- Expiry, cancellation, and rejection never establish friendship.
- A duplicate request is never created while one is pending.
- Duplicate requests guide the user to the existing pending request.
- Rejection reason and timing are never disclosed.
- Rejection display contains no reason or timing.
- Blocked recipients accept no new request until unblock.
- Blocked recipients reject new requests and accept re-request after unblock.
- Request-only partners cannot be blocked.
- Block and delete are allowed only for established Friends.
- Keep delete and report from affecting re-request eligibility.
- Do not apply rate limits to requests or searches in the first version.
- Do not use friend or display-name information for operator identity verification.
- Do not offer email or SMS authentication, passwords, recovery codes, or operator recovery.
- Do not merge two separately created accounts.
- New friendships apply from the next daily draw.
- A zero-friend day creates no assignment, preserves the Streak, and allows read-only access to prior history.
- Zero-friend days stay out of the draw and preserve the Streak.
- Show the current Streak count only to established Friends.
- Show per-partner progress only to the user.
- Never show per-partner send and reply state to others.
- Support Japanese and Japan time in notifications and guidance.

## File structure

- `app/src/auth/session.ts`
- `app/src/auth/session.test.ts`
- `app/src/profiles/registration.ts`
- `app/src/profiles/registration.test.ts`
- `app/src/profiles/edit.ts`
- `app/src/profiles/edit.test.ts`
- `app/src/discovery/lookup.ts`
- `app/src/discovery/lookup.test.ts`
- `app/src/invitations/share.ts`
- `app/src/invitations/share.test.ts`
- `app/src/invitations/open.ts`
- `app/src/invitations/open.test.ts`
- `app/src/requests/outbox.ts`
- `app/src/requests/outbox.test.ts`
- `app/src/requests/inbox.ts`
- `app/src/requests/inbox.test.ts`
- `app/src/requests/zeroFriends.ts`
- `app/src/requests/zeroFriends.test.ts`
- `supabase/migrations/0005_friend_registration.sql`
- `supabase/functions/friendship-admin/index.ts`
- `supabase/functions/request-expiry/index.ts`
- `supabase/seed.friend-registration.test.sql`
- `docs/sdd/specs/2026-09-11-friend-registration-approval-design.md`

## Task 1: Registration data model and server transitions

Create the registration data model, User ID uniqueness, request transitions, friendship creation, and expiry in `supabase/migrations/0005_friend_registration.sql`. This task owns the registration schema and server-side data rules. Later tasks only read and call this model.

1. Create the next sequential migration file.
```bash
npx supabase@latest migration new friend_registration
```

2. Extend `profiles` with the searchable User ID, display profile fields, and completion state. Keep existing `user_id`, `display_name`, and `created_at` unchanged.
```sql
alter table profiles
  add column user_id_text text,
  add column avatar_path text,
  add column introduction text,
  add column user_id_confirmed_at timestamptz;
```

3. Enforce case-insensitive User ID identity while preserving display. Require User ID confirmation before use.
```sql
alter table profiles
  add constraint profiles_user_id_text_not_blank
  check (user_id_text is null or char_length(btrim(user_id_text)) > 0);

create unique index profiles_user_id_text_unique
  on profiles (lower(user_id_text))
  where user_id_text is not null;
```

4. Create pending invitations with a 7-day validity.
```sql
create table invitations (
  invitation_id uuid primary key default gen_random_uuid(),
  inviter_user_id uuid not null references profiles(user_id) on delete cascade,
  invitation_token text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  constraint invitations_expires_after_created check (expires_at > created_at)
);

create index invitations_inviter_created_idx
  on invitations (inviter_user_id, created_at desc);
```

5. Create friend requests with sender, recipient, state, and 7-day validity. Keep request-only pairs outside `friendships`.
```sql
create table friend_requests (
  request_id uuid primary key default gen_random_uuid(),
  sender_user_id uuid not null references profiles(user_id) on delete cascade,
  recipient_user_id uuid not null references profiles(user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  expires_at timestamptz not null,
  constraint friend_requests_no_self_request check (sender_user_id != recipient_user_id),
  constraint friend_requests_expires_after_created check (expires_at > created_at),
  constraint friend_requests_decided_when_not_pending check (
    (status = 'pending' and decided_at is null)
    or (status != 'pending' and decided_at is not null)
  )
);

create index friend_requests_recipient_pending_idx
  on friend_requests (recipient_user_id, created_at desc)
  where status = 'pending';

create index friend_requests_sender_pending_idx
  on friend_requests (sender_user_id, created_at desc)
  where status = 'pending';

create unique index friend_requests_one_pending_pair_idx
  on friend_requests (least(sender_user_id, recipient_user_id), greatest(sender_user_id, recipient_user_id))
  where status = 'pending';
```

6. Add canonical friendship creation that preserves `CHECK (user_a < user_b)`. Clear related pending requests at establishment.
```sql
create or replace function create_friendship_from_request(p_sender uuid, p_recipient uuid)
returns void
language plpgsql
as $$
declare
  v_first uuid;
  v_second uuid;
begin
  if p_sender = p_recipient then
    raise exception 'self friendship is not allowed';
  end if;

  if p_sender < p_recipient then
    v_first := p_sender;
    v_second := p_recipient;
  else
    v_first := p_recipient;
    v_second := p_sender;
  end if;

  insert into friendships (user_a, user_b)
  values (v_first, v_second)
  on conflict do nothing;

  update friend_requests
  set status = 'approved', decided_at = now()
  where status = 'pending'
    and (
      (sender_user_id = p_sender and recipient_user_id = p_recipient)
      or (sender_user_id = p_recipient and recipient_user_id = p_sender)
    );
end;
$$;
```

7. Add expiry handling that never establishes friendship.
```sql
create or replace function expire_friend_requests()
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  update friend_requests
  set status = 'expired', decided_at = now()
  where status = 'pending'
    and expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function expire_invitations()
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  update invitations
  set used_at = coalesce(used_at, now())
  where used_at is null
    and expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
```

8. Enable row level security on the new tables. Do not add policies in this task.
```sql
alter table invitations enable row level security;
alter table friend_requests enable row level security;
```

9. Verify the migration locally.
```bash
npx supabase@latest db push
npx supabase@latest db lint --level warning
```

Acceptance: `0005_friend_registration.sql` applies cleanly and creates User ID, invitation, request, transition, and expiry objects without changing existing friendship semantics.

## Task 2: Registration validation and profile editing rules

Implement User ID confirmation, duplicate suggestions, registration gating, and editable profile rules in `app/src/profiles/registration.ts` and `app/src/profiles/edit.ts`. This task owns profile validation and editing boundaries. Later tasks only call these validators.

1. Read the exact versioned Expo docs before writing code.
```text
https://docs.expo.dev/versions/v57.0.0/
```

2. Implement User ID normalization, blank rejection, confirmation gating, and similar-ID suggestions in `app/src/profiles/registration.ts`.
```typescript
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
```

3. Implement editable-field rules in `app/src/profiles/edit.ts`. User ID is immutable after confirmation.
```typescript
export const EDITABLE_PROFILE_FIELDS = ['display_name', 'avatar_path', 'introduction'] as const;

export function assertEditableProfileField(field: string): void {
  if (!(EDITABLE_PROFILE_FIELDS as readonly string[]).includes(field)) {
    throw new Error('Only display name, image, and introduction can be changed.');
  }
}
```

4. Add colocated tests covering blank IDs, unconfirmed gating, case-insensitive normalization, similar-ID suggestions, and User ID immutability.
```bash
cd app
npm test -- src/profiles
npm run typecheck
```

Acceptance: `npm test -- src/profiles` passes and unconfirmed profiles cannot proceed while confirmed User IDs cannot be changed.

## Task 3: Auth session and OAuth account boundaries

Implement Apple and Google OAuth session handling, existing-account return, new-account registration entry, and account boundaries in `app/src/auth/session.ts`. This task owns session outcomes. Later tasks only consume the resolved account.

1. Read the exact versioned Expo docs before writing code.
```text
https://docs.expo.dev/versions/v57.0.0/
```

2. Implement OAuth provider selection, existing-account return, and no-recovery handling in `app/src/auth/session.ts`.
```typescript
export type OAuthProvider = 'apple' | 'google';
export type SessionOutcome =
  | { kind: 'returning'; provider: OAuthProvider; accountId: string }
  | { kind: 'register'; provider: OAuthProvider }
  | { kind: 'unrecoverable' };

export function resolveSessionOutcome(input: {
  provider: OAuthProvider;
  accountId: string | null;
  providerAccountSelected: boolean;
  allMethodsLost: boolean;
}): SessionOutcome {
  if (input.allMethodsLost) return { kind: 'unrecoverable' };
  if (input.accountId && input.providerAccountSelected) {
    return { kind: 'returning', provider: input.provider, accountId: input.accountId };
  }
  return { kind: 'register', provider: input.provider };
}

export function assertNoCrossEmailAutoLink(existingEmail: string | null, nextEmail: string | null): void {
  if (existingEmail && nextEmail && existingEmail.toLowerCase() !== nextEmail.toLowerCase()) {
    throw new Error('Do not auto-link OAuth logins with different emails.');
  }
}
```

3. Add tests for returning users, new registrations, different-account selection, total-loss handling, and cross-email auto-link refusal.
```bash
cd app
npm test -- src/auth
npm run typecheck
```

Acceptance: `npm test -- src/auth` passes and different-email OAuth logins are never auto-linked by session resolution.

## Task 4: Discovery, invitations, and registration return

Implement User ID lookup, invitation sharing and opening, expiry checks, and unregistered-invitation return in `app/src/discovery/lookup.ts`, `app/src/invitations/share.ts`, and `app/src/invitations/open.ts`. This task owns entry-point behavior. Later tasks only consume resolved candidates.

1. Read the exact versioned Expo docs before writing code.
```text
https://docs.expo.dev/versions/v57.0.0/
```

2. Implement exact candidate resolution and pre-request profile exposure in `app/src/discovery/lookup.ts`.
```typescript
export interface PublicProfile {
  displayName: string;
  userIdText: string;
  avatarPath: string | null;
  introduction: string | null;
}

export function resolveSingleCandidate(candidates: PublicProfile[]): PublicProfile {
  if (candidates.length !== 1) {
    throw new Error('User ID input must resolve to exactly one candidate.');
  }
  return candidates[0];
}
```

3. Implement 7-day invitation creation and opening checks in `app/src/invitations/share.ts` and `app/src/invitations/open.ts`.
```typescript
export const INVITATION_VALID_DAYS = 7;

export function invitationExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + INVITATION_VALID_DAYS * 24 * 60 * 60 * 1000);
}

export function assertInvitationOpenable(now: Date, expiresAt: Date): void {
  if (now.getTime() >= expiresAt.getTime()) {
    throw new Error('This invitation expired. Ask for a new invitation.');
  }
}

export function invitationReturnTarget(invitationToken: string | null): string | null {
  if (!invitationToken) return null;
  return `invitation:${invitationToken}`;
}
```

4. Add tests for one-candidate resolution, expired invitations, reissue guidance, and return after registration and User ID confirmation.
```bash
cd app
npm test -- src/discovery src/invitations
npm run typecheck
```

Acceptance: `npm test -- src/discovery src/invitations` passes and expired invitations cannot start a request.

## Task 5: Friend requests, approvals, and zero-friend behavior

Implement request sending, cancellation, approval, rejection display, duplicate prevention, crossed-request establishment, expiry behavior, blocked-recipient handling, and zero-friend guidance in `app/src/requests/outbox.ts`, `app/src/requests/inbox.ts`, and `app/src/requests/zeroFriends.ts`. This task owns request behavior. Later tasks only enforce access and schedule expiry.

1. Read the exact versioned Expo docs before writing code.
```text
https://docs.expo.dev/versions/v57.0.0/
```

2. Implement sender behavior in `app/src/requests/outbox.ts`.
```typescript
export const FRIEND_REQUEST_VALID_DAYS = 7;
export const REJECTION_DISPLAY = '今回は成立しませんでした';

export function requestExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + FRIEND_REQUEST_VALID_DAYS * 24 * 60 * 60 * 1000);
}

export function assertNoDuplicatePending(pendingCount: number): void {
  if (pendingCount > 0) {
    throw new Error('A request is already pending. Open the existing request.');
  }
}

export function crossedRequestEstablished(outgoingPending: boolean, incomingPending: boolean): boolean {
  return outgoingPending && incomingPending;
}
```

3. Implement recipient behavior and neutral rejection display in `app/src/requests/inbox.ts`.
```typescript
import { REJECTION_DISPLAY } from './outbox';

export type RequestDecision = 'approve' | 'reject';

export function rejectionDisplay(): string {
  return REJECTION_DISPLAY;
}

export function assertRecipientDecision(decision: RequestDecision): void {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error('Recipients can only approve or reject.');
  }
}

export function assertRequestAllowedForRecipient(blocked: boolean): void {
  if (blocked) {
    throw new Error('Requests cannot be sent to a blocked recipient.');
  }
}
```

4. Implement zero-friend guidance in `app/src/requests/zeroFriends.ts`.
```typescript
export function zeroFriendGuidance(): { showAddEntries: true; streakChanges: false; message: string } {
  return {
    showAddEntries: true,
    streakChanges: false,
    message: '友達がいない日は抽選対象外です。Streakは変わりません。',
  };
}
```

5. Add tests for approval establishment, crossed establishment, cancellation, rejection display, duplicate prevention, expiry non-establishment, blocked recipients, request-only block refusal, and zero-friend guidance.
```bash
cd app
npm test -- src/requests
npm run typecheck
```

Acceptance: `npm test -- src/requests` passes and only approval or crossed requests establish friendship.

## Task 6: Access control for registration data

Add row level security policies for profiles, invitations, friend requests, friendships, streaks, and related reads. This task owns registration access control. Later tasks only call through these policies.

1. Create the next sequential migration file.
```bash
npx supabase@latest migration new friend_registration_policies
```

2. Allow users to read pre-request public profiles and manage only their own profile row.
```sql
create policy profiles_public_read
  on profiles for select
  using (user_id_confirmed_at is not null);

create policy profiles_owner_write
  on profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

3. Allow invitation owners to manage invitations and allow recipients to read an invitation being opened.
```sql
create policy invitations_owner_write
  on invitations for all
  using (auth.uid() = inviter_user_id)
  with check (auth.uid() = inviter_user_id);

create policy invitations_open_read
  on invitations for select
  using (expires_at > now());
```

4. Allow senders and recipients to read requests, senders to create and cancel pending requests, recipients to decide pending requests, and block request-only visibility changes.
```sql
create policy friend_requests_participant_read
  on friend_requests for select
  using (auth.uid() = sender_user_id or auth.uid() = recipient_user_id);

create policy friend_requests_sender_insert
  on friend_requests for insert
  with check (auth.uid() = sender_user_id and status = 'pending');

create policy friend_requests_sender_cancel
  on friend_requests for update
  using (auth.uid() = sender_user_id and status = 'pending')
  with check (status = 'cancelled');

create policy friend_requests_recipient_decide
  on friend_requests for update
  using (auth.uid() = recipient_user_id and status = 'pending')
  with check (status = 'approved' or status = 'rejected');
```

5. Preserve existing friendship visibility for established Friends.
```sql
create policy friendships_participant_read
  on friendships for select
  using (auth.uid() = user_a or auth.uid() = user_b);
```

6. Verify policies locally.
```bash
npx supabase@latest db push
npx supabase@latest db lint --level warning
```

Acceptance: Policy migration applies cleanly and unapproved users cannot read or change requests outside their sender or recipient role.

## Task 7: Server transitions, expiry jobs, and regression fixtures

Create privileged request transitions, scheduled expiry, notifications support data, and regression fixtures in `supabase/functions/friendship-admin/index.ts`, `supabase/functions/request-expiry/index.ts`, and `supabase/seed.friend-registration.test.sql`. This task owns server execution and verification data.

1. Create the server functions.
```bash
npx supabase@latest functions new friendship-admin
npx supabase@latest functions new request-expiry
```

2. Implement privileged approval, crossed-request establishment, cancellation, rejection, blocked-recipient refusal, duplicate refusal, and friendship creation in `supabase/functions/friendship-admin/index.ts`.
```typescript
import { createClient } from 'npm:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !serviceKey) throw new Error('Missing service credentials.');

const admin = createClient(url, serviceKey);

Deno.serve(async (request) => {
  const body = await request.json();
  if (body.action === 'approve') {
    const { error } = await admin.rpc('create_friendship_from_request', {
      p_sender: body.sender_user_id,
      p_recipient: body.recipient_user_id,
    });
    if (error) return new Response('approval failed', { status: 500 });
    return new Response('approval ok', { status: 200 });
  }
  return new Response('unsupported action', { status: 400 });
});
```

3. Implement scheduled request and invitation expiry in `supabase/functions/request-expiry/index.ts`.
```typescript
import { createClient } from 'npm:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !serviceKey) throw new Error('Missing service credentials.');

const admin = createClient(url, serviceKey);

Deno.serve(async () => {
  const { error } = await admin.rpc('expire_friend_requests');
  if (error) return new Response('request expiry failed', { status: 500 });
  const { error: invitationError } = await admin.rpc('expire_invitations');
  if (invitationError) return new Response('invitation expiry failed', { status: 500 });
  return new Response('expiry ok', { status: 200 });
});
```

4. Deploy the functions.
```bash
npx supabase@latest functions deploy friendship-admin
npx supabase@latest functions deploy request-expiry
```

5. Add `supabase/seed.friend-registration.test.sql` with TEST DATA ONLY after `0001` through `0006`. Include fixed UUIDs for a pending request, a crossed pair, an expired request, a cancelled request, a rejected request, a blocked recipient, and a zero-friend user. Never use production data.

6. Run full client verification.
```bash
cd app
npm run typecheck
npm test -- --coverage
```

Acceptance: `npm run typecheck` passes, `npm test -- --coverage` passes, and fixtures demonstrate pending, crossed, expired, cancelled, rejected, blocked, and zero-friend cases without establishing friendship except through approval or crossed requests.
