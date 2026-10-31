import { useSyncExternalStore } from 'react';

/**
 * Dev-only display override for the growth/streak appearance.
 *
 * The canonical values always come from the server (home/detail responses).
 * Waiting for a real streak to advance makes it impractical to check the
 * milestone visuals, so a development build can substitute display-only
 * values here. Nothing is written to the server or to SQLite: the override
 * only reaches `AppearanceProvider`'s render values, and the home summary
 * line reads the same override so the screen stays internally consistent.
 *
 * Each half is independent: previewing a conversation growth value never
 * changes the personal streak, and vice versa.
 *
 * `setDevPreview` is a no-op when `__DEV__` is false, so a release build can
 * never enter this state even if some code path calls it.
 */

export interface DevStreakPreview {
  /** Personal current streak (the countdown copy). */
  currentStreak: number;
  /** Personal earned/displayed days (the stage and decoration). */
  earnedDays: number;
}

export interface DevAppearancePreview {
  /** null keeps the server-provided personal streak. */
  streak: DevStreakPreview | null;
  /** null keeps the server-provided conversation growth. */
  growthDays: number | null;
}

/** Milestones plus the initial 0 stage, for the quick-pick row. */
export const DEV_PREVIEW_STAGES = [0, 1, 7, 30, 60, 100] as const;

const listeners = new Set<() => void>();
let current: DevAppearancePreview | null = null;

export function devPreviewAvailable(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

function clampDays(value: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), max);
}

export function normalizeDevStreak(input: DevStreakPreview): DevStreakPreview {
  return {
    currentStreak: clampDays(input.currentStreak),
    // Matches the streak appearance contract's 0..100 earned_days range.
    earnedDays: clampDays(input.earnedDays, 100),
  };
}

export function normalizeDevPreview(input: DevAppearancePreview): DevAppearancePreview {
  return {
    streak: input.streak === null ? null : normalizeDevStreak(input.streak),
    growthDays: input.growthDays === null ? null : clampDays(input.growthDays),
  };
}

function sameStreak(a: DevStreakPreview | null, b: DevStreakPreview | null): boolean {
  return a === b || (a !== null && b !== null &&
    a.currentStreak === b.currentStreak && a.earnedDays === b.earnedDays);
}

function samePreview(a: DevAppearancePreview | null, b: DevAppearancePreview | null): boolean {
  return a === b || (a !== null && b !== null &&
    sameStreak(a.streak, b.streak) && a.growthDays === b.growthDays);
}

export function getDevPreview(): DevAppearancePreview | null {
  return devPreviewAvailable() ? current : null;
}

export function setDevPreview(next: DevAppearancePreview | null): void {
  if (!devPreviewAvailable()) return;
  const normalized = next === null ? null : normalizeDevPreview(next);
  if (samePreview(current, normalized)) return;
  current = normalized;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A dev panel listener must not break the appearance provider.
    }
  }
}

export function subscribeDevPreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe a render to override changes; null means "use server values". */
export function useDevPreview(): DevAppearancePreview | null {
  return useSyncExternalStore(subscribeDevPreview, getDevPreview, getDevPreview);
}

/** Stage quick-pick: the selected day becomes both current and earned. */
export function devStreakForStage(days: number): DevStreakPreview {
  return normalizeDevStreak({ currentStreak: days, earnedDays: days });
}
