import {
  APPEARANCE_MILESTONES,
  stageForDays,
  type AppearanceMilestone,
  type AppearanceStage,
} from './catalog';

export { APPEARANCE_MILESTONES } from './catalog';

/** One milestone marker on the stage bar. A bar never fills by raw days:
 * a segment is either reached by the displayed stage or it is not. */
export interface StageBarSegment {
  milestone: AppearanceMilestone;
  reached: boolean;
}

export interface StageBar {
  stage: AppearanceStage;
  segments: readonly StageBarSegment[];
}

export interface ProgressCopy {
  /** Chat: cumulative days. Streak: the current streak. */
  current: string;
  /** The earned/displayed appearance stage, never a raw held value. */
  stage: string;
  /** Remaining days to the next milestone, or the maximum-stage copy. */
  next: string;
}

interface ProgressBase {
  stage: AppearanceStage;
  /** The day label of the displayed stage (0, 1, 7, 30, 60 or 100). */
  displayDays: AppearanceStage;
  nextMilestone: AppearanceMilestone | null;
  remainingDays: number;
  max: boolean;
  bar: StageBar;
  copy: ProgressCopy;
}

export interface ChatProgress extends ProgressBase {
  subject: 'chat';
  cumulativeDays: number;
}

export interface StreakProgress extends ProgressBase {
  subject: 'streak';
  currentStreak: number;
  /** Held maximum, kept separate from the current streak. */
  earnedDays: number;
}

const MAX_STAGE_COPY = '最大段階に到達';

function normalizedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Highest milestone reached by a confirmed day count. */
export function highestMilestone(days: number): AppearanceStage {
  return stageForDays(days);
}

export function nextMilestone(stage: AppearanceStage): AppearanceMilestone | null {
  return APPEARANCE_MILESTONES.find((milestone) => milestone > stage) ?? null;
}

export function reachedMilestones(days: number): AppearanceMilestone[] {
  const stage = stageForDays(days);
  return APPEARANCE_MILESTONES.filter((milestone) => milestone <= stage);
}

/** Milestones strictly after `from` and no later than `to`. A backwards or
 * non-finite range crosses nothing. */
export function crossedMilestones(from: number, to: number): AppearanceMilestone[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  return APPEARANCE_MILESTONES.filter((milestone) => milestone > from && milestone <= to);
}

function stageBar(stage: AppearanceStage): StageBar {
  return {
    stage,
    segments: APPEARANCE_MILESTONES.map((milestone) => ({
      milestone,
      reached: milestone <= stage,
    })),
  };
}

function nextCopy(next: AppearanceMilestone | null, remainingDays: number): string {
  return next === null
    ? MAX_STAGE_COPY
    : `次の${next}日段階まであと${remainingDays}日`;
}

/** Chat growth is cumulative; 101+ keeps the 100-day complete appearance. */
export function chatProgress(growthDays: number): ChatProgress {
  const cumulativeDays = normalizedCount(growthDays);
  const stage = stageForDays(cumulativeDays);
  const next = nextMilestone(stage);
  const max = stage === 100;
  const remainingDays = next === null ? 0 : Math.max(0, next - cumulativeDays);
  return {
    subject: 'chat',
    cumulativeDays,
    stage,
    displayDays: stage,
    nextMilestone: next,
    remainingDays,
    max,
    bar: stageBar(stage),
    copy: {
      current: `累計${cumulativeDays}日`,
      stage: `見た目：${stage}日段階`,
      next: nextCopy(next, remainingDays),
    },
  };
}

/**
 * Personal streak appearance is based on the held `earnedDays` maximum, while
 * the remaining countdown is based on the current streak. A reset streak of 0
 * with 29 earned days is therefore the 7-day stage, 30 days from the 30-day
 * milestone — not a "29-day stage" and not "1 day remaining".
 */
export function streakProgress(input: { currentStreak: number; earnedDays: number }): StreakProgress {
  const currentStreak = normalizedCount(input.currentStreak);
  const earnedDays = Math.min(normalizedCount(input.earnedDays), 100);
  const stage = stageForDays(earnedDays);
  const next = nextMilestone(stage);
  const max = stage === 100;
  const remainingDays = next === null ? 0 : Math.max(0, next - currentStreak);
  return {
    subject: 'streak',
    currentStreak,
    earnedDays,
    stage,
    displayDays: stage,
    nextMilestone: next,
    remainingDays,
    max,
    bar: stageBar(stage),
    copy: {
      current: `現在${currentStreak}日`,
      stage: `獲得済み：${stage}日段階`,
      next: nextCopy(next, remainingDays),
    },
  };
}
