import {
  APPEARANCE_MILESTONES,
  type AppearanceMilestone,
  type AppearanceStage,
  type AppearanceVibrancy,
} from '../appearance/catalog';
import { highestMilestone } from '../appearance/progress';
import { requireNonEmpty, StorageError, type Storage } from './database';
import { readDeviceSetting } from './settings';

/**
 * Device-local state for appearance growth 演出 (Task 8).
 *
 * Two deliberately small stores share this module:
 *
 * - `appearance_celebrations` is an account-keyed ledger per internal subject.
 *   It remembers only the first canonical baseline and the highest milestone
 *   already consumed by playback. A conversation subject is the peer's
 *   internal UUID; changing `conversation_id` or `friendship_epoch` must never
 *   create a second record. The personal streak subject is the literal
 *   `'self'`. Names, User ID text, bodies and images are never stored here.
 * - `appearance.preferences` is a device-scoped JSON value (NULL account), so
 *   it survives logout and applies to every account on the same device.
 *
 * Every write runs in one `withWriteTransaction`. An optional lifetime guard
 * is checked after the writes and immediately before commit; a stale account
 * lifetime throws and rolls the whole batch back.
 */

export type AppearanceCelebrationKind = 'chat' | 'streak';

/** The device-local ledger row. `subjectId` is an internal identity only. */
export interface CelebrationRecord {
  accountId: string;
  kind: AppearanceCelebrationKind;
  subjectId: string;
  baselineDays: number;
  consumedMilestone: AppearanceStage;
}

export interface CelebrationKey {
  accountId: string;
  kind: AppearanceCelebrationKind;
  subjectId: string;
}

/** A guard tied to the authenticated repository/session lifetime. */
export type AppearanceLifetime = () => boolean | Promise<boolean>;

export interface BaselineCelebrationInput extends CelebrationKey {
  /** First canonical day count; normalized to a non-negative integer. */
  days: number;
  lifetime?: AppearanceLifetime;
}

export interface CelebrationConsumption {
  kind: AppearanceCelebrationKind;
  subjectId: string;
  milestone: AppearanceMilestone;
}

export interface ConsumeCelebrationBatchInput {
  accountId: string;
  /** One or two unique records; all of them commit or all roll back. */
  records: readonly CelebrationConsumption[];
  lifetime?: AppearanceLifetime;
}

export interface AppearancePreferences {
  vibrancy: AppearanceVibrancy;
  chatEnabled: boolean;
  streakEnabled: boolean;
  chatResumeGeneration: number;
  streakResumeGeneration: number;
}

export type AppearanceResumeKind = 'chat' | 'streak';

export interface AppearancePreferencesPatch {
  vibrancy?: AppearanceVibrancy;
  chatEnabled?: boolean;
  streakEnabled?: boolean;
}

export interface UpdateAppearancePreferencesOptions {
  /** Kinds re-enabled by the user; their resume generation bumps atomically. */
  bumpResume?: readonly AppearanceResumeKind[];
  lifetime?: AppearanceLifetime;
}

export interface WriteAppearancePreferencesOptions {
  lifetime?: AppearanceLifetime;
}

/** Device-scoped settings key; never sent to the server or another device. */
export const APPEARANCE_PREFERENCES_KEY = 'appearance.preferences';

const DEFAULT_PREFERENCES: AppearancePreferences = {
  vibrancy: 'flashy',
  chatEnabled: true,
  streakEnabled: true,
  chatResumeGeneration: 0,
  streakResumeGeneration: 0,
};

const VIBRANCY_VALUES: readonly AppearanceVibrancy[] = ['flashy', 'subtle', 'off'];

interface CelebrationRow {
  account_id: string;
  kind: string;
  subject_id: string;
  baseline_days: number;
  consumed_milestone: number;
}

function isMilestone(value: unknown): value is AppearanceMilestone {
  return typeof value === 'number' && (APPEARANCE_MILESTONES as readonly number[]).includes(value);
}

function requireKind(value: unknown): AppearanceCelebrationKind {
  if (value !== 'chat' && value !== 'streak') {
    throw new StorageError('appearance celebration kind must be chat or streak');
  }
  return value;
}

function requireMilestone(value: unknown): AppearanceMilestone {
  if (!isMilestone(value)) {
    throw new StorageError('appearance celebration milestone must be 1, 7, 30, 60 or 100');
  }
  return value;
}

function requireSubject(subjectId: unknown): string {
  return requireNonEmpty('subjectId', typeof subjectId === 'string' ? subjectId : '');
}

function normalizeBaselineDays(days: number): number {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return 0;
  return Math.min(Math.floor(days), Number.MAX_SAFE_INTEGER);
}

function asStage(value: number): AppearanceStage {
  if (value === 0 || isMilestone(value)) return value as AppearanceStage;
  throw new StorageError('appearance celebration has an invalid consumed milestone');
}

function toRecord(row: CelebrationRow): CelebrationRecord {
  return {
    accountId: row.account_id,
    kind: requireKind(row.kind),
    subjectId: row.subject_id,
    baselineDays: row.baseline_days,
    consumedMilestone: asStage(row.consumed_milestone),
  };
}

async function assertLifetime(lifetime?: AppearanceLifetime): Promise<void> {
  if (lifetime === undefined) return;
  if (!(await lifetime())) {
    throw new StorageError('appearance lifetime is no longer active');
  }
}

/** Reads one ledger row, or null when the subject has no baseline yet. */
export async function readCelebration(
  db: Storage,
  key: CelebrationKey,
): Promise<CelebrationRecord | null> {
  requireNonEmpty('accountId', key.accountId);
  const kind = requireKind(key.kind);
  const subjectId = requireSubject(key.subjectId);
  const row = await db.getFirstAsync<CelebrationRow>(
    `SELECT account_id, kind, subject_id, baseline_days, consumed_milestone
       FROM appearance_celebrations
      WHERE account_id = ? AND kind = ? AND subject_id = ?`,
    [key.accountId, kind, subjectId],
  );
  return row === null ? null : toRecord(row);
}

/**
 * Inserts the first canonical baseline. An existing row is returned unchanged:
 * a later synchronization never resets the baseline or consumed milestone,
 * which is what suppresses milestones reached before the first sync.
 */
export async function baselineCelebration(
  db: Storage,
  input: BaselineCelebrationInput,
): Promise<CelebrationRecord> {
  requireNonEmpty('accountId', input.accountId);
  const kind = requireKind(input.kind);
  const subjectId = requireSubject(input.subjectId);
  const baselineDays = normalizeBaselineDays(input.days);

  return db.withWriteTransaction(async (tx) => {
    await tx.runAsync(
      `INSERT INTO appearance_celebrations
         (account_id, kind, subject_id, baseline_days, consumed_milestone)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, kind, subject_id) DO NOTHING`,
      [input.accountId, kind, subjectId, baselineDays, highestMilestone(baselineDays)],
    );
    const record = await readCelebration(tx, { accountId: input.accountId, kind, subjectId });
    if (record === null) {
      throw new StorageError('appearance celebration baseline was not persisted');
    }
    await assertLifetime(input.lifetime);
    return record;
  });
}

function validateBatchRecords(
  records: readonly CelebrationConsumption[],
): Array<{ kind: AppearanceCelebrationKind; subjectId: string; milestone: AppearanceMilestone }> {
  if (!Array.isArray(records) || records.length < 1 || records.length > 2) {
    throw new StorageError('appearance celebration batch must contain one or two records');
  }
  const seen = new Set<string>();
  return records.map((record) => {
    const kind = requireKind(record?.kind);
    const subjectId = requireSubject(record?.subjectId);
    const milestone = requireMilestone(record?.milestone);
    const key = `${kind}\u0000${subjectId}`;
    if (seen.has(key)) {
      throw new StorageError('appearance celebration batch must not contain duplicates');
    }
    seen.add(key);
    return { kind, subjectId, milestone };
  });
}

/**
 * Marks one or two subjects' highest playback milestone as consumed. The
 * consumed value is monotonic: a late 7-day batch cannot lower a stored 30.
 * The subject must already have a baseline; a missing one is not invented.
 */
export async function consumeCelebrationBatch(
  db: Storage,
  input: ConsumeCelebrationBatchInput,
): Promise<CelebrationRecord[]> {
  requireNonEmpty('accountId', input.accountId);
  const records = validateBatchRecords(input.records);

  return db.withWriteTransaction(async (tx) => {
    const updated: CelebrationRecord[] = [];
    for (const record of records) {
      const existing = await readCelebration(tx, {
        accountId: input.accountId,
        kind: record.kind,
        subjectId: record.subjectId,
      });
      if (existing === null) {
        throw new StorageError('appearance celebration baseline is missing');
      }
      const consumedMilestone = Math.max(existing.consumedMilestone, record.milestone) as AppearanceStage;
      if (consumedMilestone !== existing.consumedMilestone) {
        const result = await tx.runAsync(
          `UPDATE appearance_celebrations
              SET consumed_milestone = ?
            WHERE account_id = ? AND kind = ? AND subject_id = ?`,
          [consumedMilestone, input.accountId, record.kind, record.subjectId],
        );
        if (result.changes !== 1) {
          throw new StorageError('appearance celebration could not be updated');
        }
      }
      updated.push({ ...existing, consumedMilestone });
    }
    await assertLifetime(input.lifetime);
    return updated;
  });
}

function requireVibrancy(value: unknown): AppearanceVibrancy {
  if (typeof value !== 'string' || !VIBRANCY_VALUES.includes(value as AppearanceVibrancy)) {
    throw new StorageError('appearance vibrancy must be flashy, subtle or off');
  }
  return value as AppearanceVibrancy;
}

function requireBoolean(name: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new StorageError(`${name} must be a boolean`);
  return value;
}

function requireGeneration(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new StorageError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function validatePreferences(value: AppearancePreferences): AppearancePreferences {
  if (typeof value !== 'object' || value === null) {
    throw new StorageError('appearance preferences must be an object');
  }
  return {
    vibrancy: requireVibrancy(value.vibrancy),
    chatEnabled: requireBoolean('chatEnabled', value.chatEnabled),
    streakEnabled: requireBoolean('streakEnabled', value.streakEnabled),
    chatResumeGeneration: requireGeneration('chatResumeGeneration', value.chatResumeGeneration),
    streakResumeGeneration: requireGeneration('streakResumeGeneration', value.streakResumeGeneration),
  };
}

function parsePreferences(raw: string): AppearancePreferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StorageError('appearance preferences are not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StorageError('appearance preferences must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  return validatePreferences({
    vibrancy: record['vibrancy'] as AppearanceVibrancy,
    chatEnabled: record['chatEnabled'] as boolean,
    streakEnabled: record['streakEnabled'] as boolean,
    chatResumeGeneration: record['chatResumeGeneration'] as number,
    streakResumeGeneration: record['streakResumeGeneration'] as number,
  });
}

async function readPreferencesFrom(db: Storage): Promise<AppearancePreferences> {
  const raw = await readDeviceSetting(db, APPEARANCE_PREFERENCES_KEY);
  if (raw === null) return { ...DEFAULT_PREFERENCES };
  return parsePreferences(raw);
}

async function writePreferencesRow(db: Storage, value: AppearancePreferences): Promise<void> {
  await db.runAsync(
    `INSERT OR REPLACE INTO device_settings (account_id, key, value, updated_at)
     VALUES (NULL, ?, ?, ?)`,
    [APPEARANCE_PREFERENCES_KEY, JSON.stringify(value), Date.now()],
  );
}

function normalizeResumeKinds(
  kinds: readonly AppearanceResumeKind[] | undefined,
): AppearanceResumeKind[] {
  if (kinds === undefined) return [];
  if (!Array.isArray(kinds)) {
    throw new StorageError('bumpResume must be an array of chat/streak kinds');
  }
  const unique: AppearanceResumeKind[] = [];
  for (const kind of kinds) {
    if (kind !== 'chat' && kind !== 'streak') {
      throw new StorageError('bumpResume may only contain chat or streak');
    }
    if (!unique.includes(kind)) unique.push(kind);
  }
  return unique;
}

function bumpedGeneration(name: string, value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new StorageError(`${name} cannot be incremented further`);
  }
  return value + 1;
}

/** Missing key returns defaults; corrupt or invalid JSON is a StorageError. */
export async function readAppearancePreferences(db: Storage): Promise<AppearancePreferences> {
  return readPreferencesFrom(db);
}

/**
 * Replaces the whole device-scoped preference value. The optional lifetime
 * guard is checked after the write and before commit.
 */
export async function writeAppearancePreferences(
  db: Storage,
  preferences: AppearancePreferences,
  options: WriteAppearancePreferencesOptions = {},
): Promise<AppearancePreferences> {
  const value = validatePreferences(preferences);
  return db.withWriteTransaction(async (tx) => {
    await writePreferencesRow(tx, value);
    await assertLifetime(options.lifetime);
    return value;
  });
}

/**
 * Reads, applies a partial patch, bumps the requested resume generations and
 * writes in ONE transaction, so a failure or stale lifetime rolls back every
 * part (including the generation increments).
 */
export async function updateAppearancePreferences(
  db: Storage,
  patch: AppearancePreferencesPatch,
  options: UpdateAppearancePreferencesOptions = {},
): Promise<AppearancePreferences> {
  if (typeof patch !== 'object' || patch === null) {
    throw new StorageError('appearance preference patch must be an object');
  }
  const resumeKinds = normalizeResumeKinds(options.bumpResume);
  return db.withWriteTransaction(async (tx) => {
    const current = await readPreferencesFrom(tx);
    const next: AppearancePreferences = { ...current };
    if (patch.vibrancy !== undefined) next.vibrancy = requireVibrancy(patch.vibrancy);
    if (patch.chatEnabled !== undefined) {
      next.chatEnabled = requireBoolean('chatEnabled', patch.chatEnabled);
    }
    if (patch.streakEnabled !== undefined) {
      next.streakEnabled = requireBoolean('streakEnabled', patch.streakEnabled);
    }
    for (const kind of resumeKinds) {
      if (kind === 'chat') {
        next.chatResumeGeneration = bumpedGeneration(
          'chatResumeGeneration',
          next.chatResumeGeneration,
        );
      } else {
        next.streakResumeGeneration = bumpedGeneration(
          'streakResumeGeneration',
          next.streakResumeGeneration,
        );
      }
    }
    const value = validatePreferences(next);
    await writePreferencesRow(tx, value);
    await assertLifetime(options.lifetime);
    return value;
  });
}
