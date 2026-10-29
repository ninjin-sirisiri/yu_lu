import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { File } from 'expo-file-system';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import type { ProfileImageUpload, ProfilePublication } from '../src/backend/profile';
import { deleteAccountData, openAppDatabase, type AppStorage } from '../src/storage/database';
import { readDraft } from '../src/storage/drafts';
import { readAvatarDraft, saveAvatarDraft } from '../src/media/avatar';
import { createImageStore, expoFileSystemPort, type ImageReference } from '../src/storage/files';
import { listOperations } from '../src/storage/outbox';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import type { CommandEnvelope, CommandOutcome } from '../src/sync/api';
import { PENDING_DEADLINE_MS, createSyncQueue, type SyncQueue } from '../src/sync/queue';
import {
  PROFILE_CONFLICT_KEY,
  PROFILE_DRAFT_KEY,
  createProfileEditor,
  validateProfileDraft,
  type ProfileEditor,
  type ProfileEditorDeps,
  type ProfileSaveResult,
} from '../src/profiles/editor';
import {
  buildConflictRows,
  conflictSelectionDefaults,
  type ProfileConflictRecord,
} from '../src/profiles/conflict';
import {
  DISPLAY_NAME_FIXTURE,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_TOO_LONG_ERROR,
  INTRODUCTION_FIXTURE,
  INTRODUCTION_MAX_LENGTH,
  INTRODUCTION_TOO_LONG_ERROR,
  VISUAL_LENGTH_FIXTURE,
  validateDisplayNameInput,
  validateIntroductionInput,
  visualLength,
} from '../src/profiles/validation';

// Task 17: プロフィール編集・競合解決.
//
// Part A (headless): the real controller over a real SQLite draft/outbox
// (Node driver, the same SQL the device runs), the REAL queue/worker, and
// a fake server reproducing 0012's compare-and-swap semantics (base_version
// match → atomic bump; mismatch → 409 with the latest fields and the
// differing fields). Every pipeline rule is asserted against that.
// Part B (router): the edit/conflict screens through the REAL route tree
// with the device wiring — only the outside world (own-row read, command
// port, storage upload, OS picker) is mocked.
//
// renderRouter turns on jest FAKE timers for the rest of the file, so the
// headless suites run first and re-assert real timers in their beforeEach.

jest.mock('../src/auth/provider', () => {
  const React = require('react');
  const value = {
    status: 'ready',
    error: null,
    accountId: '11111111-1111-4111-8111-111111111111',
    registration: 'registered',
    onboardingSeen: true,
    get storage() {
      return mockStorage;
    },
    refresh: async () => {},
    signIn: async () => ({ status: 'cancelled' }),
    submitRegistration: async () => ({ status: 'registered' }),
    markOnboardingSeen: async () => true,
    markOnboardingSeenIfInvited: async () => false,
  };
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useAuth: () => value,
    classifyCompletedLogin: () => ({
      kind: 'returning',
      accountId: '11111111-1111-4111-8111-111111111111',
    }),
  };
});

jest.mock('../src/backend/profile', () => {
  const actual = jest.requireActual('../src/backend/profile');
  return {
    ...actual,
    getOwnPublication: async () => {
      if (mockServer === null) throw new Error('profile-editor test: server not installed');
      return mockServer.fetchPublication();
    },
    profileImageUrl: async () => null,
    uploadProfileImage: (...args: unknown[]) => mockUploadProfileImage(...args),
  };
});

jest.mock('../src/sync/api', () => {
  const actual = jest.requireActual('../src/sync/api');
  return {
    ...actual,
    createCommandApi: jest.fn(() => ({ send: (envelope: CommandEnvelope) => mockSend(envelope) })),
  };
});

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true })),
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'denied' })),
}));

let mockStorage: AppStorage | null = null;
let mockServer: FakeProfileServer | null = null;
let mockUploadProfileImage: jest.Mock;

const mockSend = (envelope: CommandEnvelope): Promise<CommandOutcome> => {
  if (mockServer === null) {
    return Promise.reject(new Error('profile-editor test: server not installed'));
  }
  return mockServer.handle(envelope);
};

// ---------------------------------------------------------------------------
// The fake server: 0012 compare-and-swap semantics over in-memory state
// ---------------------------------------------------------------------------

interface ServerFields {
  displayName: string;
  introduction: string | null;
  avatarPath: string | null;
}

function normalizeIntro(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

class FakeProfileServer {
  version = 1;
  fields: ServerFields = { displayName: '花子', introduction: null, avatarPath: null };
  userIdText = 'hanako';
  sends: Array<{ operationId: string; payload: Record<string, unknown> }> = [];
  failUpload = false;

  fetchPublication = async (): Promise<ProfilePublication> => ({
    ...this.fields,
    profileVersion: this.version,
    userIdText: this.userIdText,
  });

  /** Storage upload seam (the mocked device upload calls into this). */
  async acceptUpload(operationId: string, upload: ProfileImageUpload): Promise<string> {
    if (this.failUpload) throw new Error('upload failed');
    return `11111111-1111-4111-8111-111111111111/${operationId}/${upload.fileName}`;
  }

  /** Another device publishes (the 別端末 case). */
  externalPublish(patch: Partial<ServerFields>): void {
    this.fields = { ...this.fields, ...patch };
    this.version += 1;
  }

  private differing(payload: Record<string, unknown>): string[] {
    const diff: string[] = [];
    if ('display_name' in payload && payload['display_name'] !== this.fields.displayName) {
      diff.push('display_name');
    }
    if (
      'introduction' in payload &&
      normalizeIntro(payload['introduction']) !== normalizeIntro(this.fields.introduction)
    ) {
      diff.push('introduction');
    }
    if ('avatar_path' in payload && (payload['avatar_path'] ?? null) !== this.fields.avatarPath) {
      diff.push('avatar_path');
    }
    return diff;
  }

  async handle(envelope: CommandEnvelope): Promise<CommandOutcome> {
    if (envelope.kind !== 'update_profile') return { status: 'ok' };
    const payload = { ...envelope.payload };
    this.sends.push({ operationId: envelope.operationId, payload });

    if (payload['base_version'] !== this.version) {
      return {
        status: 'conflict',
        message: 'profile version conflict',
        conflict: {
          status: 'conflict',
          message: 'profile version conflict',
          version: this.version,
          profile: {
            display_name: this.fields.displayName,
            introduction: this.fields.introduction,
            avatar_path: this.fields.avatarPath,
          },
          differing_fields: this.differing(payload),
        },
      };
    }

    if ('display_name' in payload) this.fields.displayName = payload['display_name'] as string;
    if ('introduction' in payload) this.fields.introduction = normalizeIntro(payload['introduction']);
    if ('avatar_path' in payload) this.fields.avatarPath = payload['avatar_path'] as string | null;
    this.version += 1;
    return { status: 'ok' };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const T0 = 1_700_000_000_000;
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';

function testUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function queued(result: ProfileSaveResult): { operationId: string; coalesced: boolean } {
  if (result.status !== 'queued') throw new Error(`expected queued, got ${result.status}`);
  return result;
}

async function stageAvatar(
  storage: AppStorage,
  relativePath: string = `images/${ACCOUNT}/staged-1.jpg`,
): Promise<ImageReference> {
  const reference: ImageReference = {
    accountId: ACCOUNT,
    imageId: 'staged-1',
    relativePath,
    bytes: 2048,
  };
  await saveAvatarDraft(storage, ACCOUNT, reference);
  return reference;
}

// ---------------------------------------------------------------------------
// Part A: headless controller over the real queue
// ---------------------------------------------------------------------------

interface Harness {
  storage: AppStorage;
  queue: SyncQueue;
  server: FakeProfileServer;
  deps: ProfileEditorDeps;
  editor: ProfileEditor;
  uploadImage: jest.Mock;
  clock: { value: number };
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-editor-'));
  const storage = await openAppDatabase({
    driver: new NodeSqliteDriver(path.join(root, 'app.db')),
  });
  const clock = { value: T0 };
  let idSeq = 0;
  const queue = createSyncQueue({
    store: storage,
    clock: { now: () => clock.value },
    random: () => 0.5,
    newOperationId: () => testUuid(idSeq++),
  });
  const server = new FakeProfileServer();
  const uploadImage = jest.fn(
    (operationId: string, upload: ProfileImageUpload) => server.acceptUpload(operationId, upload),
  );
  const readFile = jest.fn(async () => new Uint8Array([1, 2, 3]));
  const deps: ProfileEditorDeps = {
    accountId: ACCOUNT,
    storage,
    queue,
    api: { send: (envelope) => server.handle(envelope) },
    fetchPublication: () => server.fetchPublication(),
    uploadImage,
    resolvePath: (reference) => `/doc/${reference.relativePath}`,
    readFile,
    newOperationId: () => testUuid(idSeq++),
    now: () => clock.value,
  };
  const editor = createProfileEditor(deps);
  return {
    storage,
    queue,
    server,
    deps,
    editor,
    uploadImage,
    clock,
    async cleanup() {
      try {
        await storage.close();
      } catch {
        // Already closed.
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

let harness: Harness;

beforeEach(async () => {
  jest.useRealTimers();
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('保存パイプライン: 保存は予約、公開はキュー', () => {
  it('saving only enqueues; the queue worker publishes everything in ONE command', async () => {
    const { editor, server, storage } = harness;
    await editor.load();
    await editor.setDisplayName('花子ちゃん');

    const saved = queued(await editor.save());
    // 保存は直接公開しない: nothing reached the server yet.
    expect(server.sends).toHaveLength(0);
    expect(server.version).toBe(1);

    const rows = await listOperations(storage, ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_profile');
    expect(rows[0].state).toBe('pending');
    expect(rows[0].payload).toMatchObject({
      base_version: 1,
      display_name: '花子ちゃん',
    });

    const pump = await editor.pump();
    expect(pump.publishedChanged).toBe(true);
    expect(pump.conflicted).toBe(false);
    expect(pump.imageUploadFailed).toBe(false);
    expect(server.sends).toHaveLength(1);
    expect(server.sends[0].operationId).toBe(saved.operationId);
    expect(server.fields.displayName).toBe('花子ちゃん');
    expect(server.version).toBe(2);

    // Published = draft → the durable draft has nothing left to hold.
    expect(await readDraft(storage, ACCOUNT, PROFILE_DRAFT_KEY)).toBeNull();
  });

  it('coalesces multiple saves into the LATEST content with a fresh 24h deadline', async () => {
    const { editor, server, storage, clock } = harness;
    await editor.load();
    await editor.setDisplayName('一回目');
    const first = queued(await editor.save());

    clock.value = T0 + 60 * 60 * 1000;
    await editor.setDisplayName('二回目');
    await editor.setIntroduction('自己紹介です');
    const second = queued(await editor.save());

    // 未送信の再保存は最後の内容へまとめ (one row, same operation, latest payload).
    expect(second.operationId).toBe(first.operationId);
    expect(second.coalesced).toBe(true);
    const rows = await listOperations(storage, ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({
      base_version: 1,
      display_name: '二回目',
      introduction: '自己紹介です',
    });
    // The deadline restarts from the LAST save (期限を最後の保存から24時間).
    expect(rows[0].expiresAt).toBe(clock.value + PENDING_DEADLINE_MS);

    const pump = await editor.pump();
    expect(pump.publishedChanged).toBe(true);
    expect(server.sends).toHaveLength(1);
    expect(server.fields.displayName).toBe('二回目');
    expect(server.fields.introduction).toBe('自己紹介です');
    expect(server.version).toBe(2);
  });

  it('cancelling the send reservation keeps the draft (取消後下書き)', async () => {
    const { editor, server, storage } = harness;
    await editor.load();
    await editor.setDisplayName('残す下書き');
    await stageAvatar(storage);
    queued(await editor.save());

    const cancelled = await editor.cancelPendingSends();
    expect(cancelled).toBe(1);
    const rows = await listOperations(storage, ACCOUNT);
    expect(rows[0].state).toBe('cancelled');

    // The draft and the staged image survive the cancellation untouched.
    expect(
      (await readDraft<{ displayName: string }>(storage, ACCOUNT, PROFILE_DRAFT_KEY))?.body
        .displayName,
    ).toBe('残す下書き');
    expect(await readAvatarDraft(storage, ACCOUNT)).not.toBeNull();

    const pump = await editor.pump();
    expect(server.sends).toHaveLength(0); // cancelled can never be claimed
    const view = await editor.load();
    expect(view.changes.hasChanges).toBe(true);
    expect(view.sendState).toBeNull();
  });
});

describe('画像失敗: 公開内容は変えず、文字だけ先に公開しない', () => {
  it('a failed image upload sends NO command: published stays, pending stays', async () => {
    const { editor, server, storage, uploadImage } = harness;
    await stageAvatar(storage); // staged BEFORE load, as the picker would on entry
    await editor.load();
    await editor.setDisplayName('画像つき');
    queued(await editor.save());

    server.failUpload = true;
    const pump = await editor.pump();

    expect(pump.imageUploadFailed).toBe(true);
    expect(pump.publishedChanged).toBe(false);
    expect(pump.conflicted).toBe(false);
    // The command never ran → text-only publication is impossible.
    expect(server.sends).toHaveLength(0);
    expect(server.version).toBe(1);
    expect(server.fields).toEqual({
      displayName: '花子',
      introduction: null,
      avatarPath: null,
    });
    expect(uploadImage).toHaveBeenCalledTimes(1);

    const view = await editor.load();
    // 本人には変更予定内容と送信状態.
    expect(view.changes.displayName).toBe('画像つき');
    expect(view.changes.avatar.kind).toBe('staged');
    expect(view.sendState?.state).toBe('pending');
    expect(await readDraft(storage, ACCOUNT, PROFILE_DRAFT_KEY)).not.toBeNull();
    expect(await readAvatarDraft(storage, ACCOUNT)).not.toBeNull();
  });

  it('retries the SAME reservation after the image upload recovers', async () => {
    const { editor, server, storage, clock } = harness;
    await stageAvatar(storage); // staged BEFORE load, as the picker would on entry
    await editor.load();
    await editor.setDisplayName('画像つき');
    queued(await editor.save());

    server.failUpload = true;
    expect((await editor.pump()).imageUploadFailed).toBe(true);

    // 接続復帰で再試行: once the upload works and the backoff is due, the
    // SAME operation publishes the text AND the image together.
    server.failUpload = false;
    clock.value = T0 + 60_000;
    const retry = await editor.pump();
    expect(retry.publishedChanged).toBe(true);
    expect(retry.imageUploadFailed).toBe(false);
    expect(server.sends).toHaveLength(1);
    expect(server.version).toBe(2);
    expect(server.fields.displayName).toBe('画像つき');
    const publishedPath = server.sends[0].payload['avatar_path'];
    expect(typeof publishedPath).toBe('string');
    expect(server.fields.avatarPath).toBe(publishedPath);
    expect(String(publishedPath).startsWith(`${ACCOUNT}/`)).toBe(true);
    expect(String(publishedPath).endsWith('/staged-1.jpg')).toBe(true);
    // The staged image became the published one → local drafts are dropped.
    expect(await readAvatarDraft(storage, ACCOUNT)).toBeNull();
    expect(await readDraft(storage, ACCOUNT, PROFILE_DRAFT_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 別端末競合 → 項目別比較・選択 → 最新版で新規操作
// ---------------------------------------------------------------------------

async function reachConflict(h: Harness): Promise<{
  record: ProfileConflictRecord;
  firstOperationId: string;
}> {
  await h.editor.load();
  h.server.externalPublish({ displayName: '別太郎', introduction: '別端末から' });
  await h.editor.setDisplayName('花子ちゃん');
  const saved = queued(await h.editor.save());
  const pump = await h.editor.pump();
  expect(pump.conflicted).toBe(true);
  expect(pump.conflict).not.toBeNull();
  return {
    record: pump.conflict as ProfileConflictRecord,
    firstOperationId: saved.operationId,
  };
}

describe('別端末競合: 項目別比較・選択・最新base_versionで新規保存', () => {
  it('captures the conflict without overwriting and resolves field by field', async () => {
    const { editor, server, storage } = harness;
    const { record, firstOperationId } = await reachConflict(harness);

    // The other device's publication was NOT overwritten by our attempt.
    expect(server.version).toBe(2);
    expect(server.fields).toEqual({
      displayName: '別太郎',
      introduction: '別端末から',
      avatarPath: null,
    });
    expect(record.submittedBaseVersion).toBe(1);
    expect(record.latestVersion).toBe(2);
    expect(record.submitted.displayName).toBe('花子ちゃん');
    expect(record.differingFields).toEqual(['display_name']);

    const view = await editor.load();
    const rows = buildConflictRows(record, view.draft, {
      stagedAvatar: view.stagedAvatar !== null,
    });
    const nameRow = rows.find((row) => row.field === 'display_name');
    expect(nameRow).toMatchObject({
      submitted: true,
      differs: true,
      mine: '花子ちゃん',
      theirs: '別太郎',
      defaultChoice: 'mine',
    });
    // The introduction the OTHER device published is not part of my
    // submission: it defaults to the published side (never silently kept).
    const introRow = rows.find((row) => row.field === 'introduction');
    expect(introRow).toMatchObject({
      submitted: false,
      differs: true,
      theirs: '別端末から',
      defaultChoice: 'theirs',
    });
    expect(conflictSelectionDefaults(record, view.draft, { stagedAvatar: false })).toEqual({
      display_name: 'mine',
      introduction: 'theirs',
    });

    // Resolve: keep my display name, take their introduction.
    const resolved = await editor.resolveConflict({ display_name: 'mine' });
    if (resolved.status !== 'queued') throw new Error(`expected queued, got ${resolved.status}`);
    // A NEW operation id — the settled 409 id is never reused.
    expect(resolved.operationId).not.toBe(firstOperationId);

    const rowsAfter = await listOperations(storage, ACCOUNT);
    const sent = rowsAfter.find((row) => row.operationId === resolved.operationId);
    expect(sent?.payload).toEqual({
      base_version: 2,
      display_name: '花子ちゃん',
    });

    const pump = await editor.pump();
    expect(pump.publishedChanged).toBe(true);
    expect(server.version).toBe(3);
    expect(server.fields).toEqual({
      displayName: '花子ちゃん',
      introduction: '別端末から', // theirs was taken (never submitted by me)
      avatarPath: null,
    });

    const after = await editor.load();
    expect(after.conflict).toBeNull();
    expect(after.changes.hasChanges).toBe(false);
    expect(await readDraft(storage, ACCOUNT, PROFILE_CONFLICT_KEY)).toBeNull();
    expect(await readDraft(storage, ACCOUNT, PROFILE_DRAFT_KEY)).toBeNull();
  });

  it('re-runs the comparison when the published side moved AGAIN after the screen opened (no overwrite)', async () => {
    const { editor, server, storage } = harness;
    await reachConflict(harness);

    // Another device publishes while the conflict screen is open.
    server.externalPublish({ displayName: '三度目の更新' });
    const sendsBefore = server.sends.length;

    const result = await editor.resolveConflict({ display_name: 'mine' });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') throw new Error('unreachable');
    // Fresh comparison against the NEWEST state — and nothing was written.
    expect(result.conflict.latestVersion).toBe(3);
    expect(result.conflict.latest.displayName).toBe('三度目の更新');
    expect(result.conflict.differingFields).toEqual(['display_name']);
    expect(server.sends).toHaveLength(sendsBefore);
    expect(server.version).toBe(3);
    expect(server.fields.displayName).toBe('三度目の更新');

    // Rows are re-runnable against the fresh record before saving again.
    const view = await editor.load();
    const rows = buildConflictRows(result.conflict, view.draft, { stagedAvatar: false });
    expect(rows.find((row) => row.field === 'display_name')).toMatchObject({
      mine: '花子ちゃん',
      theirs: '三度目の更新',
    });

    // The second attempt uses the newest base and publishes as a NEW operation.
    const second = await editor.resolveConflict({ display_name: 'mine' });
    if (second.status !== 'queued') throw new Error(`expected queued, got ${second.status}`);
    expect(
      (await listOperations(storage, ACCOUNT)).some(
        (row) => row.operationId === second.operationId && row.state === 'pending',
      ),
    ).toBe(true);
    const pump = await editor.pump();
    expect(pump.publishedChanged).toBe(true);
    expect(server.version).toBe(4);
    expect(server.fields.displayName).toBe('花子ちゃん');
  });

  it('does not overwrite when the conflict RECURS at send time: the 409 re-opens the comparison', async () => {
    const { editor, server, deps } = harness;
    const { record } = await reachConflict(harness);
    expect(record.latestVersion).toBe(2);

    // The freshness gate sees the recorded version (e.g. an offline read),
    // but another device publishes before the worker gets on the wire.
    server.externalPublish({ displayName: '送信前の更新' });
    deps.fetchPublication = async () => ({
      displayName: '別太郎',
      introduction: '別端末から',
      avatarPath: null,
      profileVersion: 2,
      userIdText: 'hanako',
    });

    const result = await editor.resolveConflict({ display_name: 'mine' });
    if (result.status !== 'queued') throw new Error(`expected queued, got ${result.status}`);
    deps.fetchPublication = async () => server.fetchPublication();

    const pump = await editor.pump();
    expect(pump.conflicted).toBe(true);
    expect(pump.publishedChanged).toBe(false);
    // The re-conflict re-ran the comparison instead of overwriting anything.
    expect(server.fields.displayName).toBe('送信前の更新');
    expect(server.version).toBe(3);
    const fresh = await editor.load();
    expect(fresh.conflict?.latestVersion).toBe(3);
    expect(fresh.conflict?.latest.displayName).toBe('送信前の更新');
    expect(fresh.conflict?.differingFields).toEqual(['display_name']);
    expect(fresh.conflict?.operationId).not.toBe(record.operationId);
  });
});

// ---------------------------------------------------------------------------
// ログアウト消去 (the logout screen lands in Task 20; this pins the purge
// path auth/logout.ts will call)
// ---------------------------------------------------------------------------

describe('ログアウトのデータ消去', () => {
  it('deleteAccountData wipes draft, staged image, conflict record and queue rows', async () => {
    const { editor, server, storage } = harness;
    await reachConflict(harness); // draft + conflict record + outbox rows exist
    await stageAvatar(storage); // staged image draft

    expect(await readDraft(storage, ACCOUNT, PROFILE_DRAFT_KEY)).not.toBeNull();
    expect(await readDraft(storage, ACCOUNT, PROFILE_CONFLICT_KEY)).not.toBeNull();
    expect(await readAvatarDraft(storage, ACCOUNT)).not.toBeNull();
    expect((await listOperations(storage, ACCOUNT)).length).toBeGreaterThan(0);

    await deleteAccountData(storage, ACCOUNT);

    expect(await readDraft(storage, ACCOUNT, PROFILE_DRAFT_KEY)).toBeNull();
    expect(await readDraft(storage, ACCOUNT, PROFILE_CONFLICT_KEY)).toBeNull();
    expect(await readAvatarDraft(storage, ACCOUNT)).toBeNull();
    expect(await listOperations(storage, ACCOUNT)).toHaveLength(0);

    // A fresh load for the wiped account shows ONLY the published state.
    const view = await editor.load();
    expect(view.draft).toEqual({
      displayName: server.fields.displayName,
      introduction: server.fields.introduction ?? '',
    });
    expect(view.conflict).toBeNull();
    expect(view.sendState).toBeNull();
    expect(view.changes.hasChanges).toBe(false);
    expect(view.stagedAvatar).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 文字数の画面とサーバー一致: the screen runs the client module; the server
// port is imported directly and compared on every shared fixture vector.
// ---------------------------------------------------------------------------

describe('文字数の画面とサーバー一致', () => {
  const serverValidation = jest.requireActual(
    '../../supabase/functions/_shared/profile-validation',
  ) as typeof import('../src/profiles/validation');

  it('counts identical visual characters on both sides for every fixture vector', () => {
    expect(VISUAL_LENGTH_FIXTURE.length).toBeGreaterThan(0);
    for (const vector of VISUAL_LENGTH_FIXTURE) {
      expect(visualLength(vector.text)).toBe(vector.graphemes);
      expect(serverValidation.visualLength(vector.text)).toBe(vector.graphemes);
    }
  });

  it('accepts/rejects every display-name vector identically', () => {
    for (const vector of DISPLAY_NAME_FIXTURE) {
      const client = validateDisplayNameInput(vector.input);
      const server = serverValidation.validateDisplayNameInput(vector.input);
      expect(client.ok).toBe(vector.ok);
      expect(server.ok).toBe(vector.ok);
      const clientError = client.ok ? null : client.error;
      expect(clientError).toEqual(server.ok ? null : server.error);
      if (!vector.ok) expect(clientError).toBe(vector.error);
    }
  });

  it('accepts/rejects every introduction vector identically', () => {
    for (const vector of INTRODUCTION_FIXTURE) {
      const client = validateIntroductionInput(vector.input);
      const server = serverValidation.validateIntroductionInput(vector.input);
      expect(client.ok).toBe(vector.ok);
      expect(server.ok).toBe(vector.ok);
      const clientError = client.ok ? null : client.error;
      expect(clientError).toEqual(server.ok ? null : server.error);
      if (!vector.ok) expect(clientError).toBe(vector.error);
    }
  });

  it('uses the same numeric limits as the server', () => {
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(serverValidation.DISPLAY_NAME_MAX_LENGTH);
    expect(INTRODUCTION_MAX_LENGTH).toBe(serverValidation.INTRODUCTION_MAX_LENGTH);
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(15);
    expect(INTRODUCTION_MAX_LENGTH).toBe(200);
  });

  it('shows exactly the server-shared messages next to the field', () => {
    const errors = validateProfileDraft({
      displayName: FAMILY.repeat(16),
      introduction: 'あ'.repeat(201),
    });
    expect(errors.displayName).toBe(DISPLAY_NAME_TOO_LONG_ERROR);
    expect(errors.introduction).toBe(INTRODUCTION_TOO_LONG_ERROR);
    // Boundary: the screen counts 16 visual characters for 16 family emoji
    // (String.length would say 112).
    expect(visualLength(FAMILY.repeat(16))).toBe(16);
    expect(validateProfileDraft({ displayName: FAMILY.repeat(15), introduction: '' })).toEqual({
      displayName: null,
      introduction: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Part B: the screens through the real router
// ---------------------------------------------------------------------------

async function renderApp(initialUrl: string): Promise<{
  getPathname(): string;
  unmount(): Promise<void>;
}> {
  const router = await renderRouter('./src/app', { initialUrl });
  const app = {
    getPathname: () => router.getPathname(),
    unmount: async () => {
      await router.unmount();
    },
  };
  mountedApps.push(app);
  return app;
}

/** Apps that were never explicitly unmounted (leftover trees poison later renders). */
const mountedApps: Array<{ unmount(): Promise<void> }> = [];

let screenRoot = '';

/** Non-null view of the installed screen server (tests only). */
function server(): FakeProfileServer {
  if (mockServer === null) throw new Error('profile-editor test: server not installed');
  return mockServer;
}

describe('プロフィール編集・競合解決画面 (router)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    screenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-editor-ui-'));
    mockStorage = await openAppDatabase({
      driver: new NodeSqliteDriver(path.join(screenRoot, 'app.db')),
    });
    mockServer = new FakeProfileServer();
    mockUploadProfileImage = jest.fn();
    mockUploadProfileImage.mockImplementation((operationId: string, upload: ProfileImageUpload) =>
      mockServer === null
        ? Promise.reject(new Error('server not installed'))
        : server().acceptUpload(operationId, upload),
    );
  });

  afterEach(async () => {
    // Tear down every rendered tree BEFORE the storage closes: a leftover
    // mounted editor would keep querying a closed database and poison the
    // next render.
    while (mountedApps.length > 0) {
      const app = mountedApps.pop();
      try {
        await app?.unmount();
      } catch {
        // Already unmounted by the test itself.
      }
    }
    const storage = mockStorage;
    mockStorage = null;
    mockServer = null;
    if (storage !== null) {
      try {
        await storage.close();
      } catch {
        // Already closed by an unmount.
      }
    }
    fs.rmSync(screenRoot, { recursive: true, force: true });
    screenRoot = '';
  });

  it('shows a read-only User ID, live near-field errors and the shared counters', async () => {
    const app = await renderApp('/mypage/edit');
    await waitFor(() => expect(screen.getByTestId('edit-display-name')).toBeTruthy());

    // 編集不可 User ID.
    const userIdField = screen.getByTestId('edit-user-id');
    expect(userIdField.props.editable).toBe(false);
    expect(userIdField.props.value).toBe('hanako');

    // 公開中 vs 変更予定 are two distinct blocks.
    expect(screen.getByTestId('edit-published-name').props.children).toBe('表示名: 花子');
    await fireEvent.changeText(screen.getByTestId('edit-display-name'), '花子ちゃん');
    expect(screen.getByTestId('edit-published-name').props.children).toBe('表示名: 花子');
    expect(screen.getByTestId('edit-pending-name').props.children).toBe('表示名: 花子ちゃん');
    expect(screen.getByTestId('edit-send-state').props.children).toBe(
      '送信状況: まだ送信していません（保存で送信待ちになります）',
    );

    // The counter counts visual characters exactly like the server:
    // 15 family emoji = 15 (String.length would say 105).
    await fireEvent.changeText(screen.getByTestId('edit-display-name'), FAMILY.repeat(15));
    await waitFor(() => expect(screen.getByText('15 / 15')).toBeTruthy());
    expect(screen.queryByText(/Display name must be 15 visual characters/)).toBeNull();

    await fireEvent.changeText(screen.getByTestId('edit-display-name'), FAMILY.repeat(16));
    await waitFor(() =>
      expect(screen.getByText(/Display name must be 15 visual characters or fewer/)).toBeTruthy(),
    );

    // 保存前の検証エラーで送信は一切起きない.
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(screen.getByTestId('edit-invalid')).toBeTruthy());
    expect(server().sends).toHaveLength(0);
    expect(await listOperations(mockStorage!, ACCOUNT)).toHaveLength(0);
    expect(app.getPathname()).toBe('/mypage/edit');
  });

  it('keeps the in-progress draft across unmount/navigation and restores it', async () => {
    const first = await renderApp('/mypage/edit');
    await waitFor(() => expect(screen.getByTestId('edit-display-name')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('edit-display-name'), '書きかけの名前');
    await fireEvent.changeText(screen.getByTestId('edit-introduction'), '書きかけの自己紹介');

    // 下書きはアカウント別SQLiteに保存される. NOTE: a microtask loop, not
    // waitFor(async …) — an async assertion inside fake-timer waitFor leaves
    // a pending timer-advance cycle that poisons the NEXT renderRouter call.
    let draft: { body: { displayName: string; introduction: string } } | null = null;
    for (let i = 0; i < 100 && draft === null; i += 1) {
      draft = await readDraft<{ displayName: string; introduction: string }>(
        mockStorage!,
        ACCOUNT,
        PROFILE_DRAFT_KEY,
      );
      if (draft === null) await Promise.resolve();
    }
    expect(draft?.body.displayName).toBe('書きかけの名前');
    expect(draft?.body.introduction).toBe('書きかけの自己紹介');
    await first.unmount();

    // A fresh mount (relaunch / external-link return) restores the input.
    await renderApp('/mypage/edit');
    await waitFor(() =>
      expect(screen.getByTestId('edit-display-name').props.value).toBe('書きかけの名前'),
    );
    expect(screen.getByTestId('edit-introduction').props.value).toBe('書きかけの自己紹介');
    expect(screen.getByTestId('edit-pending-name').props.children).toBe(
      '表示名: 書きかけの名前',
    );
    // Nothing was sent by typing alone.
    expect(server().sends).toHaveLength(0);
  });

  it('publishes a save through the queue and clears the pending block', async () => {
    const app = await renderApp('/mypage/edit');
    await waitFor(() => expect(screen.getByTestId('edit-display-name')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('edit-display-name'), '新しい花子');
    await fireEvent.press(screen.getByTestId('edit-save'));

    await waitFor(() => expect(screen.getByTestId('edit-published-ok')).toBeTruthy());
    expect(server().sends).toHaveLength(1);
    expect(screen.getByTestId('edit-published-name').props.children).toBe('表示名: 新しい花子');
    expect(screen.getByTestId('edit-no-changes')).toBeTruthy();
    expect(screen.queryByTestId('edit-pending-name')).toBeNull();
    expect(app.getPathname()).toBe('/mypage/edit');
  });

  it('an image upload failure keeps published content unchanged while the owner sees pending + send state', async () => {
    // Stage an image the way AvatarPicker does (draft row + committed file)
    // BEFORE the screen loads, so the save pipeline sees it as pending.
    const reference = await stageAvatar(mockStorage!);
    const store = createImageStore({ fs: expoFileSystemPort });
    const file = new File(store.resolvePath(reference));
    if (!file.exists) file.create({ intermediates: true });
    file.writeSync(new Uint8Array([1, 2, 3, 4]));

    await renderApp('/mypage/edit');
    await waitFor(() => expect(screen.getByTestId('edit-display-name')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('edit-display-name'), '画像つき');
    // The upload itself fails (network, bucket, …).
    mockUploadProfileImage.mockImplementation(async () => {
      throw new Error('upload failed');
    });
    await fireEvent.press(screen.getByTestId('edit-save'));

    await waitFor(() => expect(screen.getByTestId('edit-image-failed')).toBeTruthy());
    // 画像失敗時に文字だけ先に公開しない: no command was ever sent.
    expect(server().sends).toHaveLength(0);
    expect(mockUploadProfileImage).toHaveBeenCalledTimes(1);
    expect(server().fields).toEqual({
      displayName: '花子',
      introduction: null,
      avatarPath: null,
    });
    expect(server().version).toBe(1);

    // 本人には変更予定内容と送信状態.
    expect(screen.getByTestId('edit-published-name').props.children).toBe('表示名: 花子');
    expect(screen.getByTestId('edit-pending-name').props.children).toBe('表示名: 画像つき');
    expect(screen.getByTestId('edit-pending-avatar').props.children).toBe(
      '画像: 選択した画像（未公開）',
    );
    expect(screen.getByTestId('edit-send-state').props.children).toBe('送信状況: 送信待ち');
    expect(await readDraft(mockStorage!, ACCOUNT, PROFILE_DRAFT_KEY)).not.toBeNull();
    expect(await readAvatarDraft(mockStorage!, ACCOUNT)).not.toBeNull();
  });

  it('routes a 別端末 conflict to the conflict screen, compares field by field, saves as a NEW operation', async () => {
    const app = await renderApp('/mypage/edit');
    await waitFor(() => expect(screen.getByTestId('edit-display-name')).toBeTruthy());

    // Another device publishes while we type.
    server().externalPublish({ displayName: '別太郎', introduction: '別端末から' });
    await fireEvent.changeText(screen.getByTestId('edit-display-name'), '花子ちゃん');
    await fireEvent.press(screen.getByTestId('edit-save'));

    await waitFor(() => expect(app.getPathname()).toBe('/mypage/conflict'));
    await waitFor(() => expect(screen.getByTestId('conflict-row-display_name')).toBeTruthy());

    // 項目別比較: both sides per field.
    expect(screen.getByTestId('conflict-mine-display_name').props.children).toBe(
      '変更予定: 花子ちゃん',
    );
    expect(screen.getByTestId('conflict-theirs-display_name').props.children).toBe(
      '公開内容: 別太郎',
    );
    expect(screen.getByTestId('conflict-theirs-introduction').props.children).toBe(
      '公開内容: 別端末から',
    );
    // Defaults: keep my submitted change; take the other device's change
    // for the field I never submitted (no silent overwrite either way).
    expect(
      screen.getByTestId('conflict-display_name-mine').props.accessibilityState.selected,
    ).toBe(true);
    expect(
      screen.getByTestId('conflict-introduction-theirs').props.accessibilityState.selected,
    ).toBe(true);

    await fireEvent.press(screen.getByTestId('conflict-save'));
    await waitFor(() => expect(screen.getByTestId('conflict-done')).toBeTruthy());

    // Two sends: the original 409 attempt and the resolution — a NEW id.
    expect(server().sends).toHaveLength(2);
    expect(server().sends[1].operationId).not.toBe(server().sends[0].operationId);
    expect(server().sends[1].payload).toEqual({
      base_version: 2,
      display_name: '花子ちゃん',
    });
    expect(server().fields).toEqual({
      displayName: '花子ちゃん',
      introduction: '別端末から',
      avatarPath: null,
    });
    expect(server().version).toBe(3);

    await fireEvent.press(screen.getByTestId('conflict-back'));
    await waitFor(() => expect(app.getPathname()).toBe('/mypage/edit'));
    await waitFor(() =>
      expect(screen.getByTestId('edit-published-name').props.children).toBe(
        '表示名: 花子ちゃん',
      ),
    );
    expect(screen.getByTestId('edit-published-introduction').props.children).toBe(
      '自己紹介: 別端末から',
    );
    // Resolved: no conflict entry point remains on the edit screen.
    expect(screen.queryByTestId('edit-open-conflict')).toBeNull();
  });
});
