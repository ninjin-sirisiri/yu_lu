import type { ThemeScheme } from './tokens';

/**
 * Theme mode + 時間帯スケジュール (pure logic).
 *
 * Spec (視覚設計とテーマ):
 * - 4 modes: ライト / ダーク / 端末に合わせる / 時間帯で切り替える.
 *   Initial default = 端末に合わせる.
 * - 時間帯 defaults: light 07:00, dark 19:00; both editable; saving the same
 *   time for both is rejected.
 * - The schedule uses the device's LOCAL time; a boundary crossed while the
 *   app was closed (or after a timezone change) is re-evaluated on resume —
 *   the provider re-runs {@link resolveTheme} with a fresh `now` whenever the
 *   app returns to the foreground.
 */

export type ThemeMode = 'light' | 'dark' | 'system' | 'schedule';

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system', 'schedule'];

/** Japanese labels for the 4 modes (used by the theme settings screen). */
export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  light: 'ライト',
  dark: 'ダーク',
  system: '端末に合わせる',
  schedule: '時間帯で切り替える',
};

/** Initial default: 端末に合わせる. */
export const DEFAULT_THEME_MODE: ThemeMode = 'system';

/** Schedule defaults: ライト 07:00 / ダーク 19:00 (端末の現地時刻). */
export interface ThemeSchedule {
  /** Local time when the light window starts, `HH:MM` (24h). */
  lightStart: string;
  /** Local time when the dark window starts, `HH:MM` (24h). */
  darkStart: string;
}

export const DEFAULT_THEME_SCHEDULE: ThemeSchedule = {
  lightStart: '07:00',
  darkStart: '19:00',
};

export type ScheduleValidation = { ok: true } | { ok: false; message: string };

export const TIME_FORMAT_MESSAGE = '時刻は 00:00〜23:59 の HH:MM 形式で入力してください。';
export const SAME_TIME_MESSAGE = 'ライトとダークに同じ時刻は設定できません。';

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Parses local `HH:MM` (single-digit hour accepted) into minutes past
 * midnight, or returns null for anything else.
 */
export function parseTimeOfDay(text: string): number | null {
  const match = TIME_PATTERN.exec(text.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

/** Formats minutes past midnight as canonical `HH:MM`. */
export function formatTimeOfDay(totalMinutes: number): string {
  const minutes = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * Validates a schedule before it may be saved. Rejects malformed times and —
 * per spec — the same time for both windows.
 */
export function validateThemeSchedule(next: ThemeSchedule): ScheduleValidation {
  const light = parseTimeOfDay(next.lightStart);
  const dark = parseTimeOfDay(next.darkStart);
  if (light === null || dark === null) return { ok: false, message: TIME_FORMAT_MESSAGE };
  if (light === dark) return { ok: false, message: SAME_TIME_MESSAGE };
  return { ok: true };
}

/**
 * Which window contains `now` (device-local time).
 *
 * The two boundaries split the 24h day into two arcs: the light arc runs from
 * `lightStart` (inclusive) to `darkStart` (exclusive), the dark arc covers
 * the rest — which is what makes day rollover work (06:59 the next morning is
 * still inside the dark arc that opened at 19:00 the previous day). Equal
 * times cannot be persisted ({@link validateThemeSchedule}); for defensive
 * reads the degenerate empty light arc yields dark.
 */
export function evaluateThemeSchedule(schedule: ThemeSchedule, now: Date): ThemeScheme {
  const light = parseTimeOfDay(schedule.lightStart);
  const dark = parseTimeOfDay(schedule.darkStart);
  if (light === null || dark === null) {
    // An unparsable persisted value never crashes the app; fall back to the
    // default schedule semantics (07:00 / 19:00).
    return evaluateThemeSchedule(DEFAULT_THEME_SCHEDULE, now);
  }
  const current = now.getHours() * 60 + now.getMinutes();
  if (light === dark) return 'dark';
  const inLightArc = light < dark ? current >= light && current < dark : current >= light || current < dark;
  return inLightArc ? 'light' : 'dark';
}

/**
 * Next local boundary (either window's start) strictly after `now`. Used to
 * schedule the foreground switch at 07:00/19:00 so a schedule theme also
 * updates while the app stays open.
 */
export function nextBoundaryAfter(schedule: ThemeSchedule, now: Date): Date {
  const boundary = (text: string): Date | null => {
    const minutes = parseTimeOfDay(text);
    if (minutes === null) return null;
    const at = new Date(now.getTime());
    at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at;
  };
  const light = boundary(schedule.lightStart);
  const dark = boundary(schedule.darkStart);
  if (light === null) return dark ?? new Date(now.getTime() + 60 * 60 * 1000);
  if (dark === null) return light;
  return light.getTime() <= dark.getTime() ? light : dark;
}

export interface ResolveThemeInput {
  mode: ThemeMode;
  schedule: ThemeSchedule;
  /** Result of the OS dark-mode setting; null/undefined treated as light. */
  deviceScheme: ThemeScheme | null | undefined;
  /** Current device-local time. */
  now: Date;
}

/** Resolves the scheme actually rendered for the given mode. */
export function resolveTheme(input: ResolveThemeInput): ThemeScheme {
  switch (input.mode) {
    case 'light':
      return 'light';
    case 'dark':
      return 'dark';
    case 'system':
      return input.deviceScheme === 'dark' ? 'dark' : 'light';
    case 'schedule':
      return evaluateThemeSchedule(input.schedule, input.now);
  }
}
