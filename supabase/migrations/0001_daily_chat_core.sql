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
