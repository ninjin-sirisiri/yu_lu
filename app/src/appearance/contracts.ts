// Validated app-facing appearance DTOs. The wire shapes mirror the Edge
// boundary exactly; every read is total and distinguishes unavailable data
// from a real zero. Unknown versions never become executable decoration.
export const APPEARANCE_CATALOG_VERSION = 1;
export const STREAK_APPEARANCE_VERSION = 1;

export const APPEARANCE_PRESET_IDS = ['b-pop', 'b-candy', 'b-soda'] as const;
export type AppearancePresetId = (typeof APPEARANCE_PRESET_IDS)[number];

export interface ChatAppearanceWire {
  growth_days: number;
  auto_preset_id: AppearancePresetId;
  selected_preset_id: AppearancePresetId | null;
  effective_preset_id: AppearancePresetId;
  catalog_version: number;
  settings_revision: number;
  can_change: boolean;
}

export interface StreakAppearanceWire {
  current_streak: number;
  earned_days: number;
  appearance_version: number;
}

export interface ChatAppearance {
  growthDays: number;
  autoPresetId: AppearancePresetId;
  selectedPresetId: AppearancePresetId | null;
  effectivePresetId: AppearancePresetId;
  catalogVersion: typeof APPEARANCE_CATALOG_VERSION;
  settingsRevision: number;
  canChange: boolean;
}

export interface StreakAppearance {
  currentStreak: number;
  earnedDays: number;
  appearanceVersion: typeof STREAK_APPEARANCE_VERSION;
}

export type AppearanceRead<T> =
  | { status: 'ready'; value: T }
  | { status: 'unavailable'; reason: 'missing' | 'invalid' | 'unsupported_version' };

type VersionRead = 'ok' | 'invalid' | 'unsupported';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPreset(value: unknown): value is AppearancePresetId {
  return typeof value === 'string' && (APPEARANCE_PRESET_IDS as readonly string[]).includes(value);
}

function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function readVersion(value: unknown, supported: number): VersionRead {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'invalid';
  return value === supported ? 'ok' : 'unsupported';
}

export function readChatAppearance(raw: unknown): AppearanceRead<ChatAppearance> {
  if (raw === undefined || raw === null) return { status: 'unavailable', reason: 'missing' };
  if (!isRecord(raw)) return { status: 'unavailable', reason: 'invalid' };

  const version = readVersion(raw.catalog_version, APPEARANCE_CATALOG_VERSION);
  if (version === 'invalid') return { status: 'unavailable', reason: 'invalid' };
  if (version === 'unsupported') return { status: 'unavailable', reason: 'unsupported_version' };

  const { growth_days, auto_preset_id, selected_preset_id, effective_preset_id, settings_revision, can_change } = raw;
  if (!isCount(growth_days) || !isCount(settings_revision) || typeof can_change !== 'boolean' ||
      !isPreset(auto_preset_id) || !isPreset(effective_preset_id) ||
      (selected_preset_id !== null && !isPreset(selected_preset_id))) {
    return { status: 'unavailable', reason: 'invalid' };
  }
  if (effective_preset_id !== (selected_preset_id ?? auto_preset_id)) {
    return { status: 'unavailable', reason: 'invalid' };
  }

  return {
    status: 'ready',
    value: {
      growthDays: growth_days,
      autoPresetId: auto_preset_id,
      selectedPresetId: selected_preset_id,
      effectivePresetId: effective_preset_id,
      catalogVersion: APPEARANCE_CATALOG_VERSION,
      settingsRevision: settings_revision,
      canChange: can_change,
    },
  };
}

export function readStreakAppearance(raw: unknown): AppearanceRead<StreakAppearance> {
  if (raw === undefined || raw === null) return { status: 'unavailable', reason: 'missing' };
  if (!isRecord(raw)) return { status: 'unavailable', reason: 'invalid' };

  const version = readVersion(raw.appearance_version, STREAK_APPEARANCE_VERSION);
  if (version === 'invalid') return { status: 'unavailable', reason: 'invalid' };
  if (version === 'unsupported') return { status: 'unavailable', reason: 'unsupported_version' };

  const { current_streak, earned_days } = raw;
  if (!isCount(current_streak) || !isCount(earned_days, 100)) {
    return { status: 'unavailable', reason: 'invalid' };
  }

  return {
    status: 'ready',
    value: {
      currentStreak: current_streak,
      earnedDays: earned_days,
      appearanceVersion: STREAK_APPEARANCE_VERSION,
    },
  };
}
