#!/usr/bin/env node
// Tasks 10/21. Real HTTP/screens only; missing infrastructure is a hard failure.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import backend from './lib/local-backend.cjs';
import stack from './lib/chat-test-stack.cjs';
import fixtures from './lib/chat-fixtures.cjs';

const log = text => console.log(backend.redact(text));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Read-only audit: never start/stop/migrate the normal stack. Digest data in a
// stable ordering rather than storing a dump (which could contain private data).
export function normalDatabaseDigest(containers, run = stack.command) {
  // The normal stack is not a prerequisite for the dedicated HTTP suite. Audit
  // its data only if its database is already running; never start it for a test.
  if (!containers.some(line => line.endsWith(' supabase_db_daily-chat'))) return null;
  const sql = `create function pg_temp.chat_audit() returns text language plpgsql as $$
    declare r record; data text; result text := ''; begin
      for r in select schemaname,tablename from pg_tables where schemaname in ('public','command_boundary')
        or (schemaname='auth' and tablename='users') or (schemaname='storage' and tablename='objects') order by 1,2 loop
        execute format('select coalesce(string_agg(row_data,E''\\n'' order by row_data),'''') from (select row_to_json(t)::text row_data from %I.%I t) s',r.schemaname,r.tablename) into data;
        result := result || r.schemaname || '.' || r.tablename || ':' || md5(data) || E'\\n';
      end loop; return result; end$$; select pg_temp.chat_audit();`;
  return hash(run('docker', ['exec', 'supabase_db_daily-chat', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-c', sql], backend.REPO_ROOT));
}

// pgTAP is copied into the owned temporary workdir and executed only there.
// Tests never run against the normal development project, its database or its
// Supabase config. Both fs and the CLI command are injectable for Node tests.
export async function dbSuite(ctx, { command = stack.command, write = text => process.stdout.write(text) } = {}) {
  const workdir = ctx?.workdir;
  if (typeof workdir !== 'string' || path.resolve(workdir) === path.resolve(backend.REPO_ROOT)) {
    throw Error('pgTAP requires an owned dedicated workdir');
  }
  const source = path.join(backend.REPO_ROOT, 'supabase', 'tests');
  await fs.access(source);
  await fs.cp(source, path.join(workdir, 'supabase', 'tests'), { recursive: true });
  const output = command('npx', ['supabase', 'test', 'db'], workdir) ?? '';
  write(output);
  log('PASS dedicated pgTAP database suite');
  return output;
}

async function protectedState() {
  const files = {};
  for (const file of ['app/.env', 'supabase/config.toml']) {
    try { files[file] = hash(await fs.readFile(path.join(backend.REPO_ROOT, file))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files[file] = null; }
  }
  const containers = stack.command('docker', ['ps', '--format', '{{.ID}} {{.Names}}'], backend.REPO_ROOT)
    .split('\n').filter(line => /_daily-chat$/.test(line)).sort();
  return { files, database: normalDatabaseDigest(containers), containers };
}

async function backendSuite(ctx) {
  const { status } = ctx;
  const f = await fixtures.createChatFixtures(ctx);
  const { a, b, third, epoch } = f;
  const command = (user, kind, payload, operation_id = randomUUID()) => backend.postFunction(status, 'app-command', {
    token: user?.token, body: { operation_id, kind, payload },
  });
  const queryResponse = (user, op, payload = {}) => backend.postFunction(status, 'app-query', { token: user?.token, body: { op, payload } });
  const query = async (user, op, payload = {}) => {
    const body = await backend.expectJson(await queryResponse(user, op, payload), 200, op);
    assert.equal(body.op, op);
    assert.ok(Number.isSafeInteger(body.result.revision));
    return body.result;
  };
  const messages = (user, peer, anchor = 'latest', cursor) => query(user, 'get_chat_messages', { peer_id: peer.id, anchor, ...(cursor ? { cursor } : {}) });
  const payload = (peer = b, body = 'hello', client_key = randomUUID(), friendship_epoch = epoch, media_ids = []) => ({
    recipient_id: peer.id, client_key, friendship_epoch, body, media_ids,
  });
  const send = async (user, value, op) => (await backend.expectJson(await command(user, 'send_message', value, op), 200, 'send')).result;
  const mark = async (ids, through = null) => (await backend.expectJson(await command(b, 'mark_chat_read', {
    conversation_id: conversation, message_ids: ids, through_sequence: through,
  }), 200, 'mark read')).result;
  const check = async (name, run) => { await run(); log(`PASS ${name}`); };
  const denyStorage = async res => {
    const text = await res.text();
    // Storage errors use a JSON statusCode while the HTTP status can be 400.
    assert.ok([400, 401, 403, 404].includes(res.status), `Storage access unexpectedly allowed (${res.status})`);
    assert.ok(!text.includes('iVBOR'), 'Storage denial leaked image bytes');
  };

  await check('real Auth sessions; unauthenticated/forged calls and caller-clock injection denied', async () => {
    await backend.expectJson(await queryResponse(null, 'get_home'), 401, 'missing session');
    await backend.expectJson(await command({ token: ['not', 'a', 'session'].join('-') }, 'send_message', payload()), 401, 'forged session');
    await backend.expectJson(await command(a, 'send_message', { ...payload(), accepted_at: '2000-01-01' }), 400, 'clock injection');
    await backend.expectJson(await queryResponse(a, 'get_home', { actor_id: b.id }), 400, 'actor injection');
    const home = await query(a, 'get_home');
    assert.equal(home.daily_key, f.daily_key);
    assert.equal(home.draw_state, 'succeeded');
    assert.equal(home.participation, 'eligible');
    assert.equal(home.targets.length, 1);
    assert.equal(home.targets[0].peer_id, b.id);
    assert.equal(home.targets[0].conversation_id, null);
    assert.equal(home.targets[0].friendship_epoch, epoch);
    assert.equal(home.send_completed, false);
    assert.equal(home.achieved, false);
  });

  const imageKey = randomUUID();
  const stagingPath = `${a.id}/${imageKey}/0.png`;
  const png = fixtures.png();
  let media;
  await check('real PNG upload, private preparation, immutable replay and Storage ownership', async () => {
    await denyStorage(await fixtures.storage(status, third, 'chat-staging', stagingPath, { method: 'POST', bytes: png }));
    await backend.expectJson(await fixtures.storage(status, a, 'chat-staging', stagingPath, { method: 'POST', bytes: png }), 200, 'staging upload');
    await denyStorage(await fixtures.storage(status, b, 'chat-staging', stagingPath));
    const prepare = { client_key: imageKey, images: [{ staging_path: stagingPath }] };
    await backend.expectJson(await command(b, 'prepare_chat_media', prepare), 400, 'other owner preparation');
    const first = await backend.expectJson(await command(a, 'prepare_chat_media', prepare), 200, 'prepare PNG');
    media = first.result.media[0];
    assert.equal(media.sha256, hash(png));
    assert.equal(media.width, 2); assert.equal(media.height, 1);
    assert.equal(media.byte_size, png.length);
    const second = await backend.expectJson(await command(a, 'prepare_chat_media', prepare), 200, 'prepare replay');
    assert.deepEqual(second.result, first.result);
    await denyStorage(await fixtures.storage(status, a, 'chat-images', media.final_path));
    await denyStorage(await fixtures.storage(status, b, 'chat-images', media.final_path));
    await denyStorage(await fixtures.storage(status, a, 'chat-images', media.final_path, { method: 'POST', bytes: png, upsert: true }));
    const badKey = randomUUID();
    const badPath = `${a.id}/${badKey}/0.png`;
    await backend.expectJson(await fixtures.storage(status, a, 'chat-staging', badPath, { method: 'POST', bytes: Buffer.from('not a PNG') }), 200, 'invalid staging bytes');
    await backend.expectJson(await command(a, 'prepare_chat_media', { client_key: badKey, images: [{ staging_path: badPath }] }), 400, 'actual decoder rejection');
    const compressed = deflateSync(Buffer.alloc(9));
    const badChecksum = Buffer.from(compressed);
    badChecksum[badChecksum.length - 1] ^= 1;
    for (const idat of [deflateSync(Buffer.alloc(8)), deflateSync(Buffer.alloc(10)),
      deflateSync(Buffer.alloc(1024 * 1024)), Buffer.concat([compressed, Buffer.from([0])]),
      Buffer.concat([compressed, deflateSync(Buffer.alloc(0))]), compressed.subarray(0, -1),
      badChecksum, deflateRawSync(Buffer.alloc(9)), gzipSync(Buffer.alloc(9))]) {
      const key = randomUUID();
      const name = `${a.id}/${key}/0.png`;
      await backend.expectJson(await fixtures.storage(status, a, 'chat-staging', name,
        { method: 'POST', bytes: fixtures.pngWithIdat(idat) }), 200, 'malformed PNG staging');
      await backend.expectJson(await command(a, 'prepare_chat_media', { client_key: key, images: [{ staging_path: name }] }),
        400, 'bounded, complete zlib stream enforced by actual Edge runtime');
    }
  });

  let imageReceipt;
  let conversation;
  const imagePayload = payload(b, '', imageKey, epoch, []);
  await check('concurrent image-only sends commit exactly one receipt; retries cannot mutate it', async () => {
    imagePayload.media_ids = [media.media_id];
    const op = randomUUID();
    const before = Date.now();
    const pair = await Promise.all([command(a, 'send_message', imagePayload, op), command(a, 'send_message', imagePayload, op)]);
    const bodies = await Promise.all(pair.map(res => backend.expectJson(res, 200, 'concurrent send')));
    assert.deepEqual(bodies.map(body => body.status).sort(), ['executed', 'replayed']);
    assert.deepEqual(bodies[0].result, bodies[1].result);
    imageReceipt = bodies[0].result; conversation = imageReceipt.conversation_id;
    assert.equal(imageReceipt.sequence, 1);
    assert.ok(Date.parse(imageReceipt.accepted_at) >= before - 1000 && Date.parse(imageReceipt.accepted_at) <= Date.now() + 1000);
    assert.deepEqual(await send(a, imagePayload), imageReceipt);
    await backend.expectJson(await command(a, 'send_message', { ...imagePayload, body: 'changed' }), 409, 'client-key conflict');
    await backend.expectJson(await command(a, 'send_message', { ...imagePayload, body: 'changed' }, op), 409, 'operation conflict');
    const incoming = await messages(b, a);
    assert.equal(incoming.items.length, 1);
    assert.deepEqual(incoming.items[0].image_paths, [media.final_path]);
    assert.equal(incoming.items[0].body, '');
    for (const user of [a, b]) {
      const res = await fixtures.storage(status, user, 'chat-images', media.final_path);
      assert.equal(res.status, 200); assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
    }
    await denyStorage(await fixtures.storage(status, third, 'chat-images', media.final_path));
    await denyStorage(await fixtures.storage(status, null, 'chat-images', media.final_path));
  });

  await check('concurrent distinct sends serialize; server-time reply atomically achieves each actor once', async () => {
    const receipts = await Promise.all(Array.from({ length: 4 }, (_, n) => send(a, payload(b, `concurrent ${n}`))));
    assert.deepEqual(receipts.map(r => r.sequence).sort((a, b) => a - b), [2, 3, 4, 5]);
    const reply = await send(b, payload(a, 'reply from B'));
    assert.ok(Date.parse(reply.accepted_at) > Date.parse(imageReceipt.accepted_at));
    assert.equal((await query(b, 'get_home')).achieved, true);
    assert.equal((await query(a, 'get_home')).achieved, false);
    await send(a, payload(b, 'a\r\nb'));
    await send(a, payload(b, 'later reply'));
    for (const user of [a, b]) {
      const home = await query(user, 'get_home');
      assert.equal(home.achieved, true); assert.equal(home.streak, 1);
    }
    assert.equal((await messages(a, b)).items.find(item => item.sequence === 7).body, 'a\nb');
  });

  await check('50-message cursor pages have no overlaps, preserve order and bind actor/peer/direction', async () => {
    for (let batch = 0; batch < 6; batch++) {
      await Promise.all(Array.from({ length: 8 }, (_, n) => send(a, payload(b, `page ${batch}/${n}`))));
    }
    const latest = await messages(b, a);
    assert.equal(latest.items.length, 50);
    assert.equal(latest.latest_sequence, 56);
    assert.deepEqual(latest.items.map(item => item.sequence), Array.from({ length: 50 }, (_, n) => n + 7));
    const older = await messages(b, a, 'before', latest.before_cursor);
    assert.deepEqual(older.items.map(item => item.sequence), [1, 2, 3, 4, 5, 6]);
    const newer = await messages(b, a, 'after', older.after_cursor);
    assert.deepEqual(newer.items.map(item => item.sequence), latest.items.map(item => item.sequence));
    for (const [user, peer, anchor, code] of [[a, b, 'before', 400], [b, third, 'before', 403], [b, a, 'after', 400]]) {
      await backend.expectJson(await queryResponse(user, 'get_chat_messages', { peer_id: peer.id, anchor, cursor: latest.before_cursor }), code, 'bound cursor');
    }
    const list = await query(b, 'list_chats');
    assert.equal(list.targets.length, 1); assert.equal(list.items.length, 0);
    assert.equal(list.targets[0].last_message.sequence, 56);
    assert.equal(list.targets[0].unread_count, 55);
    const outsider = await query(third, 'list_chats');
    assert.equal(outsider.items.length, 0); assert.equal(outsider.targets.length, 0);
    await backend.expectJson(await queryResponse(third, 'get_chat_messages', { peer_id: a.id, anchor: 'latest' }), 403, 'third-party history');
  });

  await check('sparse reads merge across devices; bounded latest jump excludes subsequent arrival; peer privacy', async () => {
    const peerRevision = (await query(a, 'get_chat_unread')).revision;
    const first = await messages(b, a, 'first_unread');
    assert.equal(first.first_unread_sequence, 1);
    const ids = first.items.filter(item => item.sender_id === a.id).map(item => item.message_id);
    await Promise.all([mark([ids[2]]), mark([ids[4]])]);
    const unread = await query(b, 'get_chat_unread');
    assert.equal(unread.items[0].unread_count, 53);
    assert.equal(unread.items[0].first_unread_sequence, 1);
    assert.equal((await query(a, 'get_chat_unread')).revision, peerRevision);
    const bound = (await messages(b, a)).latest_sequence;
    const arrived = await send(a, payload(b, 'after latest snapshot'));
    await mark([], bound);
    await mark([ids[0]], 1); // stale device may not regress the bound
    const result = await query(b, 'get_chat_unread');
    assert.equal(result.items[0].unread_count, 1);
    assert.equal(result.items[0].first_unread_sequence, arrived.sequence);
    assert.equal(result.unread_peer_count, 1);
    await backend.expectJson(await command(third, 'mark_chat_read', { conversation_id: conversation, message_ids: [], through_sequence: bound }), 403, 'third-party read');
    assert.equal((await query(b, 'get_chat_unread')).items[0].unread_count, 1);
  });

  await check('direct RPC, private table and Storage write bypasses are denied', async () => {
    const rpc = await backend.postRest(status, 'rpc/record_chat_media', { token: a.token, body: { p_actor: a.id, p_client_key: imageKey, p_items: [] } });
    const denied = await backend.expectJson(rpc, 403, 'service media RPC'); assert.equal(denied.code, '42501');
    await backend.expectJson(await backend.postRest(status, 'rpc/send_message_handler', { token: a.token, body: {} }), 404, 'private send RPC');
    for (const table of ['conversations', 'chat_media', 'chat_participant_state', 'chat_read_messages']) {
      await backend.expectJson(await backend.postRest(status, `${table}?select=*`, { token: third.token, method: 'GET' }), 403, `private ${table}`);
    }
    await backend.expectJson(await backend.postRest(status, 'messages', { token: a.token, body: { sender_id: a.id, recipient_id: b.id, body: 'forged' } }), 403, 'direct message write');
    const tokens = await backend.expectJson(await backend.postRest(status, 'chat_updates?select=*', { token: third.token, method: 'GET' }), 200, 'revision RLS');
    assert.ok(tokens.every(row => row.user_id === third.id));
  });

  await check('unfriend preserves accepted history/media/retry but re-friend rejects stale queued epoch', async () => {
    const pair = `user_a=least(${fixtures.uuid(a.id)},${fixtures.uuid(b.id)}) and user_b=greatest(${fixtures.uuid(a.id)},${fixtures.uuid(b.id)})`;
    const stale = payload(b, 'old offline draft');
    await f.sql(`begin; set local daily_chat.cycle_apply='on'; delete from public.friendships where ${pair}; commit;`);
    const ended = await messages(a, b);
    assert.equal(ended.can_send, false); assert.equal(ended.conversation_id, conversation);
    await backend.expectJson(await command(a, 'send_message', stale), 403, 'send after unfriend');
    assert.deepEqual(await send(a, imagePayload), imageReceipt);
    const res = await fixtures.storage(status, b, 'chat-images', media.final_path);
    assert.equal(res.status, 200); await res.arrayBuffer();
    await f.sql(`begin; insert into public.friendships(user_a,user_b) values(least(${fixtures.uuid(a.id)},${fixtures.uuid(b.id)}),greatest(${fixtures.uuid(a.id)},${fixtures.uuid(b.id)})); commit;`);
    const renewed = await messages(a, b);
    assert.notEqual(renewed.friendship_epoch, epoch); assert.equal(renewed.can_send, true);
    await backend.expectJson(await command(a, 'send_message', stale), 403, 'stale offline epoch');
    const accepted = await send(a, payload(b, 'explicitly confirmed', randomUUID(), renewed.friendship_epoch));
    assert.equal(accepted.conversation_id, conversation);
    await f.sql(`begin; set local daily_chat.cycle_apply='on'; insert into public.blocks(user_id,blocked_user_id) values(${fixtures.uuid(b.id)},${fixtures.uuid(a.id)}); commit;`);
    const blocked = await backend.expectJson(await command(a, 'send_message', payload(b, 'blocked', randomUUID(), renewed.friendship_epoch)), 403, 'incoming block');
    assert.equal(blocked.error, '現在この相手には送信できません');
    const outgoing = await backend.expectJson(await command(b, 'send_message', payload(a, 'outgoing block', randomUUID(), renewed.friendship_epoch)), 403, 'outgoing block');
    assert.equal(outgoing.error, blocked.error);
    assert.equal((await messages(b, a)).can_send, false);
    assert.deepEqual(await send(a, imagePayload), imageReceipt);
    const historyImage = await fixtures.storage(status, b, 'chat-images', media.final_path);
    assert.equal(historyImage.status, 200); await historyImage.arrayBuffer();
    await denyStorage(await fixtures.storage(status, third, 'chat-images', media.final_path));
  });

  await check('new unassigned friend can converse immediately without waiting for draw', async () => {
    await f.sql(`begin; insert into public.friendships(user_a,user_b) values(least(${fixtures.uuid(a.id)},${fixtures.uuid(third.id)}),greatest(${fixtures.uuid(a.id)},${fixtures.uuid(third.id)})); commit;`);
    const waiting = await messages(a, third);
    assert.equal(waiting.can_send, true); assert.equal(waiting.conversation_id, null);
    const receipt = await send(a, payload(third, 'free conversation', randomUUID(), waiting.friendship_epoch));
    assert.equal(receipt.sequence, 1);
    const list = await query(a, 'list_chats');
    assert.ok(list.items.some(item => item.peer_id === third.id));
    assert.ok(!list.targets.some(item => item.peer_id === third.id));
    await denyStorage(await fixtures.storage(status, third, 'chat-images', media.final_path));
  });

  await check('legacy withdrawn receipt redacts body/images and revokes image retrieval', async () => {
    await f.sql(`begin; update public.messages set withdrawn=true where message_id=${fixtures.uuid(imageReceipt.message_id)}; commit;`);
    const first = await messages(b, a, 'first_unread');
    const older = first.before_cursor ? await messages(b, a, 'before', first.before_cursor) : first;
    // Fetch backward until the original image receipt is present.
    let page = older;
    while (!page.items.some(item => item.message_id === imageReceipt.message_id) && page.before_cursor) page = await messages(b, a, 'before', page.before_cursor);
    const row = page.items.find(item => item.message_id === imageReceipt.message_id);
    assert.ok(row); assert.equal(row.withdrawn, true); assert.equal(row.body, null); assert.deepEqual(row.image_paths, []);
    await denyStorage(await fixtures.storage(status, b, 'chat-images', media.final_path));
  });
}

async function journeySuite(ctx) {
  const tests = ['__tests__/chat-env.test.ts', '__tests__/home-chat-journey.test.tsx'];
  for (const test of tests) await fs.access(path.join(backend.REPO_ROOT, 'app', test));
  const f = await fixtures.createChatFixtures(ctx);
  const config = { project: stack.PROJECT_ID, url: ctx.status.API_URL, anonKey: ctx.status.ANON_KEY, a: f.a, b: f.b };
  await new Promise((resolve, reject) => {
    const child = fork(path.join(backend.REPO_ROOT, 'app/node_modules/jest/bin/jest.js'),
      ['--runInBand', '--detectOpenHandles', '--runTestsByPath', ...tests], {
        cwd: path.join(backend.REPO_ROOT, 'app'),
        env: { ...backend.localCliEnv(ctx.workdir), CHAT_JOURNEY_CONFIG: JSON.stringify(config) },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    // Never stream credentials/SDK error objects unredacted.
    child.stdout.on('data', bytes => process.stdout.write(backend.redact(bytes.toString())));
    child.stderr.on('data', bytes => process.stderr.write(backend.redact(bytes.toString())));
    let tail = Promise.resolve();
    child.on('message', message => {
      if (message?.type !== 'chat-relationship-fixture') return;
      tail = tail.then(async () => {
        try { await fixtures.changeJourneyRelationship(f, message.action); child.send({ id: message.id, ok: true }); }
        catch { child.send({ id: message.id, ok: false }); }
      });
    });
    const timeout = setTimeout(() => { child.kill('SIGTERM'); }, 240_000);
    ctx.defer(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', async code => {
      clearTimeout(timeout); await tail;
      if (code === 0) resolve(); else reject(new Error(`dedicated screen journey failed (${code})`));
    });
  });
  log('PASS real screen journey and dedicated clients closed');
}

export const SUITE_NAMES = ['db', 'journey', 'backend'];
const SUITE_RUNNERS = { db: dbSuite, journey: journeySuite, backend: backendSuite };

// `all` deliberately gives every suite its own withChatTestStack lifetime and
// continues after a failure so one broken suite cannot hide another. Each
// lifetime still owns its own collision, cleanup and normal-state contract.
export async function runSuites(suite, { withStack = stack.withChatTestStack, runners = SUITE_RUNNERS } = {}) {
  const selected = suite === 'all' ? SUITE_NAMES : [suite];
  const failures = [];
  for (const name of selected) {
    try { await withStack(runners[name]); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const suite = process.argv[3];
if (isMain && (process.argv[2] !== '--suite' || !['backend', 'journey', 'db', 'all'].includes(suite) || process.argv.length !== 4)) {
  console.error('Usage: node scripts/test-chat-backend.mjs --suite backend|journey|db|all');
  process.exitCode = 2;
} else if (isMain) {
  let before;
  try {
    before = await protectedState();
    await runSuites(suite);
    log(`PASS dedicated ${suite} suite and fixture/process/stack cleanup`);
  } catch (error) {
    console.error(backend.redact(`FAIL ${error.message}`));
    process.exitCode = 1;
  } finally {
    if (before) {
      try { assert.deepEqual(await protectedState(), before); log('PASS normal development database, containers, config and app/.env unchanged'); }
      catch (error) { console.error(backend.redact(`FAIL normal-state audit: ${error.message}`)); process.exitCode = 1; }
    }
  }
}
