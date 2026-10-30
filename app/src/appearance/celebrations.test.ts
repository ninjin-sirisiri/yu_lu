import type { AppearanceStage } from './catalog';
import {
  CELEBRATION_DURATION_MS,
  createCelebrationCoordinator,
  type CelebrationBaselineRequest,
  type CelebrationClock,
  type CelebrationConsumption,
  type CelebrationKind,
  type CelebrationLedgerRow,
  type CelebrationMode,
  type CelebrationPersistence,
  type CelebrationSettings,
  type CelebrationSnapshot,
  type CelebrationSyncInput,
  type CelebrationVisibility,
} from './celebrations';
import type { AppearanceObservation } from './observations';
import { highestMilestone } from './progress';

const ACCOUNT = 'account-a';
const OWNER = 4;
const PEER = 'peer-uuid-1';

interface SeedRow {
  kind: CelebrationKind;
  subjectId: string;
  baselineDays: number;
  consumedMilestone: AppearanceStage;
}

function subjectKey(kind: CelebrationKind, subjectId: string): string {
  return `${kind}\u0000${subjectId}`;
}

function seed(
  kind: CelebrationKind,
  subjectId: string,
  consumedMilestone: AppearanceStage,
  baselineDays: number = consumedMilestone,
): SeedRow {
  return { kind, subjectId, baselineDays, consumedMilestone };
}

function homeObservation(days: number, revision = 1, currentStreak = days): AppearanceObservation {
  return {
    accountId: ACCOUNT,
    owner: OWNER,
    source: 'home',
    peerId: null,
    revision,
    personal: {
      status: 'ready',
      value: { currentStreak, earnedDays: days, appearanceVersion: 1 },
    },
    shared: null,
    fetchedAt: revision,
  };
}

function conversationObservation(
  peerId: string,
  chatDays: number,
  streakDays: number,
  revision = 1,
  currentStreak = streakDays,
): AppearanceObservation {
  return {
    accountId: ACCOUNT,
    owner: OWNER,
    source: 'conversation',
    peerId,
    revision,
    personal: {
      status: 'ready',
      value: { currentStreak, earnedDays: streakDays, appearanceVersion: 1 },
    },
    shared: {
      status: 'ready',
      value: {
        growthDays: chatDays,
        autoPresetId: 'b-pop',
        selectedPresetId: null,
        effectivePresetId: 'b-pop',
        catalogVersion: 1,
        settingsRevision: 0,
        canChange: true,
      },
    },
    fetchedAt: revision,
  };
}

function unavailableHome(revision = 1): AppearanceObservation {
  return {
    ...homeObservation(0, revision),
    personal: { status: 'unavailable', reason: 'missing' },
  };
}

function unavailableConversation(peerId = PEER, revision = 1): AppearanceObservation {
  return {
    ...conversationObservation(peerId, 0, 0, revision),
    personal: { status: 'unavailable', reason: 'invalid' },
    shared: { status: 'unavailable', reason: 'unsupported_version' },
  };
}

function createFakePersistence(initial: readonly SeedRow[] = []) {
  const rows = new Map<string, CelebrationLedgerRow>();
  for (const row of initial) {
    rows.set(subjectKey(row.kind, row.subjectId), {
      baselineDays: row.baselineDays,
      consumedMilestone: row.consumedMilestone,
    });
  }

  const readCalls: Array<{ kind: CelebrationKind; subjectId: string }> = [];
  const baselineCalls: CelebrationBaselineRequest[] = [];
  const consumeCalls: CelebrationConsumption[][] = [];

  let failBaselineOnce = false;
  let failConsumeOnce = false;
  let readGate: Promise<void> | null = null;
  let consumeGate: Promise<void> | null = null;
  let signalRead: (() => void) | null = null;
  let signalConsume: (() => void) | null = null;
  const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
  const consumeStarted = new Promise<void>((resolve) => { signalConsume = resolve; });

  const port: CelebrationPersistence = {
    async read(kind, subjectId) {
      readCalls.push({ kind, subjectId });
      signalRead?.();
      signalRead = null;
      if (readGate) await readGate;
      return rows.get(subjectKey(kind, subjectId)) ?? null;
    },
    async baseline(input) {
      baselineCalls.push(input);
      if (failBaselineOnce) {
        failBaselineOnce = false;
        throw new Error('baseline failed');
      }
      const existing = rows.get(subjectKey(input.kind, input.subjectId));
      if (existing) return existing;
      const row: CelebrationLedgerRow = {
        baselineDays: Math.max(0, Math.floor(input.days)),
        consumedMilestone: highestMilestone(input.days),
      };
      rows.set(subjectKey(input.kind, input.subjectId), row);
      return row;
    },
    async consume(records, lifetime) {
      consumeCalls.push(records.map((record) => ({ ...record })));
      signalConsume?.();
      signalConsume = null;
      if (consumeGate) await consumeGate;
      if (failConsumeOnce) {
        failConsumeOnce = false;
        throw new Error('consume failed');
      }
      if (lifetime && !(await lifetime())) throw new Error('lifetime ended');
      for (const record of records) {
        const existing = rows.get(subjectKey(record.kind, record.subjectId));
        if (!existing) throw new Error('missing baseline');
        existing.consumedMilestone = Math.max(
          existing.consumedMilestone,
          record.milestone,
        ) as AppearanceStage;
      }
      return records.map((record) => rows.get(subjectKey(record.kind, record.subjectId))!);
    },
  };

  return {
    port,
    rows,
    readCalls,
    baselineCalls,
    consumeCalls,
    failBaselineOnce() { failBaselineOnce = true; },
    failConsumeOnce() { failConsumeOnce = true; },
    deferRead() {
      let release!: () => void;
      readGate = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
    deferConsume() {
      let release!: () => void;
      consumeGate = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
    waitForRead() { return readStarted; },
    waitForConsume() { return consumeStarted; },
  };
}

interface KindSettings {
  enabled: boolean;
  mode: CelebrationMode;
  generation: number;
}

function createFakeSettings(
  initial: Partial<Record<CelebrationKind, Partial<KindSettings>>> = {},
) {
  const state: { ready: boolean; chat: KindSettings; streak: KindSettings } = {
    ready: true,
    chat: { enabled: true, mode: 'animated', generation: 0, ...initial.chat },
    streak: { enabled: true, mode: 'animated', generation: 0, ...initial.streak },
  };
  let failStop = false;
  const stopKind = jest.fn(async (kind: CelebrationKind): Promise<void> => {
    state[kind] = { ...state[kind], enabled: false, mode: 'none' };
    if (failStop) throw new Error('stop save failed');
  });
  const port: CelebrationSettings = {
    ready: () => state.ready,
    mode: (kind) => state[kind].mode,
    enabled: (kind) => state[kind].enabled,
    resumeGeneration: (kind) => state[kind].generation,
    stopKind,
  };
  return {
    port,
    state,
    stopKind,
    failStop() { failStop = true; },
  };
}

function createFakeVisibility(initial: Partial<CelebrationVisibility> = {}) {
  const state: CelebrationVisibility = {
    visible: true,
    foreground: true,
    authCurrent: true,
    importantConfirmation: false,
    activePeerId: null,
    ...initial,
  };
  return {
    state,
    read: () => ({ ...state }),
    set(patch: Partial<CelebrationVisibility>) { Object.assign(state, patch); },
  };
}

function createFakeClock() {
  let current = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: CelebrationClock = {
    now: () => current,
    setTimeout(callback, delayMs) {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { at: current + delayMs, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    advance(ms: number) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        const [handle, timer] = due;
        timers.delete(handle);
        current = timer.at;
        timer.callback();
      }
      current = target;
    },
    get pending() { return timers.size; },
    get scheduledDelays() {
      return [...timers.values()].map((timer) => timer.at - current);
    },
  };
}

function createHarness(options: {
  seed?: readonly SeedRow[];
  settings?: Parameters<typeof createFakeSettings>[0];
  visibility?: Partial<CelebrationVisibility>;
} = {}) {
  const persistence = createFakePersistence(options.seed);
  const settings = createFakeSettings(options.settings);
  const visibility = createFakeVisibility(options.visibility);
  const clock = createFakeClock();
  const snapshots: CelebrationSnapshot[] = [];
  const coordinator = createCelebrationCoordinator({
    persistence: persistence.port,
    settings: settings.port,
    visibility: visibility.read,
    clock: clock.clock,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  return { coordinator, persistence, settings, visibility, clock, snapshots };
}

function input(overrides: Partial<CelebrationSyncInput> = {}): CelebrationSyncInput {
  return { home: null, conversation: null, ...overrides };
}

describe('first baseline and milestone selection', () => {
  it('baselines an initial 0 and an initial 100 without playback', async () => {
    const zero = createHarness();
    await zero.coordinator.sync(input({ home: homeObservation(0) }));
    expect(zero.persistence.baselineCalls).toHaveLength(1);
    expect(zero.persistence.baselineCalls[0]).toMatchObject({
      kind: 'streak', subjectId: 'self', days: 0,
    });
    expect(zero.persistence.consumeCalls).toHaveLength(0);
    expect(zero.coordinator.getSnapshot()).toMatchObject({
      status: 'idle', current: null, batch: [], choice: null,
    });

    const hundred = createHarness({ visibility: { activePeerId: PEER } });
    await hundred.coordinator.sync(input({
      conversation: conversationObservation(PEER, 100, 100),
    }));
    expect(hundred.persistence.baselineCalls.map((call) => [call.kind, call.subjectId, call.days])).toEqual([
      ['chat', PEER, 100],
      ['streak', 'self', 100],
    ]);
    expect(hundred.persistence.consumeCalls).toHaveLength(0);
    expect(hundred.coordinator.getSnapshot().status).toBe('idle');

    const beyond = createHarness({ visibility: { activePeerId: PEER } });
    await beyond.coordinator.sync(input({
      conversation: conversationObservation(PEER, 101, 100),
    }));
    expect(beyond.persistence.baselineCalls.map((call) => [call.kind, call.days])).toEqual([
      ['chat', 101],
      ['streak', 100],
    ]);
    expect(beyond.persistence.consumeCalls).toHaveLength(0);
  });

  it('keeps one chat ledger subject per peer UUID across revisions', async () => {
    const h = createHarness({ visibility: { activePeerId: PEER } });
    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 0, 0, 1) }));
    expect(h.persistence.baselineCalls.filter((call) => call.kind === 'chat')).toHaveLength(1);

    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 3, 0, 2) }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'chat', subjectId: PEER, milestone: 1, days: 3,
    });
    h.coordinator.finishCurrent();

    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 7, 0, 3) }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'chat', subjectId: PEER, milestone: 7, days: 7,
    });
    h.coordinator.finishCurrent();

    expect(h.persistence.baselineCalls.filter((call) => call.kind === 'chat')).toHaveLength(1);
    expect(h.persistence.baselineCalls.find((call) => call.kind === 'chat')?.subjectId).toBe(PEER);
    expect(h.persistence.consumeCalls.map((records) => records[0]?.milestone)).toEqual([1, 7]);
  });

  it('only selects milestones and catches up to the highest one reached', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 3, 0, 1) }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'chat', milestone: 1, days: 3,
    });
    h.coordinator.finishCurrent();

    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 14, 0, 2) }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'chat', milestone: 7, days: 14,
    });
    h.coordinator.finishCurrent();

    const milestones = h.persistence.consumeCalls.flatMap((records) =>
      records.map((record) => record.milestone));
    expect(milestones).toEqual([1, 7]);
    expect(milestones).not.toContain(3);
    expect(milestones).not.toContain(14);
  });

  it('adds no candidate for 3 or 14 once 1 and 7 are consumed', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 7), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 3, 0, 1) }));
    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 14, 0, 2) }));
    expect(h.persistence.consumeCalls).toHaveLength(0);
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'idle', current: null });
  });

  it('selects only the highest milestone when 29 grows to 60', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 7, 29), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 60, 0, 2) }));
    expect(h.coordinator.getSnapshot().batch).toHaveLength(1);
    expect(h.coordinator.getSnapshot().current).toMatchObject({ milestone: 60, days: 60 });
    expect(h.persistence.consumeCalls).toHaveLength(1);
    expect(h.persistence.consumeCalls[0]).toEqual([
      { kind: 'chat', subjectId: PEER, milestone: 60 },
    ]);
  });

  it('plays at most two items, chat then streak, saved in one consume call', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 30, 29, 1, 0),
    }));
    const snapshot = h.coordinator.getSnapshot();
    expect(snapshot.status).toBe('playing');
    expect(snapshot.batch.map((item) => [item.kind, item.milestone, item.days])).toEqual([
      ['chat', 30, 30],
      ['streak', 7, 29],
    ]);
    expect(snapshot.current).toMatchObject({ kind: 'chat' });
    expect(h.persistence.consumeCalls).toHaveLength(1);
    expect(h.persistence.consumeCalls[0]).toEqual([
      { kind: 'chat', subjectId: PEER, milestone: 30 },
      { kind: 'streak', subjectId: 'self', milestone: 7 },
    ]);
    h.coordinator.finishCurrent();
    expect(h.coordinator.getSnapshot().current).toMatchObject({ kind: 'streak', milestone: 7 });
    h.coordinator.finishCurrent();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'ended', current: null, batch: [], choice: null,
    });
  });

  it('uses confirmed earned days, not the displayed stage, for the personal ledger', async () => {
    const h = createHarness({ seed: [seed('streak', 'self', 0)] });
    await h.coordinator.sync(input({ home: homeObservation(29, 1, 0) }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'streak', days: 29, milestone: 7,
    });
    h.coordinator.finishCurrent();

    await h.coordinator.sync(input({ home: homeObservation(29, 2, 0) }));
    expect(h.persistence.consumeCalls).toHaveLength(1);
    expect(h.persistence.consumeCalls[0]).toEqual([
      { kind: 'streak', subjectId: 'self', milestone: 7 },
    ]);
  });

  it('selects 100 once and nothing at 101', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 60, 60), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 100, 0, 1) }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({ milestone: 100, days: 100 });
    h.coordinator.finishCurrent();

    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 101, 0, 2) }));
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'idle', current: null });
    expect(h.persistence.consumeCalls.flatMap((records) =>
      records.map((record) => record.milestone))).toEqual([100]);
  });
});

describe('saving, cancellation and stale data', () => {
  it('waits for the single consume call before playing', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    const release = h.persistence.deferConsume();
    const pending = h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 0, 1),
    }));
    await h.persistence.waitForConsume();
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'saving', current: null });
    expect(h.coordinator.getSnapshot().batch).toHaveLength(1);
    expect(h.clock.pending).toBe(0);
    release();
    await pending;
    expect(h.coordinator.getSnapshot().status).toBe('playing');
    expect(h.coordinator.getSnapshot().current).toMatchObject({ kind: 'chat', milestone: 7 });
    expect(h.clock.scheduledDelays).toEqual([CELEBRATION_DURATION_MS]);
  });

  it('does not alter a pending batch when a newer observation arrives during saving', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    const release = h.persistence.deferConsume();
    const pending = h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 0, 1),
    }));
    await h.persistence.waitForConsume();
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 30, 60, 2),
    }));
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'saving' });
    expect(h.coordinator.getSnapshot().batch).toHaveLength(1);
    release();
    await pending;
    expect(h.coordinator.getSnapshot().current).toMatchObject({ kind: 'chat', milestone: 7 });
    expect(h.persistence.consumeCalls).toHaveLength(1);
  });

  it('does not play either item when the consume fails and leaves both unconsumed', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    h.persistence.failConsumeOnce();
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    expect(h.persistence.consumeCalls).toHaveLength(1);
    expect(h.persistence.consumeCalls[0]).toHaveLength(2);
    const snapshot = h.coordinator.getSnapshot();
    expect(snapshot).toMatchObject({ status: 'idle', current: null, batch: [], choice: null });
    expect(snapshot.error).toBeTruthy();
    expect(h.persistence.rows.get(subjectKey('chat', PEER))).toMatchObject({ consumedMilestone: 0 });
    expect(h.persistence.rows.get(subjectKey('streak', 'self'))).toMatchObject({ consumedMilestone: 0 });
    expect(h.clock.pending).toBe(0);
  });

  it('does not play after leave and keeps the consumed batch from replaying', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    const release = h.persistence.deferConsume();
    const pending = h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 0, 1),
    }));
    await h.persistence.waitForConsume();
    h.coordinator.leave();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'ended', current: null, batch: [], choice: null,
    });
    release();
    await pending;
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'ended', current: null });
    expect(h.persistence.rows.get(subjectKey('chat', PEER))).toMatchObject({ consumedMilestone: 7 });
    expect(h.clock.pending).toBe(0);

    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 0, 1),
    }));
    expect(h.persistence.consumeCalls).toHaveLength(1);
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'idle', current: null });
  });

  const saveInterruptions: Array<[string, Partial<CelebrationVisibility>]> = [
    ['background', { foreground: false }],
    ['auth loss', { authCurrent: false }],
  ];

  it.each(saveInterruptions)(
    'does not play when %s happens after the save starts',
    async (_name, patch) => {
      const h = createHarness({
        seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
        visibility: { activePeerId: PEER },
      });
      const release = h.persistence.deferConsume();
      const pending = h.coordinator.sync(input({
        conversation: conversationObservation(PEER, 7, 0, 1),
      }));
      await h.persistence.waitForConsume();
      h.visibility.set(patch);
      await h.coordinator.sync(input({
        conversation: conversationObservation(PEER, 7, 0, 1),
      }));
      release();
      await pending;
      expect(h.coordinator.getSnapshot()).toMatchObject({
        status: 'ended', current: null, batch: [],
      });
      expect(h.persistence.rows.get(subjectKey('chat', PEER))).toMatchObject({
        consumedMilestone: 7,
      });
      expect(h.clock.pending).toBe(0);
    },
  );

  it('ignores a synchronization whose lifetime ended while it was reading', async () => {
    const h = createHarness();
    let alive = true;
    const release = h.persistence.deferRead();
    const pending = h.coordinator.sync(input({
      home: homeObservation(30),
      lifetime: () => alive,
    }));
    await h.persistence.waitForRead();
    alive = false;
    release();
    await pending;
    expect(h.persistence.baselineCalls).toHaveLength(0);
    expect(h.persistence.consumeCalls).toHaveLength(0);
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'idle', current: null });
  });

  it('ignores stale revisions and stale caller generations', async () => {
    const h = createHarness();
    await h.coordinator.sync(input({ home: homeObservation(0, 5), generation: 2 }));
    expect(h.persistence.baselineCalls).toHaveLength(1);

    await h.coordinator.sync(input({ home: homeObservation(30, 4), generation: 3 }));
    expect(h.persistence.consumeCalls).toHaveLength(0);
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'idle', current: null });

    await h.coordinator.sync(input({ home: homeObservation(30, 6), generation: 1 }));
    expect(h.persistence.consumeCalls).toHaveLength(0);
  });
});

describe('suppression and stop generations', () => {
  it('baselines and suppresses while subtle, then resumes without replaying the current milestone', async () => {
    const h = createHarness({ settings: { streak: { mode: 'none' } } });
    await h.coordinator.sync(input({ home: homeObservation(30, 1) }));
    expect(h.persistence.baselineCalls).toHaveLength(1);
    expect(h.persistence.baselineCalls[0]).toMatchObject({ kind: 'streak', days: 30 });
    expect(h.persistence.consumeCalls).toHaveLength(0);
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'idle', current: null });

    h.settings.state.streak.mode = 'animated';
    await h.coordinator.sync(input({ home: homeObservation(30, 2) }));
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'idle', current: null });

    await h.coordinator.sync(input({ home: homeObservation(60, 3) }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'streak', milestone: 60, days: 60,
    });
  });

  it('suppresses the first sync after a disabled kind is re-enabled, then plays a later milestone', async () => {
    const h = createHarness({
      seed: [seed('streak', 'self', 0)],
      settings: { chat: { enabled: false, mode: 'none', generation: 3 } },
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 30, 0, 1),
    }));
    expect(h.persistence.baselineCalls.find((call) => call.kind === 'chat')).toMatchObject({
      days: 30,
    });
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'idle', current: null });

    h.settings.state.chat = { enabled: true, mode: 'animated', generation: 4 };
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 60, 0, 2),
    }));
    expect(h.persistence.consumeCalls).toHaveLength(1);
    expect(h.persistence.consumeCalls[0]).toEqual([
      { kind: 'chat', subjectId: PEER, milestone: 60 },
    ]);
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'idle', current: null });

    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 100, 0, 3),
    }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'chat', milestone: 100, days: 100,
    });
  });

  it('does not consume a chat that was only updated in a list', async () => {
    const h = createHarness({
      seed: [seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 0, 0, 1) }));
    expect(h.persistence.baselineCalls.filter((call) => call.kind === 'chat')).toHaveLength(1);

    h.visibility.set({ activePeerId: null });
    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 14, 0, 2) }));
    expect(h.persistence.consumeCalls).toHaveLength(0);

    h.visibility.set({ activePeerId: PEER });
    await h.coordinator.sync(input({ conversation: conversationObservation(PEER, 14, 0, 2) }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'chat', milestone: 7, days: 14,
    });
    expect(h.persistence.baselineCalls.filter((call) => call.kind === 'chat')).toHaveLength(1);
  });

  it('does nothing for cache-only or unavailable observations', async () => {
    const h = createHarness({ visibility: { activePeerId: PEER } });
    await h.coordinator.sync(input({
      home: unavailableHome(),
      conversation: unavailableConversation(PEER),
    }));
    expect(h.persistence.readCalls).toHaveLength(0);
    expect(h.persistence.baselineCalls).toHaveLength(0);
    expect(h.persistence.consumeCalls).toHaveLength(0);
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'idle', current: null, batch: [],
    });
  });

  it('suppresses current milestones while an important confirmation is active', async () => {
    const h = createHarness({
      visibility: { activePeerId: PEER, importantConfirmation: true },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    expect(h.persistence.baselineCalls).toHaveLength(2);
    expect(h.persistence.consumeCalls).toHaveLength(0);
    expect(h.coordinator.getSnapshot().status).toBe('idle');

    h.visibility.set({ importantConfirmation: false });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    expect(h.persistence.consumeCalls).toHaveLength(0);
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'idle', current: null });

    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 30, 7, 2),
    }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'chat', milestone: 30, days: 30,
    });
  });

  it('uses only the conversation pair for personal while a conversation is displayed', async () => {
    const h = createHarness({ visibility: { activePeerId: PEER } });
    await h.coordinator.sync(input({ home: homeObservation(30, 1) }));
    expect(h.persistence.baselineCalls).toHaveLength(0);
    expect(h.persistence.consumeCalls).toHaveLength(0);

    await h.coordinator.sync(input({
      home: homeObservation(100, 2),
      conversation: conversationObservation(PEER, 0, 0, 1),
    }));
    expect(h.persistence.baselineCalls.map((call) => [call.kind, call.days])).toEqual([
      ['chat', 0],
      ['streak', 0],
    ]);
    expect(h.persistence.consumeCalls).toHaveLength(0);
    expect(h.coordinator.getSnapshot().status).toBe('idle');

    await h.coordinator.sync(input({
      home: homeObservation(100, 3),
      conversation: conversationObservation(PEER, 0, 30, 2),
    }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'streak', days: 30, milestone: 30,
    });
  });

  it('does nothing until device settings are ready', async () => {
    const h = createHarness();
    h.settings.state.ready = false;
    await h.coordinator.sync(input({ home: homeObservation(30) }));
    expect(h.persistence.readCalls).toHaveLength(0);
    expect(h.persistence.baselineCalls).toHaveLength(0);

    h.settings.state.ready = true;
    await h.coordinator.sync(input({ home: homeObservation(30) }));
    expect(h.persistence.baselineCalls).toHaveLength(1);
    expect(h.persistence.baselineCalls[0]).toMatchObject({ days: 30 });
  });

  it('does not play when a baseline cannot be persisted', async () => {
    const h = createHarness({ visibility: { activePeerId: PEER } });
    h.persistence.failBaselineOnce();
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'idle', current: null, batch: [],
    });
    expect(h.coordinator.getSnapshot().error).toBeTruthy();
    expect(h.persistence.consumeCalls).toHaveLength(0);
  });
});

describe('skip, choice and leaving', () => {
  it('skips only the current item and waits for a non-modal choice', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({ kind: 'chat' });
    h.coordinator.skip();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'choice',
      current: null,
      choice: { kind: 'chat', nextKind: 'streak' },
    });
    expect(h.clock.pending).toBe(0);
    h.clock.advance(60_000);
    expect(h.coordinator.getSnapshot().status).toBe('choice');

    await h.coordinator.choose('once');
    expect(h.coordinator.getSnapshot().status).toBe('playing');
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'streak', milestone: 7,
    });
    expect(h.persistence.consumeCalls).toHaveLength(1);
    h.coordinator.finishCurrent();
    expect(h.coordinator.getSnapshot().status).toBe('ended');
  });

  it('stops the current kind and continues with the next enabled kind', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    h.coordinator.skip();
    await h.coordinator.choose('stop');
    expect(h.settings.stopKind).toHaveBeenCalledWith('chat');
    expect(h.settings.state.chat.mode).toBe('none');
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'playing', current: { kind: 'streak' }, error: null,
    });
    expect(h.persistence.consumeCalls).toHaveLength(1);
    h.coordinator.finishCurrent();
    expect(h.coordinator.getSnapshot().status).toBe('ended');
  });

  it('surfaces a stop-save failure without replaying the current kind', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    h.settings.failStop();
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    h.coordinator.skip();
    await h.coordinator.choose('stop');
    expect(h.settings.stopKind).toHaveBeenCalledWith('chat');
    const snapshot = h.coordinator.getSnapshot();
    expect(snapshot.status).toBe('playing');
    expect(snapshot.current?.kind).toBe('streak');
    expect(snapshot.error).toBeTruthy();
    expect(h.persistence.consumeCalls).toHaveLength(1);
    expect(h.clock.pending).toBe(1);
  });

  it('does not replace a pending choice with newer observations', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    h.coordinator.skip();
    const before = h.coordinator.getSnapshot();
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 30, 60, 2),
    }));
    const after = h.coordinator.getSnapshot();
    expect(after.status).toBe('choice');
    expect(after.choice).toEqual(before.choice);
    expect(after.batch).toEqual(before.batch);
    expect(h.persistence.consumeCalls).toHaveLength(1);

    await h.coordinator.choose('once');
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'streak', days: 7, milestone: 7,
    });
    h.coordinator.finishCurrent();
    expect(h.coordinator.getSnapshot().status).toBe('ended');

    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 30, 60, 2),
    }));
    expect(h.coordinator.getSnapshot().batch.map((item) => [item.kind, item.milestone])).toEqual([
      ['chat', 30],
      ['streak', 60],
    ]);
  });

  it('ends playback and never replays consumed items on leave', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    h.coordinator.leave();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'ended', current: null, batch: [], choice: null,
    });
    expect(h.clock.pending).toBe(0);
    h.clock.advance(CELEBRATION_DURATION_MS * 2);
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'ended', current: null });

    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    expect(h.persistence.consumeCalls).toHaveLength(1);
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'idle', current: null });
  });

  it('ends a choice and ignores a later choose after leave', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    h.coordinator.skip();
    h.coordinator.leave();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'ended', current: null, batch: [], choice: null,
    });
    await h.coordinator.choose('once');
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'ended', current: null, batch: [],
    });
    expect(h.clock.pending).toBe(0);
  });

  const interruptions: Array<[string, Partial<CelebrationVisibility>]> = [
    ['background', { foreground: false }],
    ['logout', { authCurrent: false }],
    ['an important confirmation', { importantConfirmation: true }],
  ];

  it.each(interruptions)('ends playback when %s occurs', async (_name, patch) => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    expect(h.coordinator.getSnapshot().status).toBe('playing');
    h.visibility.set(patch);
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'ended', current: null, batch: [],
    });
    expect(h.clock.pending).toBe(0);
  });
});

describe('presentation and queue limits', () => {
  it('plays a static item when motion is reduced', async () => {
    const h = createHarness({
      seed: [seed('streak', 'self', 0)],
      settings: { streak: { mode: 'static' } },
    });
    await h.coordinator.sync(input({ home: homeObservation(30, 1) }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'streak',
      milestone: 30,
      days: 30,
      mode: 'static',
      durationMs: CELEBRATION_DURATION_MS,
    });
    expect(h.persistence.consumeCalls).toHaveLength(1);
  });

  it('advances each item after about two seconds', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 7, 1),
    }));
    expect(h.clock.scheduledDelays).toEqual([CELEBRATION_DURATION_MS]);
    h.clock.advance(CELEBRATION_DURATION_MS - 1);
    expect(h.coordinator.getSnapshot().current?.kind).toBe('chat');
    h.clock.advance(1);
    expect(h.coordinator.getSnapshot().current?.kind).toBe('streak');
    expect(h.clock.scheduledDelays).toEqual([CELEBRATION_DURATION_MS]);
    h.clock.advance(CELEBRATION_DURATION_MS);
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'ended', current: null });
  });

  it('does not grow a queue while playing and re-evaluates afterwards', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0), seed('streak', 'self', 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 0, 1),
    }));
    expect(h.coordinator.getSnapshot().current).toMatchObject({ kind: 'chat', milestone: 7 });

    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 30, 60, 2),
    }));
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 30, 60, 2),
    }));
    expect(h.persistence.consumeCalls).toHaveLength(1);
    expect(h.coordinator.getSnapshot().status).toBe('playing');

    h.coordinator.finishCurrent();
    expect(h.coordinator.getSnapshot().status).toBe('ended');
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 30, 60, 2),
    }));
    expect(h.persistence.consumeCalls).toHaveLength(2);
    expect(h.coordinator.getSnapshot().batch.map((item) => [item.kind, item.milestone])).toEqual([
      ['chat', 30],
      ['streak', 60],
    ]);
    expect(h.coordinator.getSnapshot().current).toMatchObject({
      kind: 'chat', milestone: 30,
    });
  });
});

describe('snapshot lifecycle', () => {
  it('publishes readable snapshots to subscribers until unsubscribed', async () => {
    const h = createHarness();
    const listener = jest.fn();
    const unsubscribe = h.coordinator.subscribe(listener);
    await h.coordinator.sync(input({ home: homeObservation(0) }));
    expect(listener).toHaveBeenCalled();
    const calls = listener.mock.calls as Array<[CelebrationSnapshot]>;
    expect(calls[calls.length - 1][0].status).toBe('idle');
    expect(h.snapshots.length).toBeGreaterThan(0);

    unsubscribe();
    const count = listener.mock.calls.length;
    await h.coordinator.sync(input({ home: homeObservation(0, 2) }));
    expect(listener).toHaveBeenCalledTimes(count);
  });

  it('stops the coordinator and ignores later synchronizations', async () => {
    const h = createHarness({
      seed: [seed('chat', PEER, 0)],
      visibility: { activePeerId: PEER },
    });
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 7, 0, 1),
    }));
    h.coordinator.stop();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'ended', current: null, batch: [],
    });
    const reads = h.persistence.readCalls.length;
    await h.coordinator.sync(input({
      conversation: conversationObservation(PEER, 30, 0, 2),
    }));
    expect(h.persistence.readCalls).toHaveLength(reads);
    expect(h.coordinator.getSnapshot().status).toBe('ended');
  });
});
