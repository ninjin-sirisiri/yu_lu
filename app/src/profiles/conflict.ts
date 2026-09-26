// Task 17: pure comparison / merge helpers over the 409 conflict payload.
//
// Ownership: the wire-shape parser for the structured `{error, conflict}`
// body the Edge boundary answers with, the per-field comparison rows the
// conflict screen renders, and the merge that turns the user's per-field
// selection into (a) the fields of a NEW operation and (b) the draft that
// stays behind. Everything here is a pure function over data: no storage,
// no queue, no clock — the editor (editor.ts) feeds it records and applies
// the results.
//
// The invariants these helpers exist to keep:
// - A conflict NEVER writes anything (the server's compare-and-swap wrote
//   nothing either): resolving merely ENQUEUES a new operation whose
//   base_version is the latest published version the comparison was made
//   against. A conflict that happens again while the screen is open comes
//   back as a fresh record and re-runs this comparison — 自動上書きしない.
// - Fields the user keeps as their own are re-sent under a NEW operation
//   id (the queue allocutes it); a settled operation id is never reused
//   with a different payload (Task 9 invariant, asserted end-to-end).
// - Fields the user takes from the published side are simply NOT part of
//   the new payload (absent = keep the published value), and the local
//   draft is updated to the published value so no phantom "変更予定"
//   remains.

import type { ProfilePublicationFields } from '../backend/profile';
import type { ProfileDraftBody } from './editor';
import {
  validateDisplayNameInput,
  validateIntroductionInput,
} from './validation';

/** The three editable fields (server order: 0012 conflict payload order). */
export type ConflictFieldKey = 'display_name' | 'introduction' | 'avatar_path';

export const CONFLICT_FIELDS: readonly ConflictFieldKey[] = [
  'display_name',
  'introduction',
  'avatar_path',
];

export const CONFLICT_FIELD_LABELS: Record<ConflictFieldKey, string> = {
  display_name: '表示名',
  introduction: '自己紹介',
  avatar_path: '画像',
};

/** Which side wins for one field in the resolution payload. */
export type ConflictChoice = 'mine' | 'theirs';

export type ConflictSelection = Partial<Record<ConflictFieldKey, ConflictChoice>>;

/**
 * The submitted side of a conflict: ONLY the fields that were actually part
 * of the failed operation (absent key = not submitted). `introduction` is
 * the wire value ('' clears the column), `avatarPath` may be null (clear).
 */
export interface ConflictSubmission {
  displayName?: string;
  introduction?: string;
  avatarPath?: string | null;
}

/**
 * One stored conflict: what this device tried to publish, against which
 * base, and what the server reported as the latest published state.
 */
export interface ProfileConflictRecord {
  /** The operation id the server answered 409 for (history, never reused). */
  operationId: string;
  /** The base_version the failed operation was built on. */
  submittedBaseVersion: number;
  submitted: ConflictSubmission;
  /** Latest published version AT COMPARISON TIME (the base to resolve on). */
  latestVersion: number;
  latest: ProfilePublicationFields;
  /** Submitted fields whose value differs from the latest published value. */
  differingFields: ConflictFieldKey[];
  /** The server's conflict message (shared wording, shown as context). */
  message: string;
  /**
   * When the failed operation carried a staged local image, its relative
   * path — the link that lets a successful resolution prove "this staged
   * image is now the published one" and drop the local draft.
   */
  stagedRelativePath?: string;
  createdAt: number;
}

/** One row of the screen's 項目別 comparison. */
export interface ConflictComparisonRow {
  field: ConflictFieldKey;
  label: string;
  /** Was this field part of the failed submission? */
  submitted: boolean;
  /** Does the two sides' values differ (after shared normalization)? */
  differs: boolean;
  /** This device's value (raw display form; null = no image / empty intro). */
  mine: string | null;
  /**
   * Avatar only: an UNsubmitted local intent (a staged image the other side
   * has never seen, or a pending clear) — `mine` alone cannot express it.
   */
  mineIntent?: 'staged' | 'clear';
  /** The latest published value (null = no image / no introduction). */
  theirs: string | null;
  /** Default selection: keep what I submitted, otherwise keep theirs. */
  defaultChoice: ConflictChoice;
}

// ---------------------------------------------------------------------------
// Wire parsing (409 conflict body → record material)
// ---------------------------------------------------------------------------

export interface ParsedConflictBody {
  message: string;
  version: number;
  profile: ProfilePublicationFields;
  differingFields: ConflictFieldKey[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseFields(value: unknown): ProfilePublicationFields | null {
  const profile = asRecord(value);
  if (profile === null) return null;
  const displayName = profile['display_name'];
  if (typeof displayName !== 'string') return null;
  const introduction = profile['introduction'];
  if (introduction !== null && typeof introduction !== 'string') return null;
  const avatarPath = profile['avatar_path'];
  if (avatarPath !== null && typeof avatarPath !== 'string') return null;
  return {
    displayName,
    introduction: introduction ?? null,
    avatarPath: avatarPath ?? null,
  };
}

function isFieldKey(value: unknown): value is ConflictFieldKey {
  return (CONFLICT_FIELDS as readonly string[]).includes(value as string);
}

/**
 * Parses the `{status: 'conflict', message, version, profile,
 * differing_fields}` body the 409 carries. Returns null for anything that
 * is not a well-formed conflict body — the caller then falls back to
 * treating the failure as an ordinary send failure instead of inventing a
 * comparison the server never made.
 */
export function parseConflictBody(body: unknown): ParsedConflictBody | null {
  const record = asRecord(body);
  if (record === null) return null;
  if (record['status'] !== 'conflict') return null;
  const version = record['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return null;
  const profile = parseFields(record['profile']);
  if (profile === null) return null;
  const rawDiff = record['differing_fields'];
  const differingFields: ConflictFieldKey[] = Array.isArray(rawDiff)
    ? rawDiff.filter(isFieldKey)
    : [];
  const message = typeof record['message'] === 'string'
    ? record['message']
    : 'profile version conflict';
  return { message, version, profile, differingFields };
}

// ---------------------------------------------------------------------------
// Field comparison (mirror of the SQL conflict report)
// ---------------------------------------------------------------------------

/** '' and null are the same stored introduction (0012: '' → NULL). */
function normalizeIntroduction(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

/**
 * Submitted values that differ from the latest published values — the same
 * predicate 0012's handler reports as `differing_fields` (values are
 * compared AFTER the shared validation both sides already applied).
 */
export function computeDifferingFields(
  submitted: ConflictSubmission,
  latest: ProfilePublicationFields,
): ConflictFieldKey[] {
  const differing: ConflictFieldKey[] = [];
  if (
    submitted.displayName !== undefined &&
    submitted.displayName.trim() !== latest.displayName
  ) {
    differing.push('display_name');
  }
  if (
    submitted.introduction !== undefined &&
    normalizeIntroduction(submitted.introduction) !== normalizeIntroduction(latest.introduction)
  ) {
    differing.push('introduction');
  }
  if (
    submitted.avatarPath !== undefined &&
    (submitted.avatarPath ?? null) !== (latest.avatarPath ?? null)
  ) {
    differing.push('avatar_path');
  }
  return differing;
}

// ---------------------------------------------------------------------------
// Comparison rows for the conflict screen
// ---------------------------------------------------------------------------

/** The draft's current avatar intent, as a comparable value. */
function draftAvatarIntent(
  draft: ProfileDraftBody,
  stagedAvatar: boolean,
): 'staged' | 'clear' | null {
  if (stagedAvatar) return 'staged';
  if (draft.clearAvatar === true) return 'clear';
  return null;
}

/**
 * Builds the per-field comparison: every field that was submitted or whose
 * two sides visibly differ gets a row (項目別比較). Fields the user never
 * touched default to the published side, so an unrelated change made on
 * another device is never silently overwritten by a resolution.
 */
export function buildConflictRows(
  record: ProfileConflictRecord,
  draft: ProfileDraftBody,
  options: { stagedAvatar?: boolean } = {},
): ConflictComparisonRow[] {
  const rows: ConflictComparisonRow[] = [];
  const submittedName = record.submitted.displayName;
  const mineName = submittedName !== undefined ? submittedName : draft.displayName;
  const differsName = mineName.trim() !== record.latest.displayName;
  if (submittedName !== undefined || differsName) {
    rows.push({
      field: 'display_name',
      label: CONFLICT_FIELD_LABELS.display_name,
      submitted: submittedName !== undefined,
      differs: differsName,
      mine: mineName,
      theirs: record.latest.displayName,
      defaultChoice: submittedName !== undefined ? 'mine' : 'theirs',
    });
  }

  const submittedIntro = record.submitted.introduction;
  const mineIntro = submittedIntro !== undefined ? submittedIntro : draft.introduction;
  const differsIntro =
    normalizeIntroduction(mineIntro) !== normalizeIntroduction(record.latest.introduction);
  if (submittedIntro !== undefined || differsIntro) {
    rows.push({
      field: 'introduction',
      label: CONFLICT_FIELD_LABELS.introduction,
      submitted: submittedIntro !== undefined,
      differs: differsIntro,
      mine: normalizeIntroduction(mineIntro),
      theirs: normalizeIntroduction(record.latest.introduction),
      defaultChoice: submittedIntro !== undefined ? 'mine' : 'theirs',
    });
  }

  const intent = draftAvatarIntent(draft, options.stagedAvatar === true);
  const submittedAvatar = record.submitted.avatarPath;
  const mineAvatar = submittedAvatar !== undefined ? (submittedAvatar ?? null) : null;
  const differsAvatar =
    intent !== null ||
    (submittedAvatar !== undefined && (submittedAvatar ?? null) !== (record.latest.avatarPath ?? null));
  if (submittedAvatar !== undefined || differsAvatar) {
    rows.push({
      field: 'avatar_path',
      label: CONFLICT_FIELD_LABELS.avatar_path,
      submitted: submittedAvatar !== undefined,
      differs: differsAvatar,
      mine: submittedAvatar !== undefined ? mineAvatar : null,
      mineIntent: submittedAvatar === undefined && intent !== null ? intent : undefined,
      theirs: record.latest.avatarPath ?? null,
      defaultChoice: submittedAvatar !== undefined ? 'mine' : 'theirs',
    });
  }

  return rows;
}

/** The default selection for the whole screen (per row defaults). */
export function conflictSelectionDefaults(
  record: ProfileConflictRecord,
  draft: ProfileDraftBody,
  options: { stagedAvatar?: boolean } = {},
): ConflictSelection {
  const selection: ConflictSelection = {};
  for (const row of buildConflictRows(record, draft, options)) {
    selection[row.field] = row.defaultChoice;
  }
  return selection;
}

// ---------------------------------------------------------------------------
// Merge: selection → new payload + updated draft
// ---------------------------------------------------------------------------

export interface ConflictMerge {
  /** The draft to persist (fields taken from the published side adopt it). */
  draft: ProfileDraftBody;
  /**
   * CamelCase fields to put into the NEW operation — ONLY the keys the
   * user keeps as their own AND that differ from the published side
   * (absent key = the server keeps the published value); empty = nothing
   * to send (公開内容をそのまま採用).
   */
  fields: Partial<ProfilePublicationFields>;
  hasFields: boolean;
  /** True when the local staged image lost its selection (画像:公開内容). */
  discardStagedAvatar: boolean;
}

export type ConflictMergeResult =
  | { status: 'merged'; merge: ConflictMerge }
  | { status: 'invalid'; errors: { displayName: string | null; introduction: string | null } };

/**
 * Applies the user's per-field selection. Pure: the caller persists the
 * returned draft, optionally drops the staged image, and enqueues
 * `fields` — or does nothing at all when every field was taken from the
 * published side (公開内容を採用 = no write, no operation).
 *
 * Draft preservation: a draft value that moved BEYOND what the failed
 * operation submitted (the user kept typing after the save) is never
 * clobbered by a resolution — it stays the pending 変更予定 and will be
 * sent by a later save. The selection only decides the submitted value's
 * fate against the published side.
 */
export function mergeConflictSelection(
  record: ProfileConflictRecord,
  draft: ProfileDraftBody,
  selection: ConflictSelection,
  options: { stagedAvatar?: boolean } = {},
): ConflictMergeResult {
  const rows = buildConflictRows(record, draft, options);
  const next: ProfileDraftBody = {
    displayName: draft.displayName,
    introduction: draft.introduction,
    ...(draft.clearAvatar === undefined ? {} : { clearAvatar: draft.clearAvatar }),
  };
  const fields: Partial<ProfilePublicationFields> = {};
  let hasDisplayName = false;
  let hasIntroduction = false;
  let hasAvatar = false;
  let discardStagedAvatar = false;

  const intent = draftAvatarIntent(draft, options.stagedAvatar === true);

  for (const row of rows) {
    const choice: ConflictChoice = selection[row.field] ?? row.defaultChoice;
    switch (row.field) {
      case 'display_name': {
        const submitted = record.submitted.displayName;
        const local = draft.displayName;
        if (submitted !== undefined && local.trim() !== submitted.trim()) {
          // The user typed a NEWER display name after the save: keep it as
          // the pending value regardless of the choice; at most the
          // submitted value goes back on the published side.
          next.displayName = local;
          if (
            choice === 'mine' &&
            submitted.trim() !== record.latest.displayName
          ) {
            fields.displayName = submitted.trim();
            hasDisplayName = true;
          }
        } else if (choice === 'mine') {
          const value = submitted !== undefined ? submitted : local;
          next.displayName = value;
          if (value.trim() !== record.latest.displayName) {
            fields.displayName = value.trim();
            hasDisplayName = true;
          }
        } else {
          next.displayName = record.latest.displayName;
        }
        break;
      }
      case 'introduction': {
        const submitted = record.submitted.introduction;
        const local = draft.introduction;
        if (
          submitted !== undefined &&
          normalizeIntroduction(local) !== normalizeIntroduction(submitted)
        ) {
          next.introduction = local;
          if (
            choice === 'mine' &&
            normalizeIntroduction(submitted) !== normalizeIntroduction(record.latest.introduction)
          ) {
            fields.introduction = submitted;
            hasIntroduction = true;
          }
        } else if (choice === 'mine') {
          const value = submitted !== undefined ? submitted : local;
          next.introduction = value;
          if (normalizeIntroduction(value) !== normalizeIntroduction(record.latest.introduction)) {
            fields.introduction = value;
            hasIntroduction = true;
          }
        } else {
          next.introduction = record.latest.introduction ?? '';
        }
        break;
      }
      case 'avatar_path': {
        const submitted = record.submitted.avatarPath;
        if (submitted !== undefined) {
          if (choice === 'mine') {
            // Keep the pending avatar intent exactly as submitted; a staged
            // local copy stays staged (dropped after the re-send publishes).
            next.clearAvatar = (submitted ?? null) === null;
            if ((submitted ?? null) !== (record.latest.avatarPath ?? null)) {
              fields.avatarPath = submitted ?? null;
              hasAvatar = true;
            }
          } else {
            next.clearAvatar = false;
            if (intent === 'staged') discardStagedAvatar = true;
          }
        } else if (intent === 'staged') {
          // A staged image this operation never carried: an explicit
          // "公開内容" choice drops it; the default keeps it pending.
          if (choice === 'theirs') discardStagedAvatar = true;
        } else if (intent === 'clear') {
          if (choice === 'mine') {
            next.clearAvatar = true;
            if (record.latest.avatarPath !== null) {
              fields.avatarPath = null;
              hasAvatar = true;
            }
          } else {
            next.clearAvatar = false;
          }
        }
        break;
      }
    }
  }

  const nameCheck = validateDisplayNameInput(next.displayName);
  const introCheck = validateIntroductionInput(next.introduction);
  if (!nameCheck.ok || !introCheck.ok) {
    return {
      status: 'invalid',
      errors: {
        displayName: nameCheck.ok ? null : nameCheck.error,
        introduction: introCheck.ok ? null : introCheck.error,
      },
    };
  }
  next.displayName = nameCheck.value;
  next.introduction = introCheck.value ?? '';

  const hasFields = hasDisplayName || hasIntroduction || hasAvatar;
  return {
    status: 'merged',
    merge: {
      draft: next,
      fields,
      hasFields,
      discardStagedAvatar,
    },
  };
}

// ---------------------------------------------------------------------------
// Draft shape guard (persisted record restore)
// ---------------------------------------------------------------------------

function isConflictSubmission(value: unknown): value is ConflictSubmission {
  const record = asRecord(value);
  if (record === null) return false;
  // Snake_case markers of the failed wire payload never live in a record.
  if ('display_name' in record || 'avatar_path' in record) return false;
  const name = record['displayName'];
  if (name !== undefined && typeof name !== 'string') return false;
  const intro = record['introduction'];
  if (intro !== undefined && typeof intro !== 'string') return false;
  const avatar = record['avatarPath'];
  if (avatar !== undefined && avatar !== null && typeof avatar !== 'string') return false;
  return true;
}

function isPublicationFields(value: unknown): value is ProfilePublicationFields {
  const record = asRecord(value);
  if (record === null) return false;
  if (typeof record['displayName'] !== 'string') return false;
  const introduction = record['introduction'];
  if (introduction !== null && typeof introduction !== 'string') return false;
  const avatarPath = record['avatarPath'];
  if (avatarPath !== null && typeof avatarPath !== 'string') return false;
  return true;
}

/** Shape guard for a conflict record restored from the drafts table. */
export function isProfileConflictRecord(value: unknown): value is ProfileConflictRecord {
  const record = asRecord(value);
  if (record === null) return false;
  if (typeof record['operationId'] !== 'string' || record['operationId'] === '') return false;
  if (typeof record['submittedBaseVersion'] !== 'number') return false;
  if (typeof record['latestVersion'] !== 'number') return false;
  if (!isConflictSubmission(record['submitted'])) return false;
  if (!isPublicationFields(record['latest'])) return false;
  if (!Array.isArray(record['differingFields'])) return false;
  if (typeof record['createdAt'] !== 'number') return false;
  return true;
}

/**
 * Rebuilds the comparison after the published side moved again (a second
 * conflict while the screen was open, or a background publication): same
 * submission, fresh latest — re-run the comparison instead of overwriting.
 */
export function rebaseConflictRecord(
  record: ProfileConflictRecord,
  latest: ProfilePublicationFields,
  latestVersion: number,
): ProfileConflictRecord {
  const differingFields = computeDifferingFields(record.submitted, latest);
  return {
    ...record,
    latest,
    latestVersion,
    differingFields,
  };
}
