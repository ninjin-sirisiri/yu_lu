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
  // Registered before the first create/fixture statement: partial setup is owned.
  defer(async () => {
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
  });
  for (const name of ['a', 'b', 'third']) {
    const id = await backend.adminCreateUser(status, `chat-${name}-${randomUUID()}@example.test`, `Aa1!${randomUUID()}`);
    users[name] = { id };
    users[name].token = await backend.mintUserToken(status, id);
  }
  const { a, b, third } = users;
  const fixture = JSON.parse(await ownerSql(workdir, `begin;
    insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at) values
      (${uuid(a.id)},'Chat_A','Chat A',clock_timestamp()),(${uuid(b.id)},'Chat_B','Chat B',clock_timestamp()),
      (${uuid(third.id)},'Chat_C','Chat C',clock_timestamp());
    insert into public.friendships(user_a,user_b) values(least(${uuid(a.id)},${uuid(b.id)}),greatest(${uuid(a.id)},${uuid(b.id)}));
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
    select json_build_object('daily_key',public.jst_daily_key(clock_timestamp()),'epoch',friendship_epoch)
      from public.friendships where user_a=least(${uuid(a.id)},${uuid(b.id)}) and user_b=greatest(${uuid(a.id)},${uuid(b.id)});`));
  return { ...users, ...fixture, sql: sql => ownerSql(workdir, sql) };
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

module.exports = { createChatFixtures, changeJourneyRelationship, ownerSql, uuid, png, pngWithIdat, storage };
