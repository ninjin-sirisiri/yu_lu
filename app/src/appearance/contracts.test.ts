import type { SupabaseClient } from '@supabase/supabase-js';
import { createChatClient } from '../backend/chat';
import { A, page, message } from '../messages/repositoryTestSupport';
import {
  APPEARANCE_CATALOG_VERSION,
  APPEARANCE_PRESET_IDS,
  STREAK_APPEARANCE_VERSION,
  readChatAppearance,
  readStreakAppearance,
} from './contracts';

const chat = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  growth_days: 3,
  auto_preset_id: 'b-pop',
  selected_preset_id: null,
  effective_preset_id: 'b-pop',
  catalog_version: APPEARANCE_CATALOG_VERSION,
  settings_revision: 0,
  can_change: true,
  ...extra,
});
const streak = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  current_streak: 2,
  earned_days: 29,
  appearance_version: STREAK_APPEARANCE_VERSION,
  ...extra,
});
const invalid = { status: 'unavailable', reason: 'invalid' } as const;
const missing = { status: 'unavailable', reason: 'missing' } as const;
const unsupported = { status: 'unavailable', reason: 'unsupported_version' } as const;
const without = (raw: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...raw };
  delete copy[key];
  return copy;
};

it('reads canonical zero without turning an absent value into zero', () => {
  expect(readChatAppearance(chat({ growth_days: 0 }))).toEqual({
    status: 'ready',
    value: {
      growthDays: 0,
      autoPresetId: 'b-pop',
      selectedPresetId: null,
      effectivePresetId: 'b-pop',
      catalogVersion: 1,
      settingsRevision: 0,
      canChange: true,
    },
  });
  expect(readStreakAppearance(streak({ current_streak: 0, earned_days: 0 }))).toEqual({
    status: 'ready',
    value: { currentStreak: 0, earnedDays: 0, appearanceVersion: 1 },
  });
  expect(readChatAppearance(undefined)).toEqual(missing);
  expect(readChatAppearance(null)).toEqual(missing);
  expect(readStreakAppearance(undefined)).toEqual(missing);
  expect(readStreakAppearance(null)).toEqual(missing);
});

it('accepts true cumulative chat growth above 100 and earned-day boundaries', () => {
  expect(readChatAppearance(chat({ growth_days: 101 }))).toMatchObject({
    status: 'ready',
    value: { growthDays: 101 },
  });
  for (const earned of [0, 100]) {
    expect(readStreakAppearance(streak({ earned_days: earned }))).toMatchObject({
      status: 'ready',
      value: { earnedDays: earned },
    });
  }
});

it('accepts a null selection and every catalog preset in each preset slot', () => {
  for (const preset of APPEARANCE_PRESET_IDS) {
    expect(readChatAppearance(chat({
      auto_preset_id: preset,
      selected_preset_id: null,
      effective_preset_id: preset,
    }))).toMatchObject({
      status: 'ready',
      value: { autoPresetId: preset, selectedPresetId: null, effectivePresetId: preset },
    });
    expect(readChatAppearance(chat({
      selected_preset_id: preset,
      effective_preset_id: preset,
    }))).toMatchObject({
      status: 'ready',
      value: { selectedPresetId: preset, effectivePresetId: preset },
    });
  }
});

it('rejects a present appearance with any required field missing', () => {
  for (const key of Object.keys(chat())) {
    expect(readChatAppearance(without(chat(), key))).toEqual(invalid);
  }
  for (const key of Object.keys(streak())) {
    expect(readStreakAppearance(without(streak(), key))).toEqual(invalid);
  }
});

it('distinguishes malformed versions from unsupported ones', () => {
  for (const value of ['1', 1.5, NaN, Infinity, -1]) {
    expect(readChatAppearance(chat({ catalog_version: value }))).toEqual(invalid);
    expect(readStreakAppearance(streak({ appearance_version: value }))).toEqual(invalid);
  }
  for (const value of [0, 2, 99]) {
    expect(readChatAppearance(chat({ catalog_version: value }))).toEqual(unsupported);
    expect(readStreakAppearance(streak({ appearance_version: value }))).toEqual(unsupported);
  }
});

it('rejects unknown or mistyped preset IDs in every preset slot', () => {
  expect(readChatAppearance(chat({ auto_preset_id: 'b-glow' }))).toEqual(invalid);
  expect(readChatAppearance(chat({ selected_preset_id: 'b-glow', effective_preset_id: 'b-glow' }))).toEqual(invalid);
  expect(readChatAppearance(chat({ effective_preset_id: 'b-glow' }))).toEqual(invalid);
  expect(readChatAppearance(chat({ auto_preset_id: 1 }))).toEqual(invalid);
  expect(readChatAppearance(chat({ selected_preset_id: undefined }))).toEqual(invalid);
  expect(readChatAppearance(chat({ effective_preset_id: null }))).toEqual(invalid);
});

it('rejects wrong types and non-safe or negative counts', () => {
  for (const value of ['3', true, null, undefined, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(readChatAppearance(chat({ growth_days: value }))).toEqual(invalid);
    expect(readChatAppearance(chat({ settings_revision: value }))).toEqual(invalid);
    expect(readStreakAppearance(streak({ current_streak: value }))).toEqual(invalid);
  }
  for (const value of [-1, 101, 1.5, NaN, Infinity, '29']) {
    expect(readStreakAppearance(streak({ earned_days: value }))).toEqual(invalid);
  }
  for (const value of ['true', 1, null]) {
    expect(readChatAppearance(chat({ can_change: value }))).toEqual(invalid);
  }
});

it('rejects an effective preset that is not the selected preset or the automatic one', () => {
  expect(readChatAppearance(chat({ effective_preset_id: 'b-candy' }))).toEqual(invalid);
  expect(readChatAppearance(chat({ selected_preset_id: 'b-pop', effective_preset_id: 'b-soda' }))).toEqual(invalid);
  expect(readChatAppearance(chat({ auto_preset_id: 'b-soda', effective_preset_id: 'b-pop' }))).toEqual(invalid);
  expect(readChatAppearance(chat({
    auto_preset_id: 'b-soda',
    selected_preset_id: null,
    effective_preset_id: 'b-soda',
  }))).toMatchObject({ status: 'ready', value: { effectivePresetId: 'b-soda' } });
});

it('validates shared appearance and actor streak independently', () => {
  const brokenChat = chat({ growth_days: -1 });
  const goodStreak = streak();
  expect(readChatAppearance(brokenChat)).toEqual(invalid);
  expect(readStreakAppearance(goodStreak)).toMatchObject({ status: 'ready' });

  const goodChat = chat();
  const brokenStreak = streak({ earned_days: 101 });
  expect(readChatAppearance(goodChat)).toMatchObject({ status: 'ready' });
  expect(readStreakAppearance(brokenStreak)).toEqual(invalid);
});

function clientFor(result: unknown): SupabaseClient {
  return {
    auth: { getSession: async () => ({ data: { session: { user: { id: A }, access_token: 'test-token' } } }) },
    functions: {
      invoke: async (_name: string, options: any) => ({
        data: { op: options.body.op, result },
        error: null,
      }),
    },
  } as unknown as SupabaseClient;
}

it('keeps messages and peer data when appearance fields are broken', async () => {
  const broken = page([message(2), message(3)], {
    appearance: chat({ growth_days: -1 }) as never,
    streak_appearance: streak({ earned_days: 101 }) as never,
  });
  const api = createChatClient({ client: clientFor(broken), accountId: A });
  const resolved = await api.getMessages('10000000-0000-4000-8000-000000000002', 'latest');
  expect(resolved.items.map(item => item.body)).toEqual(['m2', 'm3']);
  expect(resolved.peer.display_name).toBe('Bob');
  expect(resolved.friendship_epoch).toBeTruthy();
  expect(readChatAppearance(resolved.appearance)).toEqual(invalid);
  expect(readStreakAppearance(resolved.streak_appearance)).toEqual(invalid);
});

it('keeps valid appearance values intact through the chat client', async () => {
  const api = createChatClient({ client: clientFor(page()), accountId: A });
  const resolved = await api.getMessages('10000000-0000-4000-8000-000000000002', 'latest');
  expect(readChatAppearance(resolved.appearance)).toMatchObject({
    status: 'ready',
    value: { growthDays: 3, selectedPresetId: null, settingsRevision: 0, canChange: true },
  });
  expect(readStreakAppearance(resolved.streak_appearance)).toMatchObject({
    status: 'ready',
    value: { currentStreak: 2, earnedDays: 29, appearanceVersion: 1 },
  });
});
