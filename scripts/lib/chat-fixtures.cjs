'use strict';

const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const backend = require('./local-backend.cjs');
const stack = require('./chat-test-stack.cjs');

function uuid(value) {
  if (!/^[0-9a-f-]{36}$/.test(value)) throw Error('Invalid fixture UUID');
  return `'${value}'::uuid`;
}

async function ownerSql(workdir, sql) {
  await stack.assertDedicatedWorkdir(workdir);
  const result = spawnSync('docker', ['exec', '-i', `supabase_db_${stack.PROJECT_ID}`,
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
  { input: sql, encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) {
    throw Error(backend.redact(`dedicated owner fixture failed: ${result.error?.message ?? result.stderr}`));
  }
  return result.stdout.trim();
}

// Encoded synthetic RGBA pixels, valid CRCs, and no ancillary metadata. No image
// dependency added to the app and no bypass of the real server decoder.
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

function pngWithIdat(compressed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

function png(pixel = 127) {
  return pngWithIdat(deflateSync(Buffer.from([0, ...Array(8).fill(pixel)])));
}

async function storage(status, user, bucket, name, { method = 'GET', bytes, upsert = false } = {}) {
  return fetch(`${status.API_URL}/storage/v1/object/${bucket}/${name}`, {
    method,
    headers: { apikey: status.ANON_KEY, Authorization: `Bearer ${user?.token ?? status.ANON_KEY}`,
      ...(bytes ? { 'content-type': 'image/png', 'x-upsert': String(upsert) } : {}) },
    body: bytes,
    signal: AbortSignal.timeout(10000),
  });
}

async function createChatFixtures({ workdir, status, defer }) {
  const users = {};
  let cleanupPromise = null;
  // Registered before the first create/fixture statement: partial setup is owned.
  // Exposed as f.cleanup() for the appearance journey's explicit owner action;
  // repeat calls share the same promise so deferred cleanup is a no-op.
  const cleanup = () => {
    if (cleanupPromise === null) cleanupPromise = cleanupFixtures();
    return cleanupPromise;
  };
  async function cleanupFixtures() {
    const errors = [];
    const attempt = async fn => { try { await fn(); } catch (error) { errors.push(error); } };
    const ids = Object.values(users).map(user => uuid(user.id));
    if (ids.length) {
      // Daily targets deliberately protect friendship deletion, including Auth
      // cascades. Remove only this empty-seed stack's owner-created day fixture
      // before deleting Auth users; do not weaken any production guard.
      await attempt(() => ownerSql(workdir, 'begin; delete from public.daily_cycles; delete from public.daily_cycle_runs; commit;'));
      await attempt(async () => {
        const rows = JSON.parse(await ownerSql(workdir, `select coalesce(json_agg(json_build_object('bucket',bucket_id,'name',name)),'[]')
          from storage.objects where split_part(name,'/',1) in (${Object.values(users).map(user => `'${user.id}'`).join(',')});`));
        for (const bucket of new Set(rows.map(row => row.bucket))) {
          const res = await fetch(`${status.API_URL}/storage/v1/object/${bucket}`, {
            method: 'DELETE', headers: { apikey: status.SERVICE_ROLE_KEY, Authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
              'content-type': 'application/json' },
            body: JSON.stringify({ prefixes: rows.filter(row => row.bucket === bucket).map(row => row.name) }),
            signal: AbortSignal.timeout(10000),
          });
          await backend.expectJson(res, 200, 'remove dedicated Storage fixtures');
        }
      });
      for (const user of Object.values(users)) await attempt(() => backend.adminDeleteUser(status, user.id));
      await attempt(() => ownerSql(workdir, `begin;
        delete from command_boundary.operation_log where actor_id in (${ids});
        delete from public.chat_updates where user_id in (${ids});
        commit;
        do $$begin
          if exists(select 1 from auth.users where id in (${ids}))
            or exists(select 1 from public.profiles where user_id in (${ids}))
            or exists(select 1 from public.messages) or exists(select 1 from public.chat_media)
            or exists(select 1 from storage.objects where bucket_id in ('chat-staging','chat-images')) then
            raise exception 'Dedicated fixture cleanup incomplete';
          end if;
        end$$;`));
    }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  }
  defer(cleanup);
  for (const name of ['a', 'b', 'third', 'fourth']) {
    const id = await backend.adminCreateUser(status, `chat-${name}-${randomUUID()}@example.test`, `Aa1!${randomUUID()}`);
    users[name] = { id };
    users[name].token = await backend.mintUserToken(status, id);
  }
  const { a, b, third, fourth } = users;
  const fixture = JSON.parse(await ownerSql(workdir, `begin;
    insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at) values
      (${uuid(a.id)},'Chat_A','Chat A',clock_timestamp()),(${uuid(b.id)},'Chat_B','Chat B',clock_timestamp()),
      (${uuid(third.id)},'Chat_C','Chat C',clock_timestamp()),(${uuid(fourth.id)},'Chat_D','Chat D',clock_timestamp());
    insert into public.friendships(user_a,user_b) values
      (least(${uuid(a.id)},${uuid(b.id)}),greatest(${uuid(a.id)},${uuid(b.id)})),
      (least(${uuid(a.id)},${uuid(fourth.id)}),greatest(${uuid(a.id)},${uuid(fourth.id)}));
    update command_boundary.friendship_periods set started_at=public.day_window_start(public.jst_daily_key(clock_timestamp()))-interval '1 second';
    insert into public.daily_cycles(daily_key) values(public.jst_daily_key(clock_timestamp())) on conflict do nothing;
    insert into public.daily_cycle_runs(daily_key,draw_state,draw_finalized_at,settlement_completed_at,relationships_applied_at)
      values(public.jst_daily_key(clock_timestamp()),'succeeded',clock_timestamp(),clock_timestamp(),clock_timestamp())
      on conflict(daily_key) do update set draw_state='succeeded',draw_finalized_at=excluded.draw_finalized_at;
    insert into public.assignments(daily_key,user_id,partner_id,direction)
      select public.jst_daily_key(clock_timestamp()),u,p,d from
      (values(${uuid(a.id)},${uuid(b.id)}),(${uuid(b.id)},${uuid(a.id)})) pair(u,p) cross join (values('send'),('reply')) dirs(d);
    insert into public.daily_user_results(user_id,daily_key,eligible) values
      (${uuid(a.id)},public.jst_daily_key(clock_timestamp()),true),(${uuid(b.id)},public.jst_daily_key(clock_timestamp()),true);
    commit;
    select json_build_object('daily_key',public.jst_daily_key(clock_timestamp()),
      'epoch',(select friendship_epoch from public.friendships
        where user_a=least(${uuid(a.id)},${uuid(b.id)}) and user_b=greatest(${uuid(a.id)},${uuid(b.id)})),
      'fourth_epoch',(select friendship_epoch from public.friendships
        where user_a=least(${uuid(a.id)},${uuid(fourth.id)}) and user_b=greatest(${uuid(a.id)},${uuid(fourth.id)})))
      ;`));
  return { ...users, ...fixture, sql: sql => ownerSql(workdir, sql), cleanup };
}

async function changeJourneyRelationship(f, action) {
  const a = uuid(f.a.id), b = uuid(f.b.id);
  if (action === 'end') {
    await f.sql(`begin; set local daily_chat.cycle_apply='on'; delete from public.friendships
      where user_a=least(${a},${b}) and user_b=greatest(${a},${b}); commit;`);
  } else if (action === 'renew') {
    await f.sql(`begin; insert into public.friendships(user_a,user_b) values(least(${a},${b}),greatest(${a},${b})); commit;`);
  } else throw Error('Unknown dedicated relationship fixture action');
}

const PRESETS = new Set(['b-pop', 'b-candy', 'b-soda']);

function requireInteger(name, value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw Error(`Invalid dedicated fixture ${name}`);
  }
  return value;
}

/**
 * Owner-only chat appearance fixture. It seeds the owned conversation's
 * acceptance history (distinct past 04:00 JST day rows) and the shared state
 * to an exact day count. The real public API is never given a date/actor
 * injection path. Only this fixture-owned conversation is rewritten.
 */
async function seedChatGrowth(f, { days, preset } = {}) {
  const count = requireInteger('days', days, 0, 3650);
  if (preset !== undefined && preset !== null && !PRESETS.has(preset)) {
    throw Error('Invalid dedicated fixture preset');
  }
  const a = uuid(f.a.id), b = uuid(f.b.id);
  const selected = preset === undefined ? 'null' : preset === null ? 'null' : `'${preset}'`;
  const selectedUpdate = preset === undefined ? '' :
    `,selected_preset_id=${selected}`;
  const row = JSON.parse(await f.sql(`do $$
    declare v_chat uuid; v_auto text;
    begin
      select c.conversation_id,s.auto_preset_id into v_chat,v_auto
        from public.conversations c
        left join public.chat_appearance_state s using(conversation_id)
        where c.user_a=least(${a},${b}) and c.user_b=greatest(${a},${b});
      if v_chat is null then
        raise exception 'appearance fixture conversation is missing';
      end if;
      delete from public.chat_growth_days where conversation_id=v_chat;
      insert into public.chat_growth_days(conversation_id,daily_key)
        select v_chat,(public.jst_daily_key(clock_timestamp())-offs)::date
        from generate_series(1,${count}) offs;
      insert into public.chat_appearance_state(conversation_id,growth_days,auto_preset_id)
        values(v_chat,${count},coalesce(v_auto,command_boundary.chat_auto_preset(${a},${b})))
        on conflict(conversation_id) do nothing;
      update public.chat_appearance_state
        set growth_days=${count}${selectedUpdate}
        where conversation_id=v_chat;
    end$$;
    select json_build_object(
      'conversation_id',c.conversation_id,
      'growth_days',s.growth_days,
      'auto_preset_id',s.auto_preset_id,
      'selected_preset_id',s.selected_preset_id)
      from public.conversations c join public.chat_appearance_state s using(conversation_id)
      where c.user_a=least(${a},${b}) and c.user_b=greatest(${a},${b});`));
  return row;
}

/**
 * Owner-only personal appearance fixture. `earned_days` is the retained
 * (maximum) appearance value while `current_streak` is the current display
 * count; both are written explicitly so a reset-to-zero scenario can retain a
 * higher earned stage. The streaks trigger only ever raises earned_days, so
 * the exact earned value is written afterwards in the same transaction.
 */
async function seedStreakAppearance(f, { actor, currentStreak, earnedDays } = {}) {
  const user = f[actor];
  if (!user || typeof user.id !== 'string') throw Error('Invalid dedicated fixture actor');
  const current = requireInteger('currentStreak', currentStreak, 0, 100000);
  const earned = requireInteger('earnedDays', earnedDays, 0, 100);
  const id = uuid(user.id);
  const row = JSON.parse(await f.sql(`begin;
    insert into public.streaks(user_id,current_count,last_achieved_key,updated_at)
      values(${id},${current},null,clock_timestamp())
      on conflict(user_id) do update set current_count=excluded.current_count,
        last_achieved_key=null,updated_at=excluded.updated_at;
    insert into public.streak_appearances(user_id,earned_days)
      values(${id},${earned})
      on conflict(user_id) do update set earned_days=excluded.earned_days;
    commit;
    select json_build_object(
      'current_streak',(select current_count from public.streaks where user_id=${id}),
      'earned_days',(select earned_days from public.streak_appearances where user_id=${id}));`));
  return row;
}

/** Closed owner fixture IPC action set used by the appearance journey. */
async function appearanceFixture(f, action, payload = {}) {
  if (action === 'seed-chat-growth') return seedChatGrowth(f, payload);
  if (action === 'seed-streak') return seedStreakAppearance(f, payload);
  if (action === 'cleanup') { await f.cleanup(); return { cleaned: true }; }
  throw Error('Unknown dedicated appearance fixture action');
}

module.exports = { createChatFixtures, changeJourneyRelationship, appearanceFixture,
  seedChatGrowth, seedStreakAppearance, ownerSql, uuid, png, pngWithIdat, storage };
