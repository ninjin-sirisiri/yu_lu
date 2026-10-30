import '../testSupport/localEnv';
// Restores Node's native fetch (jest-expo stubs expo/fetch's native module
// — see the module header). Imported before anything that could capture
// `fetch`, so supabase-js and the shared backend helpers talk real HTTP.
import '../testSupport/nodeFetch';

// Task 21: 実データ通し操作 (A/B real-data journey against the REAL local
// backend). This is the OAuth device-verification evidence's SEPARATE
// sibling: every step below runs through the production client adapters
// (backend/queries, backend/profile, sync/api, sync/queue + worker,
// sync/lifecycle) against the real local Supabase — real Auth users, real
// app-command / app-query Edge Functions, real rows. What is simulated is
// only the platform layer the journey must control: the SQLite driver
// (node:sqlite, the established storage.integration pattern) and one
// connection-level outage window (the CommandApi port reports a transport
// failure exactly like a lost network — the queue/lifecycle code under
// test is the real one).
//
// Auth pattern is REUSED, not duplicated: scripts/lib/local-backend.cjs is
// the exact helper the suite runner uses (admin-created local Auth users +
// locally minted JWTs verified against the real `GET /auth/v1/user`; the
// email provider is disabled in the product config, so no password grant).
// Connection truth comes from `npx supabase status`; the EXPO_PUBLIC_*
// values the app modules read at import time come from app/.env — and the
// two are asserted to be the SAME local stack below, so this test can
// never silently prove itself against a different backend.
//
// Covered, in journey order: 未登録ガード → A/B 登録 → 完全一致/部分一致
// 検索 (Streak は友達前なし) → キュー経由の申請送信 + 受信一覧の7日期限 →
// 直接承認 → 両方向の友達成立 → キュー経由のプロフィール更新公開 →
// オフライン保存 (送信待ちのまま・サーバー不変) → 再起動 (storage再オープン)
// → 復帰drainで同一operation idが送られ公開される。Search ordering
// (完全一致→前方→部分一致, 20件ページング) is covered with a 30-user
// fixture by the runner's discovery suite; this file covers the FLOW.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SUPABASE_ANON_KEY_ENV,
  SUPABASE_URL_ENV,
  createAppClient,
  type AuthStorage,
} from '../src/backend/client';
import { getOwnPublication } from '../src/backend/profile';
import { getProfile, listFriends, listRequests, searchProfiles } from '../src/backend/queries';
import { assertRegistrationInput } from '../src/profiles/registration';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { listOperations } from '../src/storage/outbox';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { createCommandApi, type CommandApi, type CommandEnvelope } from '../src/sync/api';
import { createSyncLifecycle } from '../src/sync/lifecycle';
import { createSyncQueue, type SyncQueue } from '../src/sync/queue';
import { createSyncWorker } from '../src/sync/worker';
import { missingJourneyEnv, isDedicatedJourneyEnv } from '../testSupport/localEnv';

// Shared helpers: the SAME module scripts/test-local-backend.mjs imports.
// Required (not imported) because jest does not transform `.mjs` — the
// helper is CommonJS precisely so both runtimes load ONE implementation.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const localBackend = require('../../scripts/lib/local-backend.cjs') as {
  readSupabaseStatus(workdir?: string): LocalStatus;
  adminCreateUser(status: LocalStatus, email: string, password: string): Promise<string>;
  adminDeleteUser(status: LocalStatus, userId: string): Promise<void>;
  mintUserToken(status: LocalStatus, userId: string): Promise<string>;
  startFunctionsServe(): FunctionsServe;
  waitForGateway(status: LocalStatus, serve: FunctionsServe, timeoutMs: number): Promise<void>;
  stopFunctionsServe(serve: FunctionsServe): Promise<void>;
};

// Task 15: the dedicated runner owns the stack and the gateway. Its values
// are the ONLY connection source in this mode; app/.env was not loaded by
// testSupport/localEnv.
const DEDICATED_PROJECT = 'daily-chat-home-chat-test';
const DEDICATED_API_URL = 'http://127.0.0.1:55321';
const dedicated = isDedicatedJourneyEnv();
const dedicatedWorkdir = (process.env.LEGACY_JOURNEY_WORKDIR ?? '').trim();
const dedicatedProject = (process.env.LEGACY_JOURNEY_PROJECT ?? '').trim();
const dedicatedExpectedUrl = (process.env.LEGACY_JOURNEY_EXPECTED_API_URL ?? '').trim();
const sharedGateway = process.env.LEGACY_JOURNEY_USE_SHARED_GATEWAY === '1';

interface LocalStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
  JWT_SECRET: string;
  SECRET_KEY?: string;
}

interface FunctionsServe {
  child: { exitCode: number | null };
  output: string[];
}

// The journey needs real network + a real functions gateway: generous
// per-test ceiling, single worker (the brief runs it with --runInBand).
jest.setTimeout(180_000);

// ---------------------------------------------------------------------------
// Journey state, shared across the ordered steps (they are one story).
// ---------------------------------------------------------------------------

const runId = randomUUID().replaceAll('-', '').slice(0, 8);
const ID_A = `j${runId}a`;
const ID_B = `j${runId}b`;
/** Case-flipped SUBSTRING of B's id that is neither a prefix of B nor in A. */
const SUBSTRING_QUERY = ID_B.slice(2).toUpperCase();

const state = {
  status: null as LocalStatus | null,
  serve: null as FunctionsServe | null,
  createdIds: [] as string[],
  userA: null as { id: string; token: string } | null,
  userB: null as { id: string; token: string } | null,
  clientA: null as SupabaseClient | null,
  clientB: null as SupabaseClient | null,
  storage: null as AppStorage | null,
  queue: null as SyncQueue | null,
  /** Logical clock for the queue only (the server keeps real time). */
  nowMs: Date.now(),
  clock: null as { now(): number } | null,
  /** Connection-level outage window (transport reports, nothing else). */
  offline: false,
  api: null as CommandApi | null,
  dbPath: '',
  tmpRoot: '',
  pendingRequestId: null as string | null,
};

const clock = { now: (): number => state.nowMs };
state.clock = clock;

function memoryAuthStorage(): AuthStorage {
  const map = new Map<string, string>();
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
  };
}

/** Real client + a real (admin-created) user's locally minted JWT. */
async function createJourneyClient(token: string): Promise<SupabaseClient> {
  const client = createAppClient({ authStorage: memoryAuthStorage() });
  // `setSession` validates the minted access token against the REAL local
  // `GET /auth/v1/user` before storing it — a wrong claim shape fails here.
  const result = await client.auth.setSession({
    access_token: token,
    // Never used: the minted token is valid for the whole journey (1h) and
    // auto-refresh has no sessions row to refresh from.
    refresh_token: 'local-journey-no-refresh',
  });
  if (result.error !== null || result.data.session === null) {
    throw new Error(`journey session rejected: ${result.error?.message ?? 'no session'}`);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const missing = missingJourneyEnv();
  if (missing.length > 0) {
    throw new Error(
      dedicated
        ? `the dedicated journey needs the runner to supply ${missing.join(' and ')} for ` +
            `${DEDICATED_API_URL}. No value is invented here.`
        : `the real-data journey needs ${missing.join(' and ')} — copy app/.env.example ` +
            'to app/.env with the local Supabase values (`npx supabase status`). ' +
            'No value is invented here.',
    );
  }

  let status: LocalStatus;
  if (dedicated) {
    // Strict dedicated mode: the runner must have selected the owned
    // project/port/workdir and must own the gateway. Never fall back to the
    // normal checkout, app/.env or a second functions serve.
    if (!sharedGateway) {
      throw new Error(
        'the dedicated journey requires LEGACY_JOURNEY_USE_SHARED_GATEWAY=1 ' +
          '(the runner owns the functions serve)',
      );
    }
    if (process.env.EXPO_NO_DOTENV !== '1') {
      throw new Error('the dedicated journey requires EXPO_NO_DOTENV=1 (the runner supplies config)');
    }
    if (dedicatedProject !== DEDICATED_PROJECT) {
      throw new Error(
        `the dedicated journey requires project ${DEDICATED_PROJECT}, got ` +
          `${dedicatedProject === '' ? '(missing)' : dedicatedProject}`,
      );
    }
    if (dedicatedExpectedUrl !== DEDICATED_API_URL) {
      throw new Error(
        `the dedicated journey requires expected API URL ${DEDICATED_API_URL}, got ` +
          `${dedicatedExpectedUrl === '' ? '(missing)' : dedicatedExpectedUrl}`,
      );
    }
    const repoRoot = path.resolve(__dirname, '..', '..');
    const resolvedWorkdir = path.resolve(dedicatedWorkdir);
    const relative = path.relative(repoRoot, resolvedWorkdir);
    if (
      resolvedWorkdir === repoRoot ||
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    ) {
      throw new Error(
        `the dedicated journey workdir must be outside the normal checkout, got ${resolvedWorkdir}`,
      );
    }
    const configPath = path.join(resolvedWorkdir, 'supabase', 'config.toml');
    let config: string;
    try {
      config = fs.readFileSync(configPath, 'utf8');
    } catch (cause) {
      throw new Error(
        `the dedicated journey workdir has no supabase/config.toml (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
    if (!new RegExp(`^project_id = "${DEDICATED_PROJECT}"$`, 'm').test(config)) {
      throw new Error(`the dedicated journey workdir is not project ${DEDICATED_PROJECT}`);
    }
    if (!/^\s*port = 55321$/m.test(config)) {
      throw new Error(`the dedicated journey workdir is not on the dedicated port 55321`);
    }
    try {
      status = localBackend.readSupabaseStatus(resolvedWorkdir);
    } catch (cause) {
      throw new Error(
        `the dedicated legacy stack is not reachable — the runner must start it ` +
          `(\`${cause instanceof Error ? cause.message : String(cause)}\`).`,
      );
    }
    if (status.API_URL !== DEDICATED_API_URL) {
      throw new Error(
        `the dedicated journey must use ${DEDICATED_API_URL}, got ${status.API_URL}`,
      );
    }
  } else {
    try {
      status = localBackend.readSupabaseStatus();
    } catch (cause) {
      throw new Error(
        `local Supabase is not reachable — start it with \`npx supabase start\` ` +
          `(\`${cause instanceof Error ? cause.message : String(cause)}\`).`,
      );
    }
  }
  state.status = status;

  // The journey must hit EXACTLY the stack the app is configured for — a
  // different URL/key would silently turn this into evidence for something
  // else. In dedicated mode the comparison target is the CHOSEN dedicated
  // status, never the normal checkout.
  const envUrl = (process.env[SUPABASE_URL_ENV] ?? '').trim();
  const envAnon = (process.env[SUPABASE_ANON_KEY_ENV] ?? '').trim();
  if (envUrl !== status.API_URL || envAnon !== status.ANON_KEY) {
    throw new Error(
      `${dedicated ? 'the dedicated runner environment' : 'app/.env'} does not match the ` +
        `selected Supabase status output ` +
        `(URL ${envUrl === status.API_URL ? 'ok' : 'DIFFERENT'}, ` +
        `anon key ${envAnon === status.ANON_KEY ? 'ok' : 'DIFFERENT'}). ` +
        'The journey refuses to run against a different backend.',
    );
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(envUrl)) {
    throw new Error(`the journey only runs against loopback, got ${envUrl}`);
  }

  // Real local Auth users + minted/verified JWTs (shared helper).
  const password = `${randomUUID()}aA1!`;
  for (const email of [
    `journey-a-${runId}@journey.test`,
    `journey-b-${runId}@journey.test`,
  ]) {
    const userId = await localBackend.adminCreateUser(status, email, password);
    state.createdIds.push(userId);
    const token = await localBackend.mintUserToken(status, userId);
    const user = { id: userId, token };
    if (email.startsWith('journey-a-')) state.userA = user;
    else state.userB = user;
  }
  if (state.userA === null || state.userB === null) {
    throw new Error('journey users were not created');
  }

  // Normal CLI mode owns its gateway. Dedicated mode uses the runner's
  // already-ready serve and must never start or stop a second one.
  if (!dedicated) {
    state.serve = localBackend.startFunctionsServe();
    await localBackend.waitForGateway(status, state.serve, 90_000);
  }

  state.clientA = await createJourneyClient(state.userA.token);
  state.clientB = await createJourneyClient(state.userB.token);

  // Real SQLite for the outbox (production SQL via node:sqlite).
  state.tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-journey-'));
  state.dbPath = path.join(state.tmpRoot, 'app.db');
  state.storage = await openAppDatabase({ driver: new NodeSqliteDriver(state.dbPath) });
  state.queue = createSyncQueue({ store: state.storage, clock, random: Math.random });

  // The one network port: a real command API behind an outage switch.
  const real = createCommandApi({ client: state.clientA });
  state.api = {
    send: async (command: CommandEnvelope) => {
      if (state.offline) {
        // Connection-level failure with NO HTTP status — exactly how the
        // real port classifies a lost network (sync/api.ts).
        return { status: 'transient', message: 'connection failure (journey outage window)' };
      }
      return real.send(command);
    },
  };
});

afterAll(async () => {
  if (state.serve !== null) {
    try {
      await localBackend.stopFunctionsServe(state.serve);
    } catch {
      // Already gone; cleanup must not mask the test results.
    }
    state.serve = null;
  }
  for (const client of [state.clientA, state.clientB]) {
    if (client === null) continue;
    try {
      client.auth.stopAutoRefresh();
    } catch {
      // Not every auth version exposes the stopper; sessions die with the test.
    }
    try {
      await client.auth.signOut({ scope: 'local' });
    } catch {
      // Local-only cleanup, best effort.
    }
  }
  if (state.storage !== null) {
    try {
      await state.storage.close();
    } catch {
      // Already closed by the restart step.
    }
    state.storage = null;
  }
  if (state.tmpRoot !== '') {
    fs.rmSync(state.tmpRoot, { recursive: true, force: true });
    state.tmpRoot = '';
  }
  const status = state.status;
  if (status !== null) {
    for (const userId of state.createdIds.splice(0)) {
      try {
        await localBackend.adminDeleteUser(status, userId);
      } catch {
        // Reported by the runner too: cleanup warnings never fail a run.
      }
    }
  }
});

function userA(): { id: string; token: string } {
  if (state.userA === null) throw new Error('user A missing');
  return state.userA;
}
function userB(): { id: string; token: string } {
  if (state.userB === null) throw new Error('user B missing');
  return state.userB;
}
function clientA(): SupabaseClient {
  if (state.clientA === null) throw new Error('client A missing');
  return state.clientA;
}
function clientB(): SupabaseClient {
  if (state.clientB === null) throw new Error('client B missing');
  return state.clientB;
}
function storage(): AppStorage {
  if (state.storage === null) throw new Error('storage missing');
  return state.storage;
}
function queue(): SyncQueue {
  if (state.queue === null) throw new Error('queue missing');
  return state.queue;
}
function api(): CommandApi {
  if (state.api === null) throw new Error('api missing');
  return state.api;
}

// ---------------------------------------------------------------------------
// Journey steps
// ---------------------------------------------------------------------------

describe('A/B journey through the real local backend', () => {
  it('refuses every discovery read until the User ID is confirmed (未登録ガード)', async () => {
    await expect(searchProfiles('journey', null, clientA())).rejects.toThrow(
      'Confirm the User ID before using the app.',
    );
    await expect(listFriends(null, clientA())).rejects.toThrow(
      'Confirm the User ID before using the app.',
    );
  });

  it('registers A and B through the production command path', async () => {
    // Same validation the registration screen runs before submitting.
    const confirmedA = assertRegistrationInput(ID_A, 'Journey A');
    const confirmedB = assertRegistrationInput(ID_B, 'Journey B');
    expect(confirmedA.userIdText).toBe(ID_A);
    expect(confirmedB.userIdText).toBe(ID_B);

    // Real wire, one self-registration per user (provider-equivalent path:
    // assertRegistrationInput → createCommandApi.send → app-command).
    const outcomeA = await createCommandApi({ client: clientA() }).send({
      accountId: userA().id,
      operationId: randomUUID(),
      kind: 'register',
      payload: { user_id_text: confirmedA.userIdText, display_name: confirmedA.displayName },
    });
    const outcomeB = await createCommandApi({ client: clientB() }).send({
      accountId: userB().id,
      operationId: randomUUID(),
      kind: 'register',
      payload: { user_id_text: confirmedB.userIdText, display_name: confirmedB.displayName },
    });
    expect(outcomeA.status).toBe('ok');
    expect(outcomeB.status).toBe('ok');

    // Registered → the gate is open and the friend list starts empty.
    const friendsA = await listFriends(null, clientA());
    expect(friendsA.items).toEqual([]);
    const friendsB = await listFriends(null, clientB());
    expect(friendsB.items).toEqual([]);
  });

  it('finds B by exact and by case-flipped partial match, without a pre-friendship streak', async () => {
    // 完全一致
    const exact = await searchProfiles(ID_B, null, clientA());
    expect(exact.items.map((item) => item.userIdText)).toEqual([ID_B]);

    // その他の部分一致 (not a prefix of B, not contained in A, case-flipped).
    expect(ID_B.startsWith(SUBSTRING_QUERY)).toBe(false);
    expect(ID_A.toUpperCase()).not.toContain(SUBSTRING_QUERY);
    const partial = await searchProfiles(SUBSTRING_QUERY, null, clientA());
    expect(partial.items.map((item) => item.userIdText)).toEqual([ID_B]);
    expect(partial.items[0]?.relationship).toBe('none');
    expect(partial.items[0]).not.toHaveProperty('streak');

    // The opened profile: introduction readable, relationship 未申請,
    // Streak absent (友達になる前のStreakは見せない).
    const detail = await getProfile(userB().id, clientA());
    expect(detail.userIdText).toBe(ID_B);
    expect(detail.displayName).toBe('Journey B');
    expect(detail.introduction).toBeNull();
    expect(detail.relationship).toBe('none');
    expect(detail).not.toHaveProperty('streak');
  });

  it("sends A's request through the real outbox queue; B's inbox shows it with 7-day validity", async () => {
    const { operation } = await queue().enqueue({
      accountId: userA().id,
      kind: 'request',
      payload: { target_user_id: userB().id },
    });

    const worker = createSyncWorker({ queue: queue(), api: api(), accountId: userA().id });
    const steps = await worker.runUntilIdle();
    expect(steps).toHaveLength(1);
    expect(steps[0]?.outcome).toBe('ok');
    expect(steps[0]?.state).toBe('succeeded');

    const rows = await listOperations(storage(), userA().id);
    const row = rows.find((candidate) => candidate.operationId === operation.operationId);
    expect(row?.state).toBe('succeeded');

    const inbox = await listRequests('incoming', null, clientB());
    expect(inbox.items).toHaveLength(1);
    const entry = inbox.items[0];
    if (entry === undefined) throw new Error('inbox entry missing');
    state.pendingRequestId = entry.requestId;
    expect(entry.status).toBe('pending');
    expect(entry.counterpart.userIdText).toBe(ID_A);
    const ttl = Date.parse(entry.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(ttl).toBeLessThan(8 * 24 * 60 * 60 * 1000);

    // Sender view: the pending request is visible as 申請中.
    const outgoing = await listRequests('outgoing', null, clientA());
    expect(outgoing.items.map((item) => `${item.status}|${item.counterpart.userIdText}`)).toEqual([
      `pending|${ID_B}`,
    ]);
  });

  it('approves directly (decide path) and the friendship is established on both sides', async () => {
    const requestId = state.pendingRequestId;
    if (requestId === null) throw new Error('no pending request from the previous step');
    const outcome = await createCommandApi({ client: clientB() }).send({
      accountId: userB().id,
      operationId: randomUUID(),
      kind: 'approve',
      payload: { request_id: requestId },
    });
    expect(outcome.status).toBe('ok');

    const friendsA = await listFriends(null, clientA());
    expect(friendsA.items.map((item) => item.userIdText)).toEqual([ID_B]);
    expect(friendsA.items[0]?.relationship).toBe('friend');
    expect(typeof friendsA.items[0]?.streak).toBe('number');

    const friendsB = await listFriends(null, clientB());
    expect(friendsB.items.map((item) => item.userIdText)).toEqual([ID_A]);
    expect(friendsB.items[0]?.relationship).toBe('friend');
    expect(typeof friendsB.items[0]?.streak).toBe('number');

    // From B's opened profile of A: now a friend, streak visible.
    const detail = await getProfile(userA().id, clientB());
    expect(detail.relationship).toBe('friend');
    expect(typeof detail.streak).toBe('number');
  });

  it('publishes a profile update through the queue; B reads the new public content', async () => {
    const own = await getOwnPublication(clientA());
    expect(own.displayName).toBe('Journey A');
    const nextVersion = own.profileVersion + 1;

    const { operation } = await queue().enqueue({
      accountId: userA().id,
      kind: 'update_profile',
      payload: {
        base_version: own.profileVersion,
        display_name: '旅立ちA',
        introduction: 'よろしくお願いします。\nローカル実データの旅路です。',
      },
      baseVersion: own.profileVersion,
    });
    const worker = createSyncWorker({ queue: queue(), api: api(), accountId: userA().id });
    const steps = await worker.runUntilIdle();
    expect(steps).toHaveLength(1);
    expect(steps[0]?.operationId).toBe(operation.operationId);
    expect(steps[0]?.outcome).toBe('ok');

    // Owner read: published fields and the bumped compare-and-swap version.
    const published = await getOwnPublication(clientA());
    expect(published.displayName).toBe('旅立ちA');
    expect(published.introduction).toBe('よろしくお願いします。\nローカル実データの旅路です。');
    expect(published.profileVersion).toBe(nextVersion);

    // Reader: B sees exactly the published content (no pending blend).
    const seen = await getProfile(userA().id, clientB());
    expect(seen.displayName).toBe('旅立ちA');
    expect(seen.introduction).toBe('よろしくお願いします。\nローカル実データの旅路です。');
    expect(seen.relationship).toBe('friend');
  });

  it('holds an offline save as 送信待ち, then publishes it after restart/recovery under the SAME operation id', async () => {
    const before = await getOwnPublication(clientA());
    const introBefore = before.introduction;

    // --- outage window: the transport reports a connection-level failure.
    state.offline = true;
    const { operation } = await queue().enqueue({
      accountId: userA().id,
      kind: 'update_profile',
      payload: {
        base_version: before.profileVersion,
        introduction: 'オフラインで書いた下書き。',
      },
      baseVersion: before.profileVersion,
    });
    const worker = createSyncWorker({ queue: queue(), api: api(), accountId: userA().id });
    const offlineSteps = await worker.runUntilIdle();
    expect(offlineSteps).toHaveLength(1);
    expect(offlineSteps[0]?.outcome).toBe('transient');
    expect(offlineSteps[0]?.state).toBe('pending'); // 送信待ち, not condemned

    // Server and other users are unchanged while offline.
    const ownOffline = await getOwnPublication(clientA());
    expect(ownOffline.introduction).toBe(introBefore);
    expect(ownOffline.profileVersion).toBe(before.profileVersion);
    const seenOffline = await getProfile(userA().id, clientB());
    expect(seenOffline.introduction).toBe(introBefore);

    // --- restart: close the DB and reopen it (new handle = new process).
    await storage().close();
    state.storage = await openAppDatabase({ driver: new NodeSqliteDriver(state.dbPath) });
    state.queue = createSyncQueue({ store: storage(), clock, random: Math.random });

    // The outbox row survived the restart with its original operation id.
    const rows = await listOperations(storage(), userA().id);
    const pending = rows.filter((row) => row.kind === 'update_profile' && row.state === 'pending');
    expect(pending.map((row) => row.operationId)).toContain(operation.operationId);

    // --- connectivity restored: the queue's own backoff (≈5s first retry)
    // has elapsed on the injected clock; nothing is force-sent early.
    state.offline = false;
    state.nowMs += 60_000;

    // Recovery goes through the PRODUCTION lifecycle drain (the same entry
    // point the foreground/network-resume listeners call on device).
    const lifecycle = createSyncLifecycle({
      getAccountId: async () => {
        const { data } = await clientA().auth.getSession();
        return data.session?.user?.id ?? null;
      },
      openStorage: async () => storage(),
      createApi: () => api(),
      clock,
      random: () => 0.5, // deterministic jitter midpoint
      appState: null,
      network: null,
    });
    const result = await lifecycle.drain('resume');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.operationId).toBe(operation.operationId);
    expect(result.steps[0]?.outcome).toBe('ok');

    const ownAfter = await getOwnPublication(clientA());
    expect(ownAfter.introduction).toBe('オフラインで書いた下書き。');
    expect(ownAfter.profileVersion).toBe(before.profileVersion + 1);

    const rowsAfter = await listOperations(storage(), userA().id);
    const settled = rowsAfter.find((row) => row.operationId === operation.operationId);
    expect(settled?.state).toBe('succeeded');

    // The other user reads it too — the journey closes on real data.
    const seenAfter = await getProfile(userA().id, clientB());
    expect(seenAfter.introduction).toBe('オフラインで書いた下書き。');
    expect(seenAfter.relationship).toBe('friend');
  });
});
