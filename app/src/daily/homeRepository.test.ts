import { createHomeRepository } from './homeRepository';
import { createRepositorySession } from '../messages/repository';
import { createReadStateRepository } from '../messages/readState';
import { openAppDatabase, type AppStorage } from '../storage/database';
import { NodeSqliteDriver } from '../storage/testSupport/nodePorts';
import { A, B, CONV, api, home, summary, key, deferred } from '../messages/repositoryTestSupport';

let db: AppStorage;
let now: number;
beforeEach(async () => { db = await openAppDatabase({ driver: new NodeSqliteDriver(':memory:') }); now = 0; });
afterEach(async () => { await db.close(); });
function setup(client = api()) {
  const session = createRepositorySession({ storage: db, accountId: A, getAccountId: async () => A });
  const reads = createReadStateRepository({ session, newId: () => key(90), commandApi: { send: async () => ({ status: 'unknown' }) } });
  return { repo: createHomeRepository({ session, reads, client, now: () => now }), client, reads, session };
}

it('keeps all targets separate from other-chat paging and drops duplicate peers', async () => {
  const { repo, client } = setup();
  (client.listChats as jest.Mock).mockResolvedValueOnce({ revision: 1, server_now: home().server_now, daily_key: home().daily_key,
    targets: [summary()], items: [], next_cursor: 'first-page', unread_peer_count: 1 });
  await repo.refreshHome();
  (client.listChats as jest.Mock).mockResolvedValueOnce({ revision: 1, server_now: home().server_now, daily_key: home().daily_key,
    targets: [summary()], items: [summary(), summary({ peer_id: 'carol' })], next_cursor: 'next', unread_peer_count: 1 });
  await repo.loadMore();
  expect((await repo.snapshot()).targets).toHaveLength(1);
  expect((await repo.snapshot()).others.map(p => p.peer_id)).toEqual(['carol']);
});

it('uses server-relative time for 04:00 rollover and labels old-day cache stale', async () => {
  const { repo } = setup(); await repo.refreshHome();
  now = 9_999; expect((await repo.snapshot()).dayStatus).toBe('current');
  now = 10_000; expect((await repo.snapshot()).dayStatus).toBe('stale');
  const reopened = setup().repo;
  expect((await reopened.snapshot()).dayStatus).toBe('stale');
  expect((await reopened.snapshot()).home?.daily_key).toBe('2026-10-28');
});

it('fences old daily and revision responses', async () => {
  const { repo, client, session } = setup();
  const old = deferred<ReturnType<typeof home>>();
  (client.getHome as jest.Mock).mockReturnValueOnce(old.promise);
  const pending = repo.refreshHome();
  (client.getHome as jest.Mock).mockResolvedValueOnce(home({ revision: 2, daily_key: '2026-10-29', server_now: '2026-10-28T19:00:00Z', deadline: '2026-10-29T19:00:00Z' }));
  (client.listChats as jest.Mock).mockResolvedValue({ revision: 2, daily_key: '2026-10-29', server_now: '2026-10-28T19:00:00Z', targets: [], items: [], next_cursor: null, unread_peer_count: 0 });
  (client.getUnread as jest.Mock).mockResolvedValue({ revision: 2, items: [], unread_peer_count: 0 });
  await repo.refreshHome(); old.resolve(home()); await pending;
  expect((await repo.snapshot()).home?.daily_key).toBe('2026-10-29');
  session.observeRevision(10);
  expect(await repo.refreshHome()).toBe(false);
});

it('applies bounded local read union to both per-peer counts and badge without later-arrival loss', async () => {
  const { repo, client, reads } = setup(); await repo.refreshHome();
  await reads.record(B, CONV, [], 3);
  expect((await repo.snapshot()).targets[0].unread_count).toBe(0);
  expect((await repo.snapshot()).unreadPeerCount).toBe(0);
  (client.getUnread as jest.Mock).mockResolvedValue({ revision: 2, unread_peer_count: 1,
    items: [{ peer_id: B, conversation_id: CONV, unread_count: 1, first_unread_sequence: 4, latest_sequence: 4 }] });
  (client.getHome as jest.Mock).mockResolvedValue(home({ revision: 2 }));
  (client.listChats as jest.Mock).mockResolvedValue({ revision: 2, daily_key: home().daily_key, server_now: home().server_now,
    targets: [summary()], items: [], next_cursor: null, unread_peer_count: 1 });
  await repo.refreshHome();
  expect((await repo.snapshot()).targets[0].unread_count).toBe(1);
  expect((await repo.snapshot()).unreadPeerCount).toBe(1);
});

it('does not double subtract acknowledged reads from a newer unread snapshot', async () => {
  const client = api();
  const session = createRepositorySession({ storage: db, accountId: A, getAccountId: async () => A });
  const reads = createReadStateRepository({ session, newId: () => key(91), commandApi: { send: async () => ({ status: 'ok',
    data: { result: { conversation_id: CONV, message_ids: [], through_sequence: 3 } } }) } });
  const repo = createHomeRepository({ session, reads, client, now: () => now });
  await repo.refreshHome();
  await reads.record(B, CONV, [], 3); await reads.sync();
  expect((await repo.snapshot()).unreadPeerCount).toBe(0);
  (client.getUnread as jest.Mock).mockResolvedValue({ revision: 2, unread_peer_count: 1,
    items: [{ peer_id: B, conversation_id: CONV, unread_count: 1, first_unread_sequence: 4, latest_sequence: 4 }] });
  (client.getHome as jest.Mock).mockResolvedValue(home({ revision: 2 }));
  (client.listChats as jest.Mock).mockResolvedValue({ revision: 2, daily_key: home().daily_key, server_now: home().server_now,
    targets: [summary()], items: [], next_cursor: null, unread_peer_count: 1 });
  await repo.refreshHome();
  expect((await repo.snapshot()).unreadPeerCount).toBe(1);
  expect((await repo.snapshot()).targets[0].unread_count).toBe(1);
});

it('retains all 26 daily targets while paging 20 other conversations and stops at a null cursor', async () => {
  const { repo, client } = setup();
  const targets = Array.from({ length: 26 }, (_, i) => summary({ peer_id: `target-${i}` }));
  (client.getHome as jest.Mock).mockResolvedValue(home({ targets }));
  (client.listChats as jest.Mock).mockResolvedValue({ revision: 1, daily_key: home().daily_key, server_now: home().server_now,
    targets, items: Array.from({ length: 20 }, (_, i) => summary({ peer_id: `other-${i}` })), next_cursor: null, unread_peer_count: 1 });
  await repo.refreshHome();
  expect((await repo.snapshot()).targets).toHaveLength(26);
  expect((await repo.snapshot()).others).toHaveLength(20);
  expect(await repo.loadMore()).toBe(false);
  expect(client.listChats).toHaveBeenCalledTimes(1);
});
