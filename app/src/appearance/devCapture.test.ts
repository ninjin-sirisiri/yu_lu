import { createCaptureController, parseCaptureCommand } from './devCapture';
import type { DevAppearancePreview } from './devPreview';

const conversation = '/conversations/8209a340-3083-4289-afbb-29c4d83cd024';

it('does not accept capture commands outside development builds', () => {
  expect(parseCaptureCommand('/home', { capturePreview: 'streak', captureDays: '100' }, false)).toBeNull();
  expect(parseCaptureCommand('/home', { capturePreview: 'restore' }, false)).toBeNull();
});

it('accepts only known appearance milestones and matching authenticated screen paths', () => {
  expect(parseCaptureCommand(conversation, { capturePreview: 'growth', captureDays: '7' }, true))
    .toEqual({ kind: 'growth', days: 7 });
  expect(parseCaptureCommand('/home', { capturePreview: 'streak', captureDays: '100', captureReset: '1' }, true))
    .toEqual({ kind: 'streak', days: 100, reset: true });
  for (const days of ['29', '-1', '101', '007', ['7'], undefined]) {
    expect(parseCaptureCommand(conversation, { capturePreview: 'growth', captureDays: days }, true)).toBeNull();
  }
  expect(parseCaptureCommand('/login', { capturePreview: 'streak', captureDays: '7' }, true)).toBeNull();
  expect(parseCaptureCommand('/home', { capturePreview: 'growth', captureDays: '7' }, true)).toBeNull();
});

it('changes each display independently and restores the original preview after a capture series', () => {
  const original = { streak: { currentStreak: 7, earnedDays: 30 }, growthDays: 60 };
  let current: DevAppearancePreview | null = original;
  const control = createCaptureController({ get: () => current, set: value => { current = value; } });
  control.apply({ kind: 'growth', days: 1 });
  expect(current).toEqual({ streak: original.streak, growthDays: 1 });
  control.apply({ kind: 'growth', days: 100 });
  control.apply({ kind: 'streak', days: 100, reset: true });
  expect(current).toEqual({ streak: { currentStreak: 0, earnedDays: 100 }, growthDays: 100 });
  control.apply({ kind: 'restore' });
  expect(current).toEqual(original);
  control.apply({ kind: 'restore' });
  expect(current).toEqual(original);
});

it('restores null rather than leaving a capture override active', () => {
  let current: DevAppearancePreview | null = null;
  const control = createCaptureController({ get: () => current, set: value => { current = value; } });
  control.apply({ kind: 'streak', days: 30, reset: false });
  control.apply({ kind: 'restore' });
  expect(current).toBeNull();
});
