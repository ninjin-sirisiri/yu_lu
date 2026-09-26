import type { SupabaseClient } from '@supabase/supabase-js';
import { File } from 'expo-file-system';

import {
  getOwnPublication,
  profileImagePath,
  uploadProfileImage,
  type ProfileImageUpload,
  type ProfilePublication,
  type ProfilePublicationFields,
} from '../backend/profile';
import { randomId, type Storage } from '../storage/database';
import { deleteDraft, readDraft, saveDraft } from '../storage/drafts';
import { createImageStore, expoFileSystemPort, type ImageReference, type ImageStore } from '../storage/files';
import { discardAvatarDraft, readAvatarDraft, saveAvatarDraft } from '../media/avatar';
import { getOperation, listOperations } from '../storage/outbox';
import { createCommandApi, type CommandApi, type CommandEnvelope, type CommandOutcome } from '../sync/api';
import { createSyncQueue, type SyncQueue } from '../sync/queue';
import { createSyncWorker } from '../sync/worker';
import { assertEditableProfileField } from './edit';
import {
  computeDifferingFields,
  isProfileConflictRecord,
  mergeConflictSelection,
  parseConflictBody,
  rebaseConflictRecord,
  type ConflictMerge,
  type ConflictSelection,
  type ProfileConflictRecord,
} from './conflict';
import { validateDisplayNameInput, validateIntroductionInput } from './validation';

// Task 17: the headless profile-editing controller.
//
// Ownership: the account-scoped edit DRAFT (what the user is typing — kept
// across back / tab / external-link navigation and across saves), the
// save pipeline (validate → 画像アップロード → version check → 全体公開,
// where saving only ENQUEUES and the queue worker publishes), and conflict
// detection (the structured 409 body becomes a persisted
// `ProfileConflictRecord` the conflict screen compares field by field).
//
// Everything the controller touches is injected (draft storage, queue,
// network port, publication read, image upload) so tests drive the exact
// pipeline the device runs — `createDeviceProfileEditor` is only the
// default wiring of the same controller.
//
// Invariants:
// - Draft ≠ send reservation: `save()` never publishes directly, and
//   cancelling the queued reservation (`cancelPendingSends`) never touches
//   the draft (取消後下書き).
// - One command, all fields: when a staged image exists the save carries
//   `avatar_staged`, and the send layer uploads it BEFORE invoking the
//   command — a failed upload answers transient WITHOUT sending anything,
//   so text can never publish first (画像失敗時に文字だけ先に公開しない).
//   The owner keeps seeing the pending content and the send state.
// - Multiple saves coalesce through the queue into the latest content
//   (Task 9), with the 24h deadline restarting from the last save.
// - A conflict is captured as a record (submitted vs latest, per field)
//   and resolved by ENQUEUING a NEW operation on the latest base_version;
//   a conflict that recurs while the conflict screen is open re-runs the
//   comparison (rebase) instead of overwriting anything.

/** Draft key holding the in-progress text edit (account-scoped). */
export const PROFILE_DRAFT_KEY = 'profile.edit';
/** Draft key holding the last captured conflict record. */
export const PROFILE_CONFLICT_KEY = 'profile.conflict';
/** Payload key carrying the staged local image until it is uploaded. */
export const AVATAR_STAGED_KEY = 'avatar_staged';

/** Staged image descriptor stored inside the queued payload. */
export interface StagedAvatarDescriptor {
  upload_id: string;
  relative_path: string;
  image_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
}

/** The in-progress edit (what the user is typing). */
export interface ProfileDraftBody {
  displayName: string;
  introduction: string;
  /** Pending "published image removal" intent (staged images take precedence). */
  clearAvatar?: boolean;
}

export interface ProfileFieldErrors {
  displayName: string | null;
  introduction: string | null;
}

/** What a save would send: fields that differ from the published state. */
export interface ProfileChanges {
  displayName?: string;
  introduction?: string;
  avatar:
    | { kind: 'staged'; reference: ImageReference }
    | { kind: 'clear' }
    | { kind: 'none' };
  hasChanges: boolean;
}

export interface ProfileSendState {
  operationId: string;
  state: string;
}

export interface ProfileEditorView {
  /** Read-only User ID (immutable after confirmation). */
  userIdText: string | null;
  published: ProfilePublication;
  draft: ProfileDraftBody;
  errors: ProfileFieldErrors;
  changes: ProfileChanges;
  stagedAvatar: ImageReference | null;
  conflict: ProfileConflictRecord | null;
  /** Newest unfinished update_profile queue row, if any. */
  sendState: ProfileSendState | null;
}

export type ProfileSaveResult =
  | { status: 'invalid'; errors: ProfileFieldErrors }
  | { status: 'unchanged' }
  | { status: 'queued'; operationId: string; coalesced: boolean };

export interface ProfilePumpResult {
  /** The persisted record when this pump observed a conflict. */
  conflict: ProfileConflictRecord | null;
  conflicted: boolean;
  publishedChanged: boolean;
  /** The staged image could not be read/uploaded — nothing was sent. */
  imageUploadFailed: boolean;
  error: string | null;
}

export type ProfileResolveResult =
  | { status: 'queued'; operationId: string; coalesced: boolean }
  | { status: 'adopted' }
  | { status: 'conflict'; conflict: ProfileConflictRecord }
  | { status: 'invalid'; errors: ProfileFieldErrors };

export interface ProfileEditor {
  /** Fetch the publication and the local state; builds the view. */
  load(): Promise<ProfileEditorView>;
  /** Re-read draft / staged image / conflict / send state (no network). */
  refreshLocal(): Promise<ProfileEditorView>;
  setDisplayName(value: string): Promise<ProfileEditorView>;
  setIntroduction(value: string): Promise<ProfileEditorView>;
  setClearAvatar(value: boolean): Promise<ProfileEditorView>;
  /** Validate → enqueue (never publishes directly). */
  save(): Promise<ProfileSaveResult>;
  /** Foreground queue pump; observes conflicts and publications. */
  pump(): Promise<ProfilePumpResult>;
  /** Per-field resolution → NEW operation on the latest base_version. */
  resolveConflict(selection: ConflictSelection): Promise<ProfileResolveResult>;
  /** Cancel unsent reservations; the draft is never touched. */
  cancelPendingSends(): Promise<number>;
  /** Current view; throws before the first `load()`. */
  view(): ProfileEditorView;
}

export interface ProfileEditorDeps {
  accountId: string;
  storage: Storage;
  queue: SyncQueue;
  api: CommandApi;
  fetchPublication(): Promise<ProfilePublication>;
  uploadImage(operationId: string, upload: ProfileImageUpload): Promise<string>;
  resolvePath(reference: ImageReference): string;
  readFile(uri: string): Promise<Uint8Array>;
  imageStore?: ImageStore;
  newOperationId?: () => string;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for the screens and the tests)
// ---------------------------------------------------------------------------

/** Per-field validation with the SHARED rules (byte-identical to the server). */
export function validateProfileDraft(draft: ProfileDraftBody): ProfileFieldErrors {
  const name = validateDisplayNameInput(draft.displayName);
  const intro = validateIntroductionInput(draft.introduction);
  return {
    displayName: name.ok ? null : name.error,
    introduction: intro.ok ? null : intro.error,
  };
}

/**
 * What a save would send: every field (text or avatar) whose draft state
 * differs from the published one. Invalid text is still reported as a
 * pending change so the owner sees exactly what they typed — `save()`
 * refuses it separately, with the error next to the field.
 */
export function computeProfileChanges(
  publication: ProfilePublication,
  draft: ProfileDraftBody,
  stagedAvatar: ImageReference | null,
): ProfileChanges {
  const name = validateDisplayNameInput(draft.displayName);
  const intro = validateIntroductionInput(draft.introduction);
  const displayName =
    !name.ok || name.value !== publication.displayName ? draft.displayName : undefined;
  const introduction =
    !intro.ok || (intro.value ?? null) !== (publication.introduction ?? null)
      ? draft.introduction
      : undefined;
  const avatar: ProfileChanges['avatar'] =
    stagedAvatar !== null
      ? { kind: 'staged', reference: stagedAvatar }
      : draft.clearAvatar === true && publication.avatarPath !== null
        ? { kind: 'clear' }
        : { kind: 'none' };
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(introduction === undefined ? {} : { introduction }),
    avatar,
    hasChanges:
      displayName !== undefined || introduction !== undefined || avatar.kind !== 'none',
  };
}

function draftFromPublication(publication: ProfilePublication): ProfileDraftBody {
  return {
    displayName: publication.displayName,
    introduction: publication.introduction ?? '',
  };
}

function asDraftBody(value: unknown): ProfileDraftBody | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['displayName'] !== 'string') return null;
  if (typeof record['introduction'] !== 'string') return null;
  const clearAvatar = record['clearAvatar'];
  if (clearAvatar !== undefined && typeof clearAvatar !== 'boolean') return null;
  return {
    displayName: record['displayName'],
    introduction: record['introduction'],
    ...(clearAvatar === undefined ? {} : { clearAvatar }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parses the `avatar_staged` descriptor; null = unreadable. */
export function parseStagedAvatarDescriptor(value: unknown): StagedAvatarDescriptor | null {
  const record = asRecord(value);
  if (record === null) return null;
  const uploadId = record['upload_id'];
  const relativePath = record['relative_path'];
  const imageId = record['image_id'];
  const fileName = record['file_name'];
  const contentType = record['content_type'];
  const sizeBytes = record['size_bytes'];
  if (
    typeof uploadId !== 'string' || uploadId === '' ||
    typeof relativePath !== 'string' || relativePath === '' ||
    typeof imageId !== 'string' || imageId === '' ||
    typeof fileName !== 'string' || fileName === '' || fileName.includes('/') ||
    typeof contentType !== 'string' || contentType === '' ||
    typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0
  ) {
    return null;
  }
  return {
    upload_id: uploadId,
    relative_path: relativePath,
    image_id: imageId,
    file_name: fileName,
    content_type: contentType,
    size_bytes: sizeBytes,
  };
}

function baseName(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(lastSlash + 1);
}

/** Submitted fields of a queued payload (only the keys that are present). */
export function submittedFromPayload(
  payload: Record<string, unknown>,
): { displayName?: string; introduction?: string; avatarPath?: string | null } {
  const submitted: { displayName?: string; introduction?: string; avatarPath?: string | null } =
    {};
  for (const key of Object.keys(payload)) {
    if (key === 'base_version' || key === AVATAR_STAGED_KEY) continue;
    assertEditableProfileField(key);
  }
  if (typeof payload['display_name'] === 'string') submitted.displayName = payload['display_name'];
  if (typeof payload['introduction'] === 'string') submitted.introduction = payload['introduction'];
  const avatarPath = payload['avatar_path'];
  if (avatarPath === null || typeof avatarPath === 'string') submitted.avatarPath = avatarPath;
  return submitted;
}

function fieldsOf(publication: ProfilePublication): ProfilePublicationFields {
  return {
    displayName: publication.displayName,
    introduction: publication.introduction,
    avatarPath: publication.avatarPath,
  };
}

// ---------------------------------------------------------------------------
// The send pipeline: image upload → command, conflict capture
// ---------------------------------------------------------------------------

export interface ProfileSendApi extends CommandApi {
  /**
   * True when the LAST attempt for this operation id failed BEFORE the
   * command ran (the staged image could not be read or uploaded).
   */
  wasImageFailure(operationId: string): boolean;
}

export interface ProfileSendApiDeps {
  storage: Storage;
  resolvePath(reference: ImageReference): string;
  readFile(uri: string): Promise<Uint8Array>;
  uploadImage(operationId: string, upload: ProfileImageUpload): Promise<string>;
  now?: () => number;
}

/**
 * Persists a conflict record the moment the network answers 409, so ANY
 * pump through this api (foreground editor, 送信状況 screen, Task 20
 * background worker) leaves the conflict screen something to compare —
 * even if the app dies before the queue row settles.
 */
async function persistConflictRecord(
  deps: ProfileSendApiDeps,
  envelope: CommandEnvelope,
  conflictBody: unknown,
  now: () => number,
): Promise<void> {
  const parsed = parseConflictBody(conflictBody);
  if (parsed === null) return;
  const submitted = submittedFromPayload(envelope.payload);
  const baseVersion =
    typeof envelope.payload['base_version'] === 'number'
      ? envelope.payload['base_version']
      : 0;
  // The stored row still carries the ORIGINAL payload (the upload rewrite
  // is in-memory only), which is where the staged image link lives.
  let stagedRelativePath: string | undefined;
  try {
    const row = await getOperation(deps.storage, envelope.accountId, envelope.operationId);
    const staged = parseStagedAvatarDescriptor(
      asRecord(row?.payload)?.[AVATAR_STAGED_KEY],
    );
    if (staged !== null) stagedRelativePath = staged.relative_path;
  } catch {
    // A missing row only costs the staged-image link; the comparison itself
    // comes from the envelope and the 409 body.
  }
  const differing =
    parsed.differingFields.length > 0
      ? parsed.differingFields
      : computeDifferingFields(submitted, parsed.profile);
  const record: ProfileConflictRecord = {
    operationId: envelope.operationId,
    submittedBaseVersion: baseVersion,
    submitted,
    latestVersion: parsed.version,
    latest: parsed.profile,
    differingFields: differing,
    message: parsed.message,
    ...(stagedRelativePath === undefined ? {} : { stagedRelativePath }),
    createdAt: now(),
  };
  try {
    await saveDraft(deps.storage, envelope.accountId, PROFILE_CONFLICT_KEY, record);
  } catch {
    // Without storage the in-memory flow still works for this session.
  }
}

/**
 * The device/test send pipeline for `update_profile`:
 *
 * 1. a staged image (`avatar_staged` in the queued payload) is read and
 *    uploaded into `<actor>/<upload id>/<file>` BEFORE the command runs —
 *    any failure answers transient WITHOUT invoking the command, so a
 *    broken image can never split into "text published, image lost";
 * 2. the rewritten payload (`avatar_path`) goes to the wrapped port;
 * 3. a 409 conflict body is captured and persisted as the record the
 *    conflict screen compares.
 *
 * Exported so every pump (edit screen, 送信状況, Task 20 background) uses
 * the same pipeline instead of the raw command port.
 */
export function createProfileSendApi(base: CommandApi, deps: ProfileSendApiDeps): ProfileSendApi {
  const now = deps.now ?? (() => Date.now());
  // Per-operation flag: did the LAST attempt die BEFORE the command ran?
  // Any outcome recorded by the wrapped port resets it to false.
  const imageFailures = new Map<string, boolean>();

  const capturing: CommandApi = {
    async send(envelope: CommandEnvelope): Promise<CommandOutcome> {
      try {
        const outcome = await base.send(envelope);
        imageFailures.set(envelope.operationId, false);
        if (outcome.status === 'conflict') {
          await persistConflictRecord(deps, envelope, outcome.conflict, now);
        }
        return outcome;
      } catch (error) {
        // Transport failure at the port (AFTER the upload): same id retry
        // is safe — this is not an image failure.
        imageFailures.set(envelope.operationId, false);
        throw error;
      }
    },
  };

  return {
    async send(envelope: CommandEnvelope): Promise<CommandOutcome> {
      if (envelope.kind !== 'update_profile') return capturing.send(envelope);
      const stagedValue = envelope.payload[AVATAR_STAGED_KEY];
      if (stagedValue === undefined || stagedValue === null) {
        return capturing.send(envelope);
      }
      const staged = parseStagedAvatarDescriptor(stagedValue);
      if (staged === null) {
        imageFailures.set(envelope.operationId, true);
        return {
          status: 'transient',
          message: 'staged avatar descriptor is unreadable',
        };
      }

      // 画像失敗時に文字だけ先に公開しない: the image is read and uploaded
      // FIRST, and any failure answers transient WITHOUT invoking the
      // command — the row stays 送信待ち and retries (接続復帰で再試行);
      // the 24h deadline (never extended by these retries) explains a
      // permanent inability instead of pretending the server rejected it.
      let path: string;
      try {
        const reference: ImageReference = {
          accountId: envelope.accountId,
          imageId: staged.image_id,
          relativePath: staged.relative_path,
          bytes: staged.size_bytes,
        };
        const bytes = await deps.readFile(deps.resolvePath(reference));
        path = await deps.uploadImage(staged.upload_id, {
          fileName: staged.file_name,
          contentType: staged.content_type,
          data: bytes,
          sizeBytes: staged.size_bytes,
        });
      } catch (error) {
        imageFailures.set(envelope.operationId, true);
        return {
          status: 'transient',
          message: error instanceof Error ? error.message : String(error),
        };
      }

      const payload = { ...envelope.payload };
      delete payload[AVATAR_STAGED_KEY];
      payload['avatar_path'] = path;
      return capturing.send({ ...envelope, payload });
    },
    wasImageFailure(operationId: string): boolean {
      return imageFailures.get(operationId) === true;
    },
  };
}

/** Device wiring of {@link createProfileSendApi} (used by 送信状況 too). */
export function createDeviceProfileSendApi(base: CommandApi, storage: Storage): ProfileSendApi {
  const store = createImageStore({ fs: expoFileSystemPort });
  return createProfileSendApi(base, {
    storage,
    resolvePath: (reference) => store.resolvePath(reference),
    readFile: async (uri: string) => new File(uri).bytes(),
    uploadImage: (operationId, upload) => uploadProfileImage(operationId, upload),
  });
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

const UNFINISHED_STATES: readonly string[] = [
  'pending',
  'sending',
  'sent_unknown',
  'failed_permanent',
  'needs_confirmation',
];

export function createProfileEditor(deps: ProfileEditorDeps): ProfileEditor {
  const newOperationId = deps.newOperationId ?? randomId;
  const now = deps.now ?? (() => Date.now());
  const sendApi = createProfileSendApi(deps.api, {
    storage: deps.storage,
    resolvePath: deps.resolvePath,
    readFile: deps.readFile,
    uploadImage: deps.uploadImage,
    now,
  });

  let published: ProfilePublication | null = null;
  let draft: ProfileDraftBody | null = null;
  let stagedAvatar: ImageReference | null = null;
  let conflict: ProfileConflictRecord | null = null;
  let sendState: ProfileSendState | null = null;
  let loaded = false;

  function requireState(): { publication: ProfilePublication; body: ProfileDraftBody } {
    if (!loaded || published === null || draft === null) {
      throw new Error('profile editor is not loaded yet');
    }
    return { publication: published, body: draft };
  }

  function buildView(): ProfileEditorView {
    const { publication, body } = requireState();
    return {
      userIdText: publication.userIdText,
      published: publication,
      draft: body,
      errors: validateProfileDraft(body),
      changes: computeProfileChanges(publication, body, stagedAvatar),
      stagedAvatar,
      conflict,
      sendState,
    };
  }

  async function persistDraft(): Promise<void> {
    const body = requireState().body;
    try {
      await saveDraft(deps.storage, deps.accountId, PROFILE_DRAFT_KEY, body);
    } catch {
      // Memory stays authoritative for this session (register-screen rule).
    }
  }

  async function storeConflict(record: ProfileConflictRecord): Promise<void> {
    await saveDraft(deps.storage, deps.accountId, PROFILE_CONFLICT_KEY, record);
  }

  async function clearConflictRecord(): Promise<void> {
    await deleteDraft(deps.storage, deps.accountId, PROFILE_CONFLICT_KEY).catch(() => undefined);
    conflict = null;
  }

  async function readConflictRecord(): Promise<ProfileConflictRecord | null> {
    const record = await readDraft<unknown>(deps.storage, deps.accountId, PROFILE_CONFLICT_KEY);
    if (record === null) return null;
    return isProfileConflictRecord(record.body) ? record.body : null;
  }

  async function readSendState(): Promise<ProfileSendState | null> {
    const rows = await listOperations(deps.storage, deps.accountId);
    // Newest unfinished update_profile row (rows are oldest-first).
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row.kind === 'update_profile' && UNFINISHED_STATES.includes(row.state)) {
        return { operationId: row.operationId, state: row.state };
      }
    }
    return null;
  }

  async function discardStagedImage(): Promise<void> {
    try {
      if (deps.imageStore !== undefined) {
        await discardAvatarDraft(deps.storage, deps.accountId, deps.imageStore);
      } else {
        await saveAvatarDraft(deps.storage, deps.accountId, null);
      }
    } catch {
      // An orphan file is tolerable; a phantom pending image is not.
    }
    stagedAvatar = null;
  }

  /**
   * Reconcile after a successful publication: drop the staged image whose
   * bytes just became the published one, clear the draft when nothing is
   * pending any more, and re-run a stored conflict comparison against the
   * fresh published state (it may have been resolved by this very send).
   */
  async function reconcileAfterPublish(
    succeededPayload: Record<string, unknown> | null,
  ): Promise<void> {
    let fresh: ProfilePublication | null = null;
    try {
      fresh = await deps.fetchPublication();
    } catch {
      // Offline right after a success: the next load refreshes it.
    }
    if (fresh === null) return;
    published = fresh;

    const staged = stagedAvatar ?? (await readAvatarDraft(deps.storage, deps.accountId));
    if (staged !== null && succeededPayload !== null) {
      let publishedThisStaged = false;
      const descriptor = parseStagedAvatarDescriptor(succeededPayload[AVATAR_STAGED_KEY]);
      if (descriptor !== null && descriptor.relative_path === staged.relativePath) {
        // The upload path is derived from exactly these descriptor values.
        try {
          publishedThisStaged =
            fresh.avatarPath ===
            profileImagePath(deps.accountId, descriptor.upload_id, descriptor.file_name);
        } catch {
          publishedThisStaged = false;
        }
      } else if (
        conflict !== null &&
        conflict.stagedRelativePath === staged.relativePath &&
        conflict.submitted.avatarPath !== undefined &&
        conflict.submitted.avatarPath === fresh.avatarPath
      ) {
        // A conflict resolution re-published the already-uploaded path.
        publishedThisStaged = true;
      }
      if (publishedThisStaged) {
        stagedAvatar = staged;
        await discardStagedImage();
      }
    }

    const body = draft ?? draftFromPublication(fresh);
    const errors = validateProfileDraft(body);
    const introCheck = validateIntroductionInput(body.introduction);
    const textMatches =
      errors.displayName === null &&
      errors.introduction === null &&
      body.displayName.trim() === fresh.displayName &&
      (introCheck.ok ? introCheck.value ?? null : null) === (fresh.introduction ?? null);
    const avatarSatisfied =
      stagedAvatar === null &&
      !(body.clearAvatar === true && fresh.avatarPath !== null);
    if (textMatches && avatarSatisfied) {
      // Nothing is pending: the draft (and any conflict) has served its day.
      draft = draftFromPublication(fresh);
      await deleteDraft(deps.storage, deps.accountId, PROFILE_DRAFT_KEY).catch(() => undefined);
      await clearConflictRecord();
      return;
    }

    if (conflict !== null && fresh.profileVersion > conflict.latestVersion) {
      const rebased = rebaseConflictRecord(conflict, fieldsOf(fresh), fresh.profileVersion);
      conflict = rebased;
      await storeConflict(rebased).catch(() => undefined);
    }
  }

  async function stagedDescriptor(
    reference: ImageReference,
  ): Promise<StagedAvatarDescriptor> {
    // Reuse the upload folder of an earlier still-unsent save of the SAME
    // staged image so repeated saves never litter new object folders.
    let uploadId: string | undefined;
    try {
      const rows = await listOperations(deps.storage, deps.accountId);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row.kind !== 'update_profile') continue;
        if (!['pending', 'needs_confirmation'].includes(row.state)) continue;
        const staged = parseStagedAvatarDescriptor(asRecord(row.payload)?.[AVATAR_STAGED_KEY]);
        if (staged !== null && staged.relative_path === reference.relativePath) {
          uploadId = staged.upload_id;
          break;
        }
      }
    } catch {
      // Fall through to a fresh id.
    }
    const fileName = baseName(reference.relativePath);
    return {
      upload_id: uploadId ?? newOperationId(),
      relative_path: reference.relativePath,
      image_id: reference.imageId,
      file_name: fileName === '' ? `${reference.imageId}.jpg` : fileName,
      content_type: 'image/jpeg',
      size_bytes: reference.bytes,
    };
  }

  async function load(): Promise<ProfileEditorView> {
    const fresh = await deps.fetchPublication();
    published = fresh;
    const record = await readDraft<unknown>(deps.storage, deps.accountId, PROFILE_DRAFT_KEY);
    draft = asDraftBody(record?.body) ?? draftFromPublication(fresh);
    stagedAvatar = await readAvatarDraft(deps.storage, deps.accountId);
    conflict = await readConflictRecord();
    sendState = await readSendState();
    loaded = true;

    // Another device may have published while the screen was away: re-run
    // the stored comparison against the fresh state instead of keeping a
    // stale one (競合画面を開いた後の再競合も上書きしない).
    if (conflict !== null && fresh.profileVersion > conflict.latestVersion) {
      const rebased = rebaseConflictRecord(conflict, fieldsOf(fresh), fresh.profileVersion);
      conflict = rebased;
      await storeConflict(rebased).catch(() => undefined);
    }

    return buildView();
  }

  async function refreshLocal(): Promise<ProfileEditorView> {
    requireState();
    const record = await readDraft<unknown>(deps.storage, deps.accountId, PROFILE_DRAFT_KEY);
    draft = asDraftBody(record?.body) ?? draft;
    stagedAvatar = await readAvatarDraft(deps.storage, deps.accountId);
    conflict = await readConflictRecord();
    sendState = await readSendState();
    return buildView();
  }

  async function setField(update: (body: ProfileDraftBody) => void): Promise<ProfileEditorView> {
    const { body } = requireState();
    update(body);
    await persistDraft();
    return buildView();
  }

  async function save(): Promise<ProfileSaveResult> {
    if (!loaded) await load();
    const { publication, body } = requireState();
    const errors = validateProfileDraft(body);
    if (errors.displayName !== null || errors.introduction !== null) {
      return { status: 'invalid', errors };
    }
    const changes = computeProfileChanges(publication, body, stagedAvatar);
    if (!changes.hasChanges) return { status: 'unchanged' };

    const payload: Record<string, unknown> = {
      base_version: publication.profileVersion,
    };
    if (changes.displayName !== undefined) {
      const name = validateDisplayNameInput(changes.displayName);
      if (!name.ok) return { status: 'invalid', errors: validateProfileDraft(body) };
      payload['display_name'] = name.value;
    }
    if (changes.introduction !== undefined) {
      const intro = validateIntroductionInput(changes.introduction);
      if (!intro.ok) return { status: 'invalid', errors: validateProfileDraft(body) };
      payload['introduction'] = intro.value ?? '';
    }
    if (changes.avatar.kind === 'clear') payload['avatar_path'] = null;
    if (changes.avatar.kind === 'staged') {
      payload[AVATAR_STAGED_KEY] = await stagedDescriptor(changes.avatar.reference);
    }
    // Only editable fields (+ base_version + the staged descriptor) can
    // ever leave the device; User ID and friends are structurally refused.
    submittedFromPayload(payload);

    const { operation, coalesced } = await deps.queue.enqueue({
      accountId: deps.accountId,
      kind: 'update_profile',
      payload,
      baseVersion: publication.profileVersion,
    });
    sendState = { operationId: operation.operationId, state: operation.state };
    return { status: 'queued', operationId: operation.operationId, coalesced };
  }

  async function pump(): Promise<ProfilePumpResult> {
    requireState();
    const worker = createSyncWorker({
      queue: deps.queue,
      api: sendApi,
      accountId: deps.accountId,
    });
    let steps;
    try {
      steps = await worker.runUntilIdle();
    } catch (error) {
      return {
        conflict: null,
        conflicted: false,
        publishedChanged: false,
        imageUploadFailed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    let publishedChanged = false;
    let imageUploadFailed = false;
    let conflicted = false;
    const succeededPayloads: Array<Record<string, unknown>> = [];
    for (const step of steps) {
      if (step.outcome === 'conflict') {
        conflicted = true;
      } else if (step.outcome === 'ok') {
        publishedChanged = true;
        try {
          const row = await getOperation(deps.storage, deps.accountId, step.operationId);
          const payload = asRecord(row?.payload);
          if (payload !== null) succeededPayloads.push(payload);
        } catch {
          succeededPayloads.push({});
        }
      } else if (step.outcome === 'transient' && sendApi.wasImageFailure(step.operationId)) {
        imageUploadFailed = true;
      }
    }

    for (const payload of succeededPayloads) {
      await reconcileAfterPublish(payload);
    }

    conflict = await readConflictRecord();
    if (conflicted && conflict !== null) {
      // The 409 snapshot is the freshest published state we know.
      published = {
        ...conflict.latest,
        profileVersion: conflict.latestVersion,
        userIdText: published?.userIdText ?? null,
      };
    }
    sendState = await readSendState();

    return {
      conflict,
      conflicted,
      publishedChanged,
      imageUploadFailed,
      error: conflicted && conflict === null ? 'conflict response was unreadable' : null,
    };
  }

  async function applyResolution(
    baseVersion: number,
    merge: ConflictMerge,
  ): Promise<ProfileResolveResult> {
    draft = merge.draft;
    await persistDraft();
    if (merge.discardStagedAvatar && stagedAvatar !== null) {
      await discardStagedImage();
    }
    if (!merge.hasFields) {
      await clearConflictRecord();
      return { status: 'adopted' };
    }
    const payload: Record<string, unknown> = { base_version: baseVersion };
    if (merge.fields.displayName !== undefined) payload['display_name'] = merge.fields.displayName;
    if (merge.fields.introduction !== undefined) payload['introduction'] = merge.fields.introduction;
    if (merge.fields.avatarPath !== undefined) payload['avatar_path'] = merge.fields.avatarPath;
    submittedFromPayload(payload);
    const { operation, coalesced } = await deps.queue.enqueue({
      accountId: deps.accountId,
      kind: 'update_profile',
      payload,
      baseVersion,
    });
    sendState = { operationId: operation.operationId, state: operation.state };
    return { status: 'queued', operationId: operation.operationId, coalesced };
  }

  async function resolveConflict(
    selection: ConflictSelection,
  ): Promise<ProfileResolveResult> {
    if (!loaded) await load();
    const { body } = requireState();
    const record = conflict;
    if (record === null) throw new Error('there is no conflict to resolve');
    const options = { stagedAvatar: stagedAvatar !== null };

    // Freshness gate: if the published side moved since the comparison was
    // built, re-run the comparison NOW — enqueueing on the old base would
    // only produce another conflict (競合画面を開いた後の再競合も上書きしない).
    try {
      const fresh = await deps.fetchPublication();
      if (fresh.profileVersion !== record.latestVersion) {
        published = fresh;
        const rebased = rebaseConflictRecord(record, fieldsOf(fresh), fresh.profileVersion);
        conflict = rebased;
        await storeConflict(rebased).catch(() => undefined);
        return { status: 'conflict', conflict: rebased };
      }
    } catch {
      // Offline: resolve on the recorded base; a re-conflict on send
      // re-runs this comparison when the worker gets an answer.
    }

    const merged = mergeConflictSelection(record, body, selection, options);
    if (merged.status === 'invalid') {
      return { status: 'invalid', errors: merged.errors };
    }
    return applyResolution(record.latestVersion, merged.merge);
  }

  async function cancelPendingSends(): Promise<number> {
    requireState();
    const rows = await listOperations(deps.storage, deps.accountId);
    let cancelled = 0;
    for (const row of rows) {
      if (row.kind !== 'update_profile') continue;
      if (row.state !== 'pending' && row.state !== 'needs_confirmation') continue;
      if (await deps.queue.cancelUnsent(deps.accountId, row.operationId)) cancelled += 1;
    }
    sendState = await readSendState();
    return cancelled;
  }

  return {
    load,
    refreshLocal,
    setDisplayName: (value) => setField((body) => { body.displayName = value; }),
    setIntroduction: (value) => setField((body) => { body.introduction = value; }),
    setClearAvatar: (value) => setField((body) => { body.clearAvatar = value; }),
    save,
    pump,
    resolveConflict,
    cancelPendingSends,
    view: buildView,
  };
}

/** Default wiring of {@link createProfileEditor} for the device. */
export interface DeviceProfileEditorOptions {
  accountId: string;
  storage: Storage;
  /** Injected client (tests); defaults to the app singleton. */
  client?: SupabaseClient;
}

export function createDeviceProfileEditor(
  options: DeviceProfileEditorOptions,
): ProfileEditor {
  const queue = createSyncQueue({
    store: options.storage,
    clock: { now: () => Date.now() },
    random: Math.random,
  });
  const store = createImageStore({ fs: expoFileSystemPort });
  return createProfileEditor({
    accountId: options.accountId,
    storage: options.storage,
    queue,
    api: createCommandApi(options.client === undefined ? {} : { client: options.client }),
    fetchPublication: () => getOwnPublication(options.client),
    uploadImage: (operationId, upload) => uploadProfileImage(operationId, upload, options.client),
    resolvePath: (reference) => store.resolvePath(reference),
    readFile: async (uri: string) => new File(uri).bytes(),
    imageStore: store,
  });
}
