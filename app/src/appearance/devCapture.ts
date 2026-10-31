import { DEV_PREVIEW_STAGES, type DevAppearancePreview } from './devPreview';

type CaptureCommand = { kind: 'restore' } | { kind: 'growth'; days: number }
  | { kind: 'streak'; days: number; reset: boolean };

/** Only display values on existing screens; never changes authentication or achievements. */
export function parseCaptureCommand(path: string, params: Record<string, unknown>, development: boolean): CaptureCommand | null {
  if (!development) return null;
  const conversation = /^\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path);
  if (path !== '/home' && !conversation) return null;
  if (params.capturePreview === 'restore' && params.captureDays === undefined && params.captureReset === undefined) return { kind: 'restore' };
  if (typeof params.captureDays !== 'string' || !DEV_PREVIEW_STAGES.some(day => String(day) === params.captureDays)) return null;
  const days = Number(params.captureDays);
  if (params.capturePreview === 'growth' && conversation && params.captureReset === undefined) return { kind: 'growth', days };
  if (params.capturePreview === 'streak' && path === '/home' &&
      (params.captureReset === undefined || params.captureReset === '1')) {
    return { kind: 'streak', days, reset: params.captureReset === '1' };
  }
  return null;
}

export function createCaptureController(store: { get: () => DevAppearancePreview | null; set: (value: DevAppearancePreview | null) => void }) {
  let active = false;
  let original: DevAppearancePreview | null = null;
  return { apply(command: CaptureCommand) {
    if (command.kind === 'restore') {
      if (active) store.set(original);
      active = false;
      return;
    }
    if (!active) { original = store.get(); active = true; }
    const current = store.get() ?? { streak: null, growthDays: null };
    store.set(command.kind === 'growth' ? { ...current, growthDays: command.days }
      : { ...current, streak: { currentStreak: command.reset ? 0 : command.days, earnedDays: command.days } });
  } };
}
