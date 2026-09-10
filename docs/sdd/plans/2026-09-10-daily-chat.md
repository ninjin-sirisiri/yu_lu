# Daily Chat Implementation Plan

**Goal:** Build the Daily Chat daily assignment, chat, and streak experience for iOS and Android.

**Architecture:** The Expo client talks to Supabase for data, auth, storage, and realtime delivery. One scheduled server job owns daily settlement, reservation application, and the next draw in a single ordered transaction. Push and background resend keep strict server-accepted-time judgments visible on the client.

**Tech Stack:** Expo React Native TypeScript, Supabase Postgres Auth Storage Realtime Edge Functions pg_cron, EAS Build, Expo Notifications with FCM and APNs, Jest

**Spec:** docs/sdd/specs/2026-09-10-daily-chat-design.md

## Global Constraints

- Day boundary: 04:00 Japan time
- Assignment notification: 07:00 Japan time
- Pre-deadline warnings: 22:00 and 02:30 Japan time
- Images per message: Up to 4 images
- Image size: Up to 10 MB per image
- Supported image formats: JPEG, PNG, and HEIC
- Body limit: 10000 characters
- Notification body preview: Up to 100 characters
- Notification image thumbnail: One image at 512 px long edge
- Automatic resend: Exponential backoff for up to 24 hours
- Edit history: Latest 20 generations
- Image retention: Indefinite in the first version
- Daily processing at 04:00 follows settlement, then reservation and relationship reflection, then draw.
- A reply requires Reply Target receipt time strictly before own send time. Equal timestamps do not count as a reply.
- Once a Reply Target is achieved for the day, later incoming messages do not revert it.
- Editing does not change send time or order.
- Withdrawal does not change achievement or receipt facts.
- Reply duty remains even when the original message was withdrawn before replying.
- Automatic resend after the deadline does not count for the previous day.
- The truth for send and receive time is server acceptance time.
- Server is the only place that decides completion, Streak increment, and Streak reset.
- Blank-only body with no image cannot be sent.
- Friends see only the count with no breakdown.
- Do not allow blocking or unfriending daily targets during the day except by reservation.

## File structure

- `app/app.json`
- `app/package.json`
- `app/tsconfig.json`
- `app/.env.example`
- `app/src/chat/ChatScreen.tsx`
- `app/src/daily/progress.ts`
- `app/src/streak/StreakScreen.tsx`
- `app/src/messages/send.ts`
- `app/src/messages/states.ts`
- `app/src/media/images.ts`
- `app/src/notify/push.ts`
- `app/src/relations/blocks.ts`
- `supabase/migrations/0001_daily_chat_core.sql`
- `supabase/migrations/0002_daily_cycle.sql`
- `supabase/functions/daily-settlement/index.ts`
- `supabase/functions/notify-scheduler/index.ts`
- `supabase/seed.test.sql`
- `docs/sdd/specs/2026-09-10-daily-chat-design.md`

## Task 1: Scaffold app and backend

Create the Expo client in `app` and the Supabase working directory at the repo root. Wire environment variables, typecheck, and a first passing test.

1. Scaffold the Expo app into `app` with a blank TypeScript template.
```bash
npx create-expo-app@latest app --template blank-typescript
```

2. Install client libraries inside `app`.
```bash
cd app
npx expo install @supabase/supabase-js expo-notifications expo-image-picker expo-file-system
npm install --save-dev jest @types/jest typescript
```

3. Initialize Supabase at the repo root.
```bash
npx supabase@latest init
```

4. Create `app/.env.example` with public connection placeholders.
```bash
cat app/.env.example
```
```
EXPO_PUBLIC_SUPABASE_URL=https://xyzcompany.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=put-anon-key-here
```

5. Add `app/package.json` scripts for typecheck and tests.
```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "jest"
  }
}
```

6. Verify the scaffold with typecheck and the test runner.
```bash
cd app
npm run typecheck
npm test -- --passWithNoTests
```

Acceptance: `npm run typecheck` passes and `npm test -- --passWithNoTests` passes from `app`.

## Task 2: Database schema and storage

Create all core tables, constraints, indexes, row level security, and image storage in `supabase/migrations/0001_daily_chat_core.sql`. This task owns the data model. Later tasks only add the cycle job and functions.

1. Create the migration file.
```bash
npx supabase@latest migration new daily_chat_core
```

2. Write the full core schema into `supabase/migrations/0001_daily_chat_core.sql`.
```sql
create extension if not exists pgcrypto;

create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table friendships (
  user_a uuid not null references profiles(user_id) on delete cascade,
  user_b uuid not null references profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);

create table daily_cycles (
  daily_key date primary key,
  draw_failed boolean not null default false,
  created_at timestamptz not null default now()
);

create table assignments (
  daily_key date not null references daily_cycles(daily_key) on delete cascade,
  user_id uuid not null references profiles(user_id) on delete cascade,
  partner_id uuid not null references profiles(user_id) on delete cascade,
  direction text not null check (direction in ('send', 'reply')),
  primary key (daily_key, user_id, partner_id, direction)
);

create table messages (
  message_id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references profiles(user_id) on delete cascade,
  recipient_id uuid not null references profiles(user_id) on delete cascade,
  body text not null default '',
  image_paths text[] not null default '{}',
  accepted_at timestamptz not null default now(),
  edited_count int not null default 0,
  withdrawn boolean not null default false,
  client_key uuid not null,
  check (body <> '' or cardinality(image_paths) > 0),
  check (char_length(body) <= 10000),
  check (cardinality(image_paths) <= 4),
  unique (sender_id, client_key)
);

create table message_edits (
  message_id uuid not null references messages(message_id) on delete cascade,
  version int not null,
  body text not null,
  image_paths text[] not null,
  edited_at timestamptz not null default now(),
  primary key (message_id, version)
);

create table streaks (
  user_id uuid primary key references profiles(user_id) on delete cascade,
  current_count int not null default 0,
  last_achieved_key date null,
  updated_at timestamptz not null default now()
);

create table block_reservations (
  user_id uuid not null references profiles(user_id) on delete cascade,
  blocked_user_id uuid not null references profiles(user_id) on delete cascade,
  reserved_at timestamptz not null default now(),
  applied_at timestamptz null,
  primary key (user_id, blocked_user_id)
);

create table blocks (
  user_id uuid not null references profiles(user_id) on delete cascade,
  blocked_user_id uuid not null references profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, blocked_user_id)
);

create table mutes (
  user_id uuid not null references profiles(user_id) on delete cascade,
  muted_user_id uuid not null references profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, muted_user_id)
);

create table reports (
  report_id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles(user_id) on delete cascade,
  message_id uuid not null references messages(message_id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
alter table friendships enable row level security;
alter table assignments enable row level security;
alter table messages enable row level security;
alter table message_edits enable row level security;
alter table streaks enable row level security;
alter table block_reservations enable row level security;
alter table blocks enable row level security;
alter table mutes enable row level security;
alter table reports enable row level security;

insert into storage.buckets (id, name, public)
values ('chat-images', 'chat-images', false)
on conflict (id) do nothing;
```

3. Apply the migration to the local database.
```bash
npx supabase@latest db push
```

4. Verify tables and the storage bucket exist.
```bash
npx supabase@latest db lint --level warning
```

Acceptance: local database accepts the migration and `chat-images` exists with a 10 MB per object policy to be tightened in Task 4.

## Task 3: Daily settlement and draw job

Implement the ordered 04:00 Japan time cycle as one server transaction plus a scheduled Edge Function. This task owns `supabase/migrations/0002_daily_cycle.sql` and `supabase/functions/daily-settlement/index.ts`.

1. Create the cycle migration and the function scaffold.
```bash
npx supabase@latest migration new daily_cycle
npx supabase@latest functions new daily-settlement
```

2. Write JST day helpers and the ordered cycle into `supabase/migrations/0002_daily_cycle.sql`.
```sql
create or replace function jst_daily_key(ts timestamptz)
returns date language sql immutable as
$$ select ((ts at time zone 'Asia/Tokyo') - interval '4 hours')::date $$;

create or replace function day_window_start(daily_key date)
returns timestamptz language sql immutable as
$$ select ((daily_key::timestamp + interval '4 hours') at time zone 'Asia/Tokyo') $$;

create or replace function run_daily_cycle(target_key date)
returns void language plpgsql as
$$
begin
  insert into daily_cycles (daily_key) values (target_key)
  on conflict (daily_key) do nothing;

  update streaks s
  set current_count = 0, updated_at = now()
  where not exists (
    select 1 from daily_completion c
    where c.daily_key = target_key - 1
    and c.user_id = s.user_id
    and c.completed
  )
  and s.last_achieved_key = target_key - 1;

  insert into blocks (user_id, blocked_user_id)
  select user_id, blocked_user_id from block_reservations
  where applied_at is null;

  update block_reservations
  set applied_at = now()
  where applied_at is null;

  delete from friendships f
  using blocks b
  where (b.user_id = f.user_a and b.blocked_user_id = f.user_b)
  or (b.user_id = f.user_b and b.blocked_user_id = f.user_a);

  insert into assignments (daily_key, user_id, partner_id, direction)
  select target_key, u.user_id, p.friend_id, 'send'
  from (select distinct user_id from v_user_friends) u
  cross join lateral (
    select friend_id from v_user_friends v
    where v.user_id = u.user_id
    order by random()
    limit 1
  ) p;

  insert into assignments (daily_key, user_id, partner_id, direction)
  select daily_key, partner_id, user_id, 'reply'
  from assignments
  where daily_key = target_key and direction = 'send';
end;
$$;
```

3. Write the scheduler Edge Function in `supabase/functions/daily-settlement/index.ts`.
```typescript
import { createClient } from '@supabase/supabase-js';

const url = Deno.env.get('SUPABASE_URL') as string;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
const client = createClient(url, key);

Deno.serve(async (req: Request): Promise<Response> => {
  const body = await req.json();
  const targetKey = body.target_key as string;
  const result = await client.rpc('run_daily_cycle', { target_key: targetKey });
  if (result.error) {
    await client.from('daily_cycles').upsert({ daily_key: targetKey, draw_failed: true });
    return new Response('cycle failed', { status: 500 });
  }
  return new Response('cycle ok', { status: 200 });
});
```

4. Deploy the function and schedule it for 04:00 Japan time.
```bash
npx supabase@latest functions deploy daily-settlement
npx supabase@latest db push
```

5. Exercise the cycle on a test key and inspect assignments.
```bash
npx supabase@latest functions invoke daily-settlement --body '{"target_key":"2026-09-11"}'
```

Acceptance: invoking with a test key creates one send row per eligible user plus mirrored reply rows, or marks `draw_failed` with no assignments on failure.

## Task 4: Messaging with images edit withdrawal

Implement send, image upload, edit history, and withdrawal in the client plus database guards. This task owns `app/src/messages/send.ts`, `app/src/messages/states.ts`, and `app/src/media/images.ts`.

1. Create `app/src/messages/states.ts` with send states.
```typescript
export type SendState = 'draft' | 'sending' | 'sent' | 'failed';

export function labelForState(state: SendState): string {
  if (state === 'draft') return 'Draft';
  if (state === 'sending') return 'Sending';
  if (state === 'sent') return 'Sent';
  return 'Failed';
}
```

2. Create `app/src/media/images.ts` with picker and limit checks.
```typescript
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function validImageCount(count: number): boolean {
  return count >= 0 && count <= MAX_IMAGES;
}

export function validImageSize(bytes: number): boolean {
  return bytes > 0 && bytes <= MAX_IMAGE_BYTES;
}
```

3. Create `app/src/messages/send.ts` with upload then insert flow.
```typescript
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
const client = createClient(url, anon);

export async function sendMessage(input: {
  recipientId: string;
  body: string;
  localImageUris: string[];
  clientKey: string;
}): Promise<string> {
  if (input.body.trim() === '' && input.localImageUris.length === 0) {
    throw new Error('Blank-only body with no image cannot be sent');
  }
  const paths: string[] = [];
  for (const uri of input.localImageUris.slice(0, 4)) {
    paths.push(uri);
  }
  const row = {
    recipient_id: input.recipientId,
    body: input.body,
    image_paths: paths,
    client_key: input.clientKey,
  };
  const result = await client.from('messages').insert(row).select('message_id').single();
  if (result.error) throw new Error(result.error.message);
  return result.data.message_id as string;
}
```

4. Add a unit test run for message guards.
```bash
cd app
npm test -- src/messages src/media
```

Acceptance: blank-only with no image is rejected, up to 4 images pass, server `accepted_at` is the recorded truth, edits keep history, withdrawal hides content without deleting the row.

## Task 5: Completion and streak engine

Implement server-side completion checks and Streak increments plus the client progress reader. This task owns the `daily_completion` view, the evaluator function, and `app/src/daily/progress.ts`.

1. Add the completion view and evaluator with a new migration.
```bash
npx supabase@latest migration new completion_engine
```

2. Write the evaluator so equal timestamps do not count and achieved rows stay achieved.
```sql
create or replace function is_reply_valid(peer_at timestamptz, own_at timestamptz)
returns boolean language sql immutable as
$$ select peer_at < own_at $$;
```

3. Create `app/src/daily/progress.ts` for per-person progress.
```typescript
export type PersonProgress = {
  partnerId: string;
  sent: boolean;
  received: boolean;
  replied: boolean;
};

export function pendingPartners(rows: PersonProgress[]): string[] {
  return rows.filter((r) => r.received && !r.replied).map((r) => r.partnerId);
}
```

4. Run completion scenarios from `supabase/seed.test.sql`.
```bash
npx supabase@latest db push
cd app
npm test -- src/daily
```

Acceptance: mutual assignment needs one more message for the second achievement, silent Reply Targets fail the day, last-minute reception has no grace, pre-reply withdrawal still requires a reply.

## Task 6: Relationship guard and visibility

Enforce day-long protection for daily targets, block reservations, mute and hide and report, and the two visibility levels. This task owns `app/src/relations/blocks.ts`, the friendship guard trigger, and the visibility views.

1. Create `app/src/relations/blocks.ts` for reservations.
```typescript
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
const client = createClient(url, anon);

export async function reserveBlock(blockedUserId: string): Promise<void> {
  const result = await client.from('block_reservations').insert({
    blocked_user_id: blockedUserId,
  });
  if (result.error) throw new Error(result.error.message);
}

export async function cancelReservation(blockedUserId: string): Promise<void> {
  const result = await client.from('block_reservations')
    .delete()
    .is('applied_at', null)
    .eq('blocked_user_id', blockedUserId);
  if (result.error) throw new Error(result.error.message);
}
```

2. Add a guard migration that rejects same-day unfriend and block of daily targets.
```bash
npx supabase@latest migration new relationship_guard
```

3. Add visibility views so friends see only the count.
```sql
create or replace view friend_streaks as
select user_id, current_count from streaks;
```

4. Verify guard behavior and visibility queries.
```bash
npx supabase@latest db push
cd app
npm test -- src/relations
```

Acceptance: daily targets cannot be blocked or unfriended during the day, reservations cancel before apply and exclude from the next draw, friends see only the count.

## Task 7: Notifications and offline resend

Implement fixed-time pushes, per-message pushes with preview and thumbnail, and client resend with visible states. This task owns `supabase/functions/notify-scheduler/index.ts` and `app/src/notify/push.ts`.

1. Scaffold the notify function.
```bash
npx supabase@latest functions new notify-scheduler
```

2. Write the scheduler skeleton with Japan time slots.
```typescript
const slots = ['07:00', '22:00', '02:30'];

Deno.serve(async (_req: Request): Promise<Response> => {
  return new Response(JSON.stringify({ slots }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
```

3. Create `app/src/notify/push.ts` with resend backoff constants.
```typescript
export const RESEND_LIMIT_HOURS = 24;
export const PREVIEW_CHARS = 100;

export function previewBody(body: string): string {
  return body.slice(0, PREVIEW_CHARS);
}

export function backoffMs(attempt: number): number {
  return Math.min(60000 * 2 ** attempt, 3600000);
}
```

4. Deploy and smoke test notifications.
```bash
npx supabase@latest functions deploy notify-scheduler
cd app
npm test -- src/notify
```

Acceptance: assignment push at 07:00, warnings at 22:00 and 02:30 Japan time, per-message push carries up to 100 chars plus one 512 px thumbnail, failed sends show failed state and resend up to 24 hours.

## Task 8: Verification and regression coverage

Seed representative friendships and assignments, then run the full regression mapped to the spec Testing section. This task owns `supabase/seed.test.sql` and the final checklist.

1. Write `supabase/seed.test.sql` with two mutual friends plus one extra friend.
```sql
insert into profiles (user_id, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'Aoi'),
  ('22222222-2222-2222-2222-222222222222', 'Ren'),
  ('33333333-3333-3333-3333-333333333333', 'Mio')
on conflict (user_id) do nothing;
```

2. Run typecheck, unit tests, and migration lint together.
```bash
cd app
npm run typecheck
npm test -- --coverage
```

3. Verify lint and local function invocation once more.
```bash
npx supabase@latest db lint --level warning
npx supabase@latest functions invoke daily-settlement --body '{"target_key":"2026-09-12"}'
```

4. Walk the regression list: new friendships apply next day, failed day preserves counts, equal timestamps fail, mutual needs one more message, silent target fails, no grace, withdrawal keeps duty, edits keep order, Streak resets at 04:00, reservations apply before draw, blank-only rejected, image failure resends, history display correct, Japan time notifications, friend count only, user progress visible.

Acceptance: `npm run typecheck` passes, `npm test -- --coverage` passes, lint passes, and every spec Testing bullet is checked off.
