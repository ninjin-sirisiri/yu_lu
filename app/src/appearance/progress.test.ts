import {
  APPEARANCE_MILESTONES,
  highestMilestone,
  nextMilestone,
  reachedMilestones,
  crossedMilestones,
  chatProgress,
  streakProgress,
} from './progress';

it('shares milestone helpers between chat and streak', () => {
  expect(highestMilestone(0)).toBe(0);
  expect(highestMilestone(1)).toBe(1);
  expect(highestMilestone(6)).toBe(1);
  expect(highestMilestone(7)).toBe(7);
  expect(highestMilestone(29)).toBe(7);
  expect(highestMilestone(30)).toBe(30);
  expect(highestMilestone(59)).toBe(30);
  expect(highestMilestone(60)).toBe(60);
  expect(highestMilestone(99)).toBe(60);
  expect(highestMilestone(100)).toBe(100);
  expect(highestMilestone(101)).toBe(100);
  for (const invalid of [-1, NaN, Infinity, -Infinity]) {
    expect(highestMilestone(invalid)).toBe(0);
  }

  expect(nextMilestone(0)).toBe(1);
  expect(nextMilestone(1)).toBe(7);
  expect(nextMilestone(7)).toBe(30);
  expect(nextMilestone(30)).toBe(60);
  expect(nextMilestone(60)).toBe(100);
  expect(nextMilestone(100)).toBeNull();

  expect(reachedMilestones(0)).toEqual([]);
  expect(reachedMilestones(1)).toEqual([1]);
  expect(reachedMilestones(6)).toEqual([1]);
  expect(reachedMilestones(29)).toEqual([1, 7]);
  expect(reachedMilestones(30)).toEqual([1, 7, 30]);
  expect(reachedMilestones(100)).toEqual([...APPEARANCE_MILESTONES]);
  expect(reachedMilestones(101)).toEqual([...APPEARANCE_MILESTONES]);
  expect(reachedMilestones(-1)).toEqual([]);
});

it('reports only milestones actually crossed by a day range', () => {
  expect(crossedMilestones(0, 1)).toEqual([1]);
  expect(crossedMilestones(0, 0)).toEqual([]);
  expect(crossedMilestones(1, 7)).toEqual([7]);
  expect(crossedMilestones(6, 7)).toEqual([7]);
  expect(crossedMilestones(7, 30)).toEqual([30]);
  expect(crossedMilestones(0, 100)).toEqual([...APPEARANCE_MILESTONES]);
  expect(crossedMilestones(30, 7)).toEqual([]);
  expect(crossedMilestones(100, 101)).toEqual([]);
  expect(crossedMilestones(29, 60)).toEqual([30, 60]);
});

it('describes chat growth by cumulative and displayed stage days', () => {
  expect(chatProgress(3)).toMatchObject({
    subject: 'chat',
    cumulativeDays: 3,
    displayDays: 1,
    stage: 1,
    nextMilestone: 7,
    remainingDays: 4,
    max: false,
  });
  expect(chatProgress(3).copy.current).toBe('累計3日');
  expect(chatProgress(3).copy.stage).toBe('見た目：1日段階');
  expect(chatProgress(3).copy.next).toBe('次の7日段階まであと4日');
  expect(chatProgress(0)).toMatchObject({
    cumulativeDays: 0, displayDays: 0, stage: 0, nextMilestone: 1, remainingDays: 1, max: false,
  });
  expect(chatProgress(6)).toMatchObject({ stage: 1, nextMilestone: 7, remainingDays: 1 });
  expect(chatProgress(7)).toMatchObject({ stage: 7, nextMilestone: 30, remainingDays: 23 });
  expect(chatProgress(29)).toMatchObject({ cumulativeDays: 29, displayDays: 7, stage: 7, nextMilestone: 30, remainingDays: 1 });
  expect(chatProgress(30)).toMatchObject({ stage: 30, nextMilestone: 60, remainingDays: 30 });
  expect(chatProgress(59)).toMatchObject({ stage: 30, nextMilestone: 60, remainingDays: 1 });
  expect(chatProgress(60)).toMatchObject({ stage: 60, nextMilestone: 100, remainingDays: 40 });
  expect(chatProgress(99)).toMatchObject({ stage: 60, nextMilestone: 100, remainingDays: 1 });
});

it('treats 100+ chat days as complete without inventing a next milestone', () => {
  const hundred = chatProgress(100);
  expect(hundred).toMatchObject({
    cumulativeDays: 100, displayDays: 100, stage: 100, nextMilestone: null, remainingDays: 0, max: true,
  });
  expect(hundred.copy.next).toBe('最大段階に到達');
  expect(hundred.copy.stage).toBe('見た目：100日段階');

  const beyond = chatProgress(101);
  expect(beyond).toMatchObject({
    cumulativeDays: 101, displayDays: 100, stage: 100, nextMilestone: null, remainingDays: 0, max: true,
  });
  expect(beyond.copy.current).toBe('累計101日');
  expect(beyond.copy.next).toBe('最大段階に到達');
  expect(beyond).toEqual({ ...beyond, nextMilestone: null });
});

it('distinguishes the earned streak stage from the current streak', () => {
  const reset = streakProgress({ currentStreak: 0, earnedDays: 29 });
  expect(reset).toMatchObject({
    subject: 'streak',
    currentStreak: 0,
    earnedDays: 29,
    displayDays: 7,
    stage: 7,
    nextMilestone: 30,
    remainingDays: 30,
    max: false,
  });
  expect(reset.copy.stage).toBe('獲得済み：7日段階');
  expect(reset.copy.next).toBe('次の30日段階まであと30日');
  expect(reset.copy.stage).not.toContain('29日段階');

  const nearly = streakProgress({ currentStreak: 29, earnedDays: 29 });
  expect(nearly).toMatchObject({
    earnedDays: 29, displayDays: 7, stage: 7, nextMilestone: 30, remainingDays: 1, max: false,
  });
  expect(nearly.copy.stage).toBe('獲得済み：7日段階');
  expect(nearly.copy.next).toBe('次の30日段階まであと1日');

  const thirty = streakProgress({ currentStreak: 30, earnedDays: 30 });
  expect(thirty).toMatchObject({
    earnedDays: 30, displayDays: 30, stage: 30, nextMilestone: 60, remainingDays: 30, max: false,
  });
  expect(thirty.copy.stage).toBe('獲得済み：30日段階');
  expect(thirty.copy.next).toBe('次の60日段階まであと30日');
});

it('uses the next milestone and current streak for the streak remainder', () => {
  expect(streakProgress({ currentStreak: 0, earnedDays: 0 })).toMatchObject({
    stage: 0, displayDays: 0, nextMilestone: 1, remainingDays: 1, max: false,
  });
  expect(streakProgress({ currentStreak: 0, earnedDays: 0 }).copy.stage).toBe('獲得済み：0日段階');
  expect(streakProgress({ currentStreak: 1, earnedDays: 1 })).toMatchObject({
    stage: 1, nextMilestone: 7, remainingDays: 6,
  });
  expect(streakProgress({ currentStreak: 28, earnedDays: 29 })).toMatchObject({
    stage: 7, nextMilestone: 30, remainingDays: 2,
  });
  expect(streakProgress({ currentStreak: 40, earnedDays: 29 })).toMatchObject({
    stage: 7, nextMilestone: 30, remainingDays: 0,
  });
});

it('treats 100 earned days as maximum and keeps the current streak separate', () => {
  const maximum = streakProgress({ currentStreak: 5, earnedDays: 100 });
  expect(maximum).toMatchObject({
    currentStreak: 5, earnedDays: 100, displayDays: 100, stage: 100,
    nextMilestone: null, remainingDays: 0, max: true,
  });
  expect(maximum.copy.stage).toBe('獲得済み：100日段階');
  expect(maximum.copy.next).toBe('最大段階に到達');
  expect(maximum.copy.current).toBe('現在5日');
  const beyond = streakProgress({ currentStreak: 0, earnedDays: 250 });
  expect(beyond).toMatchObject({ earnedDays: 100, stage: 100, nextMilestone: null, max: true });
});

it('marks only reached milestones in the stage bar, never a daily fill', () => {
  const three = chatProgress(3);
  expect(three.bar.segments).toEqual([
    { milestone: 1, reached: true },
    { milestone: 7, reached: false },
    { milestone: 30, reached: false },
    { milestone: 60, reached: false },
    { milestone: 100, reached: false },
  ]);
  const twentyNine = chatProgress(29);
  expect(twentyNine.bar.segments.map((segment) => segment.reached)).toEqual([true, true, false, false, false]);
  expect(twentyNine.bar.stage).toBe(7);
  expect(chatProgress(0).bar.segments.map((segment) => segment.reached)).toEqual([false, false, false, false, false]);
  expect(chatProgress(100).bar.segments.map((segment) => segment.reached)).toEqual([true, true, true, true, true]);
  expect(streakProgress({ currentStreak: 0, earnedDays: 29 }).bar.segments.map((segment) => segment.reached))
    .toEqual([true, true, false, false, false]);
});

it('keeps stage bars monotonic as days grow', () => {
  let chatReached = 0;
  let streakReached = 0;
  for (let day = 0; day <= 110; day += 1) {
    const chat = chatProgress(day);
    const streak = streakProgress({ currentStreak: day, earnedDays: Math.min(day, 100) });
    const chatCount = chat.bar.segments.filter((segment) => segment.reached).length;
    const streakCount = streak.bar.segments.filter((segment) => segment.reached).length;
    expect(chatCount).toBeGreaterThanOrEqual(chatReached);
    expect(streakCount).toBeGreaterThanOrEqual(streakReached);
    expect(chat.bar.segments).toHaveLength(APPEARANCE_MILESTONES.length);
    expect(streak.bar.segments).toHaveLength(APPEARANCE_MILESTONES.length);
    for (const segment of chat.bar.segments) {
      expect(segment.reached).toBe(segment.milestone <= chat.stage);
    }
    for (const segment of streak.bar.segments) {
      expect(segment.reached).toBe(segment.milestone <= streak.stage);
    }
    chatReached = chatCount;
    streakReached = streakCount;
  }
});
