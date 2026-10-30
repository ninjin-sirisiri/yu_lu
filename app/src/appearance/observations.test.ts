import type { ChatAppearanceWire, StreakAppearanceWire } from './contracts';
import {
  conversationObservation,
  createAppearanceObservationStore,
  displayAppearance,
  homeObservation,
  type AppearanceObservation,
} from './observations';
import type { ChatMessagesResult } from '../backend/chat';
import { A, B, C, home, page, summary } from '../messages/repositoryTestSupport';

const owner = 7;
const meta = { accountId: A, owner, fetchedAt: 1_234 } as const;
const chatWire = (extra: Partial<ChatAppearanceWire> = {}): ChatAppearanceWire => ({
  growth_days: 3, auto_preset_id: 'b-pop', selected_preset_id: null, effective_preset_id: 'b-pop',
  catalog_version: 1, settings_revision: 0, can_change: true, ...extra,
});
const streakWire = (extra: Partial<StreakAppearanceWire> = {}): StreakAppearanceWire => ({
  current_streak: 2, earned_days: 29, appearance_version: 1, ...extra,
});
const detail = (extra: Partial<ChatMessagesResult> = {}) => page([], { revision: 1, ...extra });
const homeAt = (revision: number, extra: Parameters<typeof home>[0] = {}) =>
  home({ revision, streak_appearance: streakWire(), ...extra });
const conversationAt = (revision: number, extra: Partial<ChatMessagesResult> = {}) =>
  conversationObservation(detail({ revision, ...extra }), { ...meta, fetchedAt: 1_234 + revision });
const store = () => createAppearanceObservationStore({ accountId: A, owner, now: () => 9_999 });

it('builds a home observation and one same-revision conversation pair through the safe readers', () => {
  const homeValue = homeObservation(homeAt(5), meta);
  expect(homeValue).toMatchObject({
    accountId: A, owner, source: 'home', peerId: null, revision: 5, fetchedAt: 1_234,
  });
  expect(homeValue.personal).toEqual({
    status: 'ready', value: { currentStreak: 2, earnedDays: 29, appearanceVersion: 1 },
  });
  expect(homeValue.shared).toBeNull();

  const conversation = conversationObservation(detail({
    peer_id: B, revision: 8, appearance: chatWire({ growth_days: 11 }), streak_appearance: streakWire({ current_streak: 4 }),
  }), meta);
  expect(conversation).toMatchObject({
    accountId: A, owner, source: 'conversation', peerId: B, revision: 8, fetchedAt: 1_234,
  });
  expect(conversation.personal).toEqual({
    status: 'ready', value: { currentStreak: 4, earnedDays: 29, appearanceVersion: 1 },
  });
  expect(conversation.shared).toMatchObject({ status: 'ready', value: { growthDays: 11 } });
});

it('accepts canonical observations, rejects equal/older revisions and keeps revisions independent per subject', () => {
  const observations = store();
  expect(observations.accept(homeObservation(homeAt(5), meta))).toBe(true);
  expect(observations.accept(conversationAt(2))).toBe(true);
  expect(observations.accept(conversationAt(1, { peer_id: C }))).toBe(true);

  expect(observations.accept(conversationAt(2))).toBe(false);
  expect(observations.accept(conversationAt(1))).toBe(false);
  expect(observations.latest(`conversation:${B}`)?.revision).toBe(2);

  // A newer home revision is independent from an older conversation revision.
  expect(observations.accept(homeObservation(homeAt(6), meta))).toBe(true);
  expect(observations.latest('home')?.revision).toBe(6);
  expect(observations.latest(`conversation:${C}`)?.revision).toBe(1);
  expect(observations.list()).toHaveLength(3);
});

it('rejects account/owner mismatches, invalid owners, malformed subjects and every write after clear', () => {
  const observations = store();
  expect(observations.accept({ ...homeObservation(homeAt(1), meta), accountId: C })).toBe(false);
  expect(observations.accept({ ...homeObservation(homeAt(1), meta), owner: owner + 1 })).toBe(false);
  expect(observations.accept({ ...homeObservation(homeAt(1), meta), revision: -1 })).toBe(false);
  expect(observations.accept({ ...homeObservation(homeAt(1), meta), revision: 1.5 })).toBe(false);
  expect(observations.list()).toEqual([]);

  expect(observations.accept(homeObservation(homeAt(1), meta))).toBe(true);
  observations.clear();
  expect(observations.latest('home')).toBeNull();
  expect(observations.list()).toEqual([]);
  expect(observations.accept(homeObservation(homeAt(2), meta))).toBe(false);
  expect(observations.accept(conversationAt(2))).toBe(false);
});

it('never invents a conversation pair from home data, another peer subject or settings-only detail', () => {
  const observations = store();
  // Home targets can carry shared appearance, but a home observation is personal-only.
  expect(homeObservation(homeAt(1, { targets: [summary({ appearance: chatWire({ growth_days: 40 }) })] }), meta).shared).toBeNull();
  observations.accept(homeObservation(homeAt(1), meta));
  expect(observations.latest(`conversation:${B}`)).toBeNull();

  // Shape-inconsistent pairs are rejected instead of being split or merged.
  expect(observations.accept({ ...homeObservation(homeAt(2), meta), shared: { status: 'ready', value: {
    growthDays: 3, autoPresetId: 'b-pop', selectedPresetId: null, effectivePresetId: 'b-pop',
    catalogVersion: 1, settingsRevision: 0, canChange: true,
  } } })).toBe(false);
  expect(observations.accept({ ...conversationAt(3), shared: null })).toBe(false);
  expect(observations.accept({ ...conversationAt(3), peerId: null })).toBe(false);

  // An empty conversation is still only known from its detail response, not a list row.
  observations.accept(conversationAt(4, { peer_id: B, items: [] }));
  expect(observations.latest(`conversation:${B}`)).toMatchObject({ revision: 4, peerId: B });
  expect(observations.latest(`conversation:${C}`)).toBeNull();
});

it('reports checking for old-cache missing, invalid and unsupported reads without inventing zero', () => {
  const missing = homeObservation(home({ revision: 1, streak_appearance: undefined }), meta);
  const invalid = homeObservation(home({ revision: 2, streak_appearance: { ...streakWire(), current_streak: -1 } as never }), meta);
  const unsupported = homeObservation(home({ revision: 3, streak_appearance: { ...streakWire(), appearance_version: 2 } }), meta);
  const missingDetail = conversationObservation(detail({ appearance: undefined, streak_appearance: undefined }), meta);
  const invalidDetail = conversationObservation(detail({
    appearance: { ...chatWire(), growth_days: -1 } as never,
    streak_appearance: { ...streakWire(), earned_days: 101 } as never,
  }), meta);
  const unsupportedDetail = conversationObservation(detail({
    appearance: { ...chatWire(), catalog_version: 2 } as never,
  }), meta);

  for (const observation of [missing, invalid, unsupported, missingDetail, invalidDetail, unsupportedDetail]) {
    expect(displayAppearance(observation, null)).toEqual({ status: 'checking', value: null });
    expect(displayAppearance(null, observation)).toEqual({ status: 'checking', value: null });
  }
  expect(displayAppearance(missing, missing)).toEqual({ status: 'checking', value: null });
});

it('distinguishes cached-only display from a confirmed live pair and never merges a home personal value', () => {
  const cachedHome = homeObservation(homeAt(1), meta);
  const liveHome = homeObservation(homeAt(2, { streak_appearance: streakWire({ current_streak: 4 }) }), meta);
  expect(displayAppearance(liveHome, cachedHome)).toEqual({
    status: 'confirmed',
    value: { personal: { currentStreak: 4, earnedDays: 29, appearanceVersion: 1 }, shared: null },
  });
  expect(displayAppearance(null, cachedHome)).toEqual({
    status: 'cached',
    value: { personal: { currentStreak: 2, earnedDays: 29, appearanceVersion: 1 }, shared: null },
  });

  const cachedConversation = conversationAt(3);
  expect(displayAppearance(null, cachedConversation)).toEqual({
    status: 'cached',
    value: {
      personal: { currentStreak: 2, earnedDays: 29, appearanceVersion: 1 },
      shared: {
        growthDays: 3, autoPresetId: 'b-pop', selectedPresetId: null, effectivePresetId: 'b-pop',
        catalogVersion: 1, settingsRevision: 0, canChange: true,
      },
    },
  });

  // A live conversation whose shared read is unavailable cannot borrow the
  // home's personal value or the cached half; the pair remains checking.
  const liveDetail = conversationObservation(detail({ appearance: undefined }), meta);
  expect(displayAppearance(liveDetail, cachedHome)).toEqual({ status: 'checking', value: null });
  expect(displayAppearance(liveDetail, cachedConversation)).toMatchObject({ status: 'cached' });
});

it('notifies subscribers only for accepted state and can be handed out as a stable owner', () => {
  const observations = store();
  const seen: AppearanceObservation[][] = [];
  const unsubscribe = observations.subscribe(list => seen.push([...list]));
  expect(observations.owner).toBe(owner);
  observations.accept(homeObservation(homeAt(1), meta));
  observations.accept(homeObservation(homeAt(1), meta));
  expect(seen).toHaveLength(1);
  unsubscribe();
  observations.accept(conversationAt(1));
  expect(seen).toHaveLength(1);
  observations.clear();
  expect(seen).toHaveLength(1); // cleared after unsubscribing
});
