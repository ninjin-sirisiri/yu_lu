-- Task 4: durable, canonical history. No public send/query operation is added.
begin;
select command_boundary.lock_chat_lifecycle();
lock table public.profiles, public.friendships, public.messages in share row exclusive mode;

-- Deliberately no FK to friendships: removing/replacing a relationship must not
-- remove its accepted history or change the identity of a later conversation.
create table public.conversations (
  conversation_id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.profiles(user_id) on delete cascade,
  user_b uuid not null references public.profiles(user_id) on delete cascade,
  next_sequence bigint not null default 1 check (next_sequence > 0),
  constraint conversations_canonical_pair check (user_a < user_b),
  constraint conversations_pair_key unique (user_a,user_b)
);
create table public.chat_participant_state (
  conversation_id uuid not null references public.conversations(conversation_id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  peer_display_name text not null default '以前の友達',
  peer_avatar_path text,
  peer_snapshot_at timestamptz,
  primary key (conversation_id,user_id)
);
create index chat_participant_state_user on public.chat_participant_state(user_id,conversation_id);
alter table public.conversations enable row level security;
alter table public.chat_participant_state enable row level security;
revoke all on public.conversations, public.chat_participant_state from public, anon, authenticated, service_role;

create function command_boundary.check_chat_state_participant()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from public.conversations c where c.conversation_id=new.conversation_id
    and new.user_id in (c.user_a,c.user_b)) then
    raise exception using errcode='23514', message='State owner must be a conversation participant.';
  end if;
  return new;
end; $$;
revoke execute on function command_boundary.check_chat_state_participant() from public, anon, authenticated, service_role;
create trigger chat_state_participant before insert or update on public.chat_participant_state
for each row execute function command_boundary.check_chat_state_participant();

-- Refresh only while the relationship permits current profile access. Unknown
-- pre-migration former friends retain the neutral fallback, never today's profile.
-- Later authenticated query handlers can call this private helper while friends.
create function command_boundary.refresh_chat_participants(p_conversation uuid)
returns void language plpgsql set search_path = '' as $$
declare v_chat public.conversations%rowtype;
begin
  perform command_boundary.lock_chat_lifecycle();
  select * into v_chat from public.conversations where conversation_id=p_conversation;
  if not found then return; end if;
  perform command_boundary.lock_request_pair(v_chat.user_a,v_chat.user_b);
  if not exists(select 1 from public.friendships f where f.user_a=v_chat.user_a and f.user_b=v_chat.user_b)
    or exists(select 1 from public.blocks b where
      (b.user_id=v_chat.user_a and b.blocked_user_id=v_chat.user_b)
      or (b.user_id=v_chat.user_b and b.blocked_user_id=v_chat.user_a)) then
    return;
  end if;
  insert into public.chat_participant_state(conversation_id,user_id,peer_display_name,peer_avatar_path,peer_snapshot_at)
  select v_chat.conversation_id, p.owner_id, peer.display_name, peer.avatar_path, clock_timestamp()
  from (values(v_chat.user_a,v_chat.user_b),(v_chat.user_b,v_chat.user_a)) p(owner_id,peer_id)
  join public.profiles peer on peer.user_id=p.peer_id
  order by p.owner_id
  on conflict(conversation_id,user_id) do update set
    peer_display_name=excluded.peer_display_name,
    peer_avatar_path=excluded.peer_avatar_path,
    peer_snapshot_at=excluded.peer_snapshot_at;
end; $$;
revoke execute on function command_boundary.refresh_chat_participants(uuid) from public, anon, authenticated, service_role;

-- Creation is opt-in for a persistent operation, never a SELECT/listing side
-- effect or a friendship trigger. This is not authorization to send: the future
-- acceptance handler must validate actor, relationship generation and blocks.
create function command_boundary.ensure_conversation(p_one uuid,p_two uuid)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid; v_created boolean;
begin
  if p_one is null or p_two is null or p_one=p_two then
    raise exception using errcode='22023', message='Two distinct conversation participants are required.';
  end if;
  perform command_boundary.lock_request_pair(p_one,p_two);
  insert into public.conversations(user_a,user_b) values(least(p_one,p_two),greatest(p_one,p_two))
    on conflict(user_a,user_b) do nothing returning conversation_id into v_id;
  v_created := found;
  if not v_created then
    select conversation_id into v_id from public.conversations
    where user_a=least(p_one,p_two) and user_b=greatest(p_one,p_two);
  end if;
  insert into public.chat_participant_state(conversation_id,user_id)
    select v_id,u from unnest(array[p_one,p_two]) u order by u
    on conflict(conversation_id,user_id) do nothing;
  if v_created then perform command_boundary.refresh_chat_participants(v_id); end if;
  return v_id;
end; $$;
revoke execute on function command_boundary.ensure_conversation(uuid,uuid) from public, anon, authenticated, service_role;

-- Re-establishment refreshes only existing history; friends who have never had a
-- durable operation still have no conversation/state rows.
create function command_boundary.refresh_friendship_chat_snapshots()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform command_boundary.lock_request_pair(new.user_a,new.user_b);
  select conversation_id into v_id from public.conversations where user_a=new.user_a and user_b=new.user_b;
  if found then perform command_boundary.refresh_chat_participants(v_id); end if;
  return new;
end; $$;
revoke execute on function command_boundary.refresh_friendship_chat_snapshots() from public, anon, authenticated, service_role;
create trigger friendships_chat_snapshots after insert on public.friendships
for each row execute function command_boundary.refresh_friendship_chat_snapshots();

alter table public.messages add column conversation_id uuid references public.conversations(conversation_id);
alter table public.messages add column sequence bigint;

-- Private migration bootstrap, also exercised by transactional owner fixtures.
-- Only unmapped legacy rows are assigned; replay never rewrites a receipt or
-- consumes sequence numbers. The migration holds the lifecycle and table locks.
create function command_boundary.initialize_chat_conversations()
returns void language plpgsql set search_path = '' as $$
declare v_pair record; v_id uuid; v_next bigint; v_count bigint;
begin
  perform command_boundary.lock_chat_lifecycle();
  for v_pair in select distinct least(sender_id,recipient_id) user_a,greatest(sender_id,recipient_id) user_b
    from public.messages where conversation_id is null order by 1,2
  loop
    v_id := command_boundary.ensure_conversation(v_pair.user_a,v_pair.user_b);
    select next_sequence into v_next from public.conversations where conversation_id=v_id for update;
    with ordered as (
      select message_id,row_number() over(order by accepted_at,message_id) position
      from public.messages where conversation_id is null
        and least(sender_id,recipient_id)=v_pair.user_a and greatest(sender_id,recipient_id)=v_pair.user_b
    )
    update public.messages m set conversation_id=v_id,sequence=v_next+o.position-1
    from ordered o where m.message_id=o.message_id;
    get diagnostics v_count = row_count;
    update public.conversations set next_sequence=v_next+v_count where conversation_id=v_id;
  end loop;
end; $$;
revoke execute on function command_boundary.initialize_chat_conversations() from public, anon, authenticated, service_role;
select command_boundary.initialize_chat_conversations();

alter table public.messages alter column conversation_id set not null;
alter table public.messages alter column sequence set not null;
alter table public.messages add constraint messages_sequence_positive check (sequence > 0);
alter table public.messages add constraint messages_conversation_sequence_key unique(conversation_id,sequence);

create function command_boundary.check_chat_message_participants()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Let the NOT NULL constraint report missing mappings. Only migration fixtures
  -- temporarily remove it, as DB owner inside a rolled-back transaction.
  if new.conversation_id is null then return new; end if;
  if not exists(select 1 from public.conversations c where c.conversation_id=new.conversation_id
    and c.user_a=least(new.sender_id,new.recipient_id) and c.user_b=greatest(new.sender_id,new.recipient_id)) then
    raise exception using errcode='23514', message='Message participants must match the conversation.';
  end if;
  return new;
end; $$;
revoke execute on function command_boundary.check_chat_message_participants() from public, anon, authenticated, service_role;
create trigger messages_conversation_participants before insert or update on public.messages
for each row execute function command_boundary.check_chat_message_participants();

-- Replace the old codepoint/nonempty/image checks with Task 1's pinned Unicode
-- validator. New accepted rows must already have normalized LF text. NOT VALID
-- preserves legacy accepted bytes (including old CRLF/whitespace) unchanged;
-- PostgreSQL still strictly checks EVERY new insert/update. No exception for
-- withdrawn rows and no caller-reported visual length are allowed.
alter table public.messages drop constraint messages_check;
alter table public.messages drop constraint messages_body_check;
alter table public.messages drop constraint messages_image_paths_check;
alter table public.messages add constraint messages_chat_body_check check (
  body=command_boundary.validate_chat_body(body,cardinality(image_paths))
) not valid;

-- BYPASSRLS is not a reason to allow raw body access, nor is the old edit table
-- a back door. Definer handlers on app_command/app_query will own all access.
revoke all on public.messages, public.message_edits from public, anon, authenticated, service_role;
commit;
