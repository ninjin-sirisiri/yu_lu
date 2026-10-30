import {
  APPEARANCE_MILESTONES,
  type AppearanceMilestone,
  type AppearanceStage,
} from './catalog';
import type { AppearanceObservation } from './observations';
import { highestMilestone } from './progress';

/**
 * Task 13: the pure/injectable celebration coordinator.
 *
 * The coordinator owns only the decision state machine:
 *
 *   idle -> saving -> playing -> choice (after skip) -> playing -> ended
 *
 * It never talks to SQLite, React, the network or timers directly. Task 14
 * supplies the visibility/settings adapters and a CelebrationHost; tests
 * supply a deterministic clock and fake ports.
 *
 * The ledger remains deliberately minimal: a kind ('chat'/'streak'), an
 * internal subject (the peer UUID or the literal 'self'), a first baseline and
 * the highest consumed milestone. Names, bodies, User ID text and achievement
 * breakdowns are never passed to the persistence port.
 */

export type CelebrationKind = 'chat' | 'streak';
export type CelebrationMode = 'animated' | 'static' | 'none';
export type CelebrationPresentation = Exclude<CelebrationMode, 'none'>;
export type CelebrationStatus = 'idle' | 'saving' | 'playing' | 'choice' | 'ended';

/** One item is shown for about two seconds; two items are about four seconds. */
export const CELEBRATION_DURATION_MS = 2000;

export interface CelebrationItem {
  readonly kind: CelebrationKind;
  readonly subjectId: string;
  readonly milestone: AppearanceMilestone;
  /** The confirmed raw day count. 14 days is the 7-day milestone with days 14. */
  readonly days: number;
  readonly mode: CelebrationPresentation;
  readonly durationMs: typeof CELEBRATION_DURATION_MS;
}

export interface CelebrationChoice {
  readonly kind: CelebrationKind;
  readonly nextKind: CelebrationKind | null;
}

/** A readable snapshot for the host. Task 14 renders this and never mutates it. */
export interface CelebrationSnapshot {
  readonly status: CelebrationStatus;
  readonly current: CelebrationItem | null;
  readonly batch: readonly CelebrationItem[];
  readonly error: string | null;
  readonly choice: CelebrationChoice | null;
}

export interface CelebrationLedgerRow {
  baselineDays: number;
  consumedMilestone: AppearanceStage;
}

export type CelebrationLifetime = () => boolean | Promise<boolean>;

export interface CelebrationBaselineRequest {
  kind: CelebrationKind;
  subjectId: string;
  days: number;
  lifetime?: CelebrationLifetime;
}

export interface CelebrationConsumption {
  kind: CelebrationKind;
  subjectId: string;
  milestone: AppearanceMilestone;
}

/**
 * Persistence is bound to one authenticated account by the adapter (Task 14).
 * The coordinator only ever supplies kind + internal subject + milestone.
 */
export interface CelebrationPersistence {
  read(kind: CelebrationKind, subjectId: string): Promise<CelebrationLedgerRow | null>;
  baseline(input: CelebrationBaselineRequest): Promise<CelebrationLedgerRow>;
  consume(
    records: readonly CelebrationConsumption[],
    lifetime?: CelebrationLifetime,
  ): Promise<readonly CelebrationLedgerRow[]>;
}

export interface CelebrationSettings {
  /** False while the device setting is still loading or unavailable. */
  ready(): boolean;
  mode(kind: CelebrationKind): CelebrationMode;
  enabled(kind: CelebrationKind): boolean;
  resumeGeneration(kind: CelebrationKind): number;
  /** In-memory stop is already applied by the provider; this persists it. */
  stopKind(kind: CelebrationKind): Promise<void> | void;
}

export interface CelebrationVisibility {
  visible: boolean;
  foreground: boolean;
  authCurrent: boolean;
  importantConfirmation: boolean;
  /** The conversation detail actually displayed, not just a selected list row. */
  activePeerId: string | null;
}

export interface CelebrationClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CelebrationSyncInput {
  /** The latest canonical home observation, or null. Never a display cache. */
  home: AppearanceObservation | null;
  /** The latest canonical conversation detail pair, or null. */
  conversation: AppearanceObservation | null;
  /** Optional route hint; actual display still requires visibility.activePeerId. */
  activePeerId?: string | null;
  /** Checked before and after every write and again before playback. */
  lifetime?: CelebrationLifetime;
  /** Optional monotonic caller token; older tokens are ignored. */
  generation?: number;
}

export interface CelebrationCoordinatorOptions {
  persistence: CelebrationPersistence;
  settings: CelebrationSettings;
  visibility: () => CelebrationVisibility;
  clock?: CelebrationClock;
  onSnapshot?: (snapshot: CelebrationSnapshot) => void;
}

export interface CelebrationCoordinator {
  sync(input: CelebrationSyncInput): Promise<void>;
  finishCurrent(): void;
  skip(): void;
  choose(choice: 'once' | 'stop'): Promise<void>;
  leave(): void;
  getSnapshot(): CelebrationSnapshot;
  subscribe(listener: (snapshot: CelebrationSnapshot) => void): () => void;
  stop(): void;
}

const SYSTEM_CLOCK: CelebrationClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface KindContext {
  mode: CelebrationMode;
  presentation: CelebrationPresentation;
  generation: number;
}

interface BatchContext {
  /** null for a main-screen batch; the displayed peer UUID otherwise. */
  peerId: string | null;
}

interface SubjectRequest {
  kind: CelebrationKind;
  subjectId: string;
  days: number;
}

function isMilestone(value: number): value is AppearanceMilestone {
  return (APPEARANCE_MILESTONES as readonly number[]).includes(value);
}

function ledgerKey(kind: CelebrationKind, subjectId: string): string {
  return `${kind}\u0000${subjectId}`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return '演出記録を保存できませんでした。';
}

function isPresent(visibility: CelebrationVisibility): boolean {
  return visibility.visible && visibility.foreground && visibility.authCurrent;
}

function isActive(status: CelebrationStatus): boolean {
  return status === 'saving' || status === 'playing' || status === 'choice';
}

function isCanonicalBase(observation: AppearanceObservation): boolean {
  return typeof observation.accountId === 'string' &&
    observation.accountId.length > 0 &&
    Number.isSafeInteger(observation.owner) &&
    observation.owner >= 0 &&
    Number.isSafeInteger(observation.revision) &&
    observation.revision >= 0;
}

function isHomeObservation(observation: AppearanceObservation): boolean {
  return isCanonicalBase(observation) &&
    observation.source === 'home' &&
    observation.peerId === null &&
    observation.shared === null;
}

function isConversationObservation(observation: AppearanceObservation): boolean {
  return isCanonicalBase(observation) &&
    observation.source === 'conversation' &&
    typeof observation.peerId === 'string' &&
    observation.peerId.length > 0 &&
    observation.shared !== null;
}

function confirmedDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function normalizedPeerId(value: string | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeLedger(row: CelebrationLedgerRow | null): CelebrationLedgerRow | null {
  if (row === null) return null;
  if (typeof row.baselineDays !== 'number' ||
      !Number.isFinite(row.baselineDays) ||
      row.baselineDays < 0) {
    throw new Error('invalid celebration ledger baseline');
  }
  const consumed = row.consumedMilestone as number;
  if (consumed !== 0 && !isMilestone(consumed)) {
    throw new Error('invalid celebration ledger milestone');
  }
  return row;
}

export function createCelebrationCoordinator(
  options: CelebrationCoordinatorOptions,
): CelebrationCoordinator {
  const { persistence, settings, visibility } = options;
  const clock = options.clock ?? SYSTEM_CLOCK;

  let state: CelebrationSnapshot = {
    status: 'idle',
    current: null,
    batch: [],
    error: null,
    choice: null,
  };

  const listeners = new Set<(snapshot: CelebrationSnapshot) => void>();
  const lastRevision = new Map<string, number>();
  const subjectEpoch = new Map<string, number>();
  const suppressionEpoch: Record<CelebrationKind, number> = { chat: 0, streak: 0 };
  const lastMode: Record<CelebrationKind, CelebrationMode | null> = {
    chat: null,
    streak: null,
  };
  const lastGeneration: Record<CelebrationKind, number | null> = {
    chat: null,
    streak: null,
  };

  let disposed = false;
  let cursor = -1;
  let batchToken = 0;
  let batchContext: BatchContext | null = null;
  let batchGenerations: Record<CelebrationKind, number> | null = null;
  let timerHandle: unknown = null;
  let hasTimer = false;

  let syncVersion = 0;
  let pendingInput: CelebrationSyncInput | null = null;
  let evaluation: Promise<void> | null = null;
  let latestLifetime: CelebrationLifetime | undefined;
  let lastCallerGeneration: number | null = null;
  let stopInFlight = false;

  function getSnapshot(): CelebrationSnapshot {
    return { ...state, batch: [...state.batch] };
  }

  function emit(): void {
    const snapshot = getSnapshot();
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A consumer must not break the coordinator.
      }
    }
    if (options.onSnapshot) {
      try {
        options.onSnapshot(snapshot);
      } catch {
        // A consumer must not break the coordinator.
      }
    }
  }

  function update(patch: Partial<CelebrationSnapshot>): void {
    state = { ...state, ...patch };
    emit();
  }

  function clearTimer(): void {
    if (!hasTimer) return;
    hasTimer = false;
    clock.clearTimeout(timerHandle);
    timerHandle = null;
  }

  function schedule(item: CelebrationItem): void {
    clearTimer();
    hasTimer = true;
    timerHandle = clock.setTimeout(() => {
      hasTimer = false;
      timerHandle = null;
      finishCurrent();
    }, item.durationMs);
  }

  function resolveMode(kind: CelebrationKind): CelebrationMode {
    if (!settings.ready() || !settings.enabled(kind)) return 'none';
    const mode = settings.mode(kind);
    if (mode === 'static' || mode === 'animated') return mode;
    return 'none';
  }

  function readKindContext(kind: CelebrationKind): KindContext {
    const mode = resolveMode(kind);
    const rawGeneration = settings.resumeGeneration(kind);
    const generation = Number.isSafeInteger(rawGeneration) && rawGeneration >= 0
      ? rawGeneration
      : 0;
    const previousMode = lastMode[kind];
    const previousGeneration = lastGeneration[kind];

    if (previousMode !== null && mode !== 'none') {
      if (previousMode === 'none' ||
          (previousGeneration !== null && previousGeneration !== generation)) {
        suppressionEpoch[kind] += 1;
      }
    }

    lastMode[kind] = mode;
    lastGeneration[kind] = generation;
    return {
      mode,
      presentation: mode === 'static' ? 'static' : 'animated',
      generation,
    };
  }

  function playbackMode(kind: CelebrationKind): CelebrationPresentation | null {
    if (!settings.ready() || !settings.enabled(kind)) return null;
    const mode = settings.mode(kind);
    return mode === 'animated' || mode === 'static' ? mode : null;
  }

  function acceptedRevision(key: string, revision: number): boolean {
    const previous = lastRevision.get(key);
    if (previous !== undefined && revision < previous) return false;
    lastRevision.set(key, revision);
    return true;
  }

  async function lifetimeActive(lifetime?: CelebrationLifetime): Promise<boolean> {
    if (lifetime === undefined) return true;
    try {
      return Boolean(await lifetime());
    } catch {
      return false;
    }
  }

  function acceptGeneration(generation: number | undefined): boolean {
    if (generation === undefined) return true;
    if (!Number.isSafeInteger(generation) || generation < 0) return false;
    if (lastCallerGeneration !== null && generation < lastCallerGeneration) return false;
    lastCallerGeneration = generation;
    return true;
  }

  function isContextCurrent(
    currentVisibility: CelebrationVisibility,
    context: BatchContext,
  ): boolean {
    return isPresent(currentVisibility) &&
      !currentVisibility.importantConfirmation &&
      (currentVisibility.activePeerId ?? null) === context.peerId;
  }

  function isActiveContextCurrent(currentVisibility: CelebrationVisibility): boolean {
    if (batchContext === null || !isContextCurrent(currentVisibility, batchContext)) {
      return false;
    }
    // While the user is choosing to stop a kind, the in-memory stop has already
    // been applied. Do not let that stop the next, different kind.
    if (state.status === 'choice' || !settings.ready()) return true;

    const kinds: CelebrationKind[] = state.status === 'saving'
      ? state.batch.map((item) => item.kind)
      : state.current !== null ? [state.current.kind] : [];
    for (const kind of kinds) {
      if (!settings.enabled(kind) || settings.mode(kind) === 'none') return false;
      if (batchGenerations !== null &&
          settings.resumeGeneration(kind) !== batchGenerations[kind]) {
        return false;
      }
    }
    return true;
  }

  function endBatch(): void {
    clearTimer();
    cursor = -1;
    batchToken += 1;
    batchContext = null;
    batchGenerations = null;
    state = {
      status: 'ended',
      current: null,
      batch: [],
      error: state.error,
      choice: null,
    };
    emit();
  }

  function endWithoutPlayback(): void {
    clearTimer();
    cursor = -1;
    batchToken += 1;
    batchContext = null;
    batchGenerations = null;
    state = {
      status: 'ended',
      current: null,
      batch: [],
      error: state.error,
      choice: null,
    };
    emit();
  }

  function leave(): void {
    clearTimer();
    cursor = -1;
    batchToken += 1;
    batchContext = null;
    batchGenerations = null;
    state = {
      status: 'ended',
      current: null,
      batch: [],
      error: null,
      choice: null,
    };
    emit();
  }

  function startItem(index: number): void {
    if (disposed) return;
    const items = state.batch;
    if (index < 0 || index >= items.length) {
      endBatch();
      return;
    }
    const item = items[index];
    if (!item) {
      endBatch();
      return;
    }
    const currentVisibility = visibility();
    if (batchContext === null || !isContextCurrent(currentVisibility, batchContext)) {
      endBatch();
      return;
    }
    const mode = playbackMode(item.kind);
    const expectedGeneration = batchGenerations?.[item.kind];
    if (mode === null || expectedGeneration === undefined ||
        settings.resumeGeneration(item.kind) !== expectedGeneration) {
      endBatch();
      return;
    }

    const nextItem: CelebrationItem = { ...item, mode };
    const nextBatch = [...items];
    nextBatch[index] = nextItem;
    cursor = index;
    state = {
      ...state,
      status: 'playing',
      current: nextItem,
      batch: nextBatch,
      choice: null,
    };
    emit();
    schedule(nextItem);
  }

  function finishCurrent(): void {
    if (state.status !== 'playing') return;
    clearTimer();
    startItem(cursor + 1);
  }

  function skip(): void {
    if (state.status !== 'playing' || state.current === null) return;
    clearTimer();
    const kind = state.current.kind;
    const nextKind = state.batch[cursor + 1]?.kind ?? null;
    state = {
      ...state,
      status: 'choice',
      current: null,
      choice: { kind, nextKind },
    };
    emit();
  }

  async function choose(choice: 'once' | 'stop'): Promise<void> {
    if (state.status !== 'choice' || state.choice === null || stopInFlight) return;

    if (choice === 'once') {
      state = { ...state, choice: null };
      startItem(cursor + 1);
      return;
    }

    const selected = state.choice;
    const token = batchToken;
    stopInFlight = true;
    let failure: string | null = null;
    try {
      await settings.stopKind(selected.kind);
    } catch (error) {
      failure = messageOf(error);
    } finally {
      stopInFlight = false;
    }

    if (disposed || token !== batchToken || state.status !== 'choice') return;

    state = {
      ...state,
      choice: null,
      error: failure ?? state.error,
    };
    emit();
    // A failed persistence attempt must not resurrect playback. The in-memory
    // stop is already applied, and the next, different kind may still run.
    startItem(cursor + 1);
  }

  async function runSync(input: CelebrationSyncInput, version: number): Promise<void> {
    if (disposed) return;
    const currentVisibility = visibility();
    if (!isPresent(currentVisibility)) return;
    if (!settings.ready()) return;

    const lifetime = input.lifetime ?? latestLifetime;

    let home: AppearanceObservation | null = null;
    if (input.home !== null &&
        isHomeObservation(input.home) &&
        acceptedRevision('home', input.home.revision)) {
      home = input.home;
    }

    let conversation: AppearanceObservation | null = null;
    if (input.conversation !== null && isConversationObservation(input.conversation)) {
      const peerId = input.conversation.peerId as string;
      const key = `conversation:${peerId}`;
      if (acceptedRevision(key, input.conversation.revision)) {
        conversation = input.conversation;
      }
    }

    const visibilityPeer = normalizedPeerId(currentVisibility.activePeerId);
    const requestedPeer = input.activePeerId === undefined
      ? null
      : normalizedPeerId(input.activePeerId);
    // While a conversation route is displayed, the detail pair is the ONLY
    // personal source. A home response must not play first, and an active peer
    // without its detail pair must remain "checking".
    const conversationContext = visibilityPeer !== null || requestedPeer !== null;
    const pairUsable = visibilityPeer !== null &&
      (input.activePeerId === undefined || requestedPeer === visibilityPeer) &&
      conversation !== null &&
      conversation.peerId === visibilityPeer;

    const kindContexts: Record<CelebrationKind, KindContext> = {
      chat: readKindContext('chat'),
      streak: readKindContext('streak'),
    };

    const requests: SubjectRequest[] = [];
    if (pairUsable && conversation !== null && visibilityPeer !== null) {
      if (conversation.shared !== null && conversation.shared.status === 'ready') {
        const days = confirmedDays(conversation.shared.value.growthDays);
        if (days !== null) {
          requests.push({ kind: 'chat', subjectId: visibilityPeer, days });
        }
      }
      if (conversation.personal.status === 'ready') {
        const days = confirmedDays(conversation.personal.value.earnedDays);
        if (days !== null) {
          requests.push({ kind: 'streak', subjectId: 'self', days });
        }
      }
    } else if (!conversationContext && home !== null) {
      if (home.personal.status === 'ready') {
        const days = confirmedDays(home.personal.value.earnedDays);
        if (days !== null) {
          requests.push({ kind: 'streak', subjectId: 'self', days });
        }
      }
    }

    if (requests.length === 0) {
      if (version !== syncVersion || disposed) return;
      update({ status: 'idle', current: null, batch: [], choice: null });
      return;
    }

    const candidates: CelebrationItem[] = [];
    let failure: string | null = null;

    for (const request of requests) {
      if (version !== syncVersion || disposed) return;
      if (!(await lifetimeActive(lifetime))) return;

      const context = kindContexts[request.kind];
      const epoch = suppressionEpoch[request.kind];
      const key = ledgerKey(request.kind, request.subjectId);
      const seenEpoch = subjectEpoch.get(key) ?? 0;
      const suppress = currentVisibility.importantConfirmation ||
        context.mode === 'none' ||
        seenEpoch < epoch;

      try {
        const row = normalizeLedger(await persistence.read(request.kind, request.subjectId));
        if (version !== syncVersion || disposed) return;
        if (!(await lifetimeActive(lifetime))) return;

        if (row === null) {
          // First canonical contact: the baseline consumes every milestone at
          // or below the observed day count. It never plays.
          await persistence.baseline({
            kind: request.kind,
            subjectId: request.subjectId,
            days: request.days,
            lifetime,
          });
          if (version !== syncVersion || disposed) return;
          subjectEpoch.set(key, epoch);
          continue;
        }

        const reached = highestMilestone(request.days);
        if (suppress) {
          // Subtle/off/kind-disabled and important confirmations consume the
          // current milestone so it is never replayed later.
          if (reached > row.consumedMilestone) {
            await persistence.consume(
              [{
                kind: request.kind,
                subjectId: request.subjectId,
                milestone: reached as AppearanceMilestone,
              }],
              lifetime,
            );
            if (version !== syncVersion || disposed) return;
          }
          subjectEpoch.set(key, epoch);
          continue;
        }

        subjectEpoch.set(key, epoch);
        if (reached > row.consumedMilestone) {
          candidates.push({
            kind: request.kind,
            subjectId: request.subjectId,
            milestone: reached as AppearanceMilestone,
            days: request.days,
            mode: context.presentation,
            durationMs: CELEBRATION_DURATION_MS,
          });
        }
      } catch (error) {
        if (version !== syncVersion || disposed) return;
        failure = messageOf(error);
        break;
      }
    }

    if (failure !== null) {
      if (version !== syncVersion || disposed) return;
      update({ status: 'idle', current: null, batch: [], choice: null, error: failure });
      return;
    }

    if (version !== syncVersion || disposed) return;
    if (candidates.length === 0) {
      update({ status: 'idle', current: null, batch: [], choice: null });
      return;
    }

    if (!(await lifetimeActive(lifetime))) return;
    if (version !== syncVersion || disposed) return;

    // No unbounded queue: a newer observation while saving/playing/choosing is
    // ignored, and the next sync re-evaluates from the latest canonical data.
    pendingInput = null;

    batchToken += 1;
    const token = batchToken;
    batchContext = {
      peerId: pairUsable && visibilityPeer !== null ? visibilityPeer : null,
    };
    batchGenerations = {
      chat: kindContexts.chat.generation,
      streak: kindContexts.streak.generation,
    };
    cursor = -1;
    update({
      status: 'saving',
      current: null,
      batch: candidates,
      error: null,
      choice: null,
    });

    const records: CelebrationConsumption[] = candidates.map((item) => ({
      kind: item.kind,
      subjectId: item.subjectId,
      milestone: item.milestone,
    }));

    try {
      // One transaction for every selected item. Lower milestones are implied
      // by storing only the highest selected milestone for each subject.
      await persistence.consume(records, lifetime);
    } catch (error) {
      if (token !== batchToken || disposed || version !== syncVersion) return;
      cursor = -1;
      batchContext = null;
      batchGenerations = null;
      update({
        status: 'idle',
        current: null,
        batch: [],
        choice: null,
        error: messageOf(error),
      });
      return;
    }

    if (token !== batchToken || disposed || version !== syncVersion) return;
    // Check both the lifetime that selected this batch and the newest caller
    // lifetime. A session that ended during the save must not start playback,
    // even if a later sync already supplied a replacement lifetime.
    const batchLifetimeActive = await lifetimeActive(lifetime);
    const newestLifetime = latestLifetime;
    const newestLifetimeActive = newestLifetime === undefined || newestLifetime === lifetime
      ? true
      : await lifetimeActive(newestLifetime);
    if (!batchLifetimeActive || !newestLifetimeActive) {
      if (token === batchToken && !disposed) endWithoutPlayback();
      return;
    }

    const afterSave = visibility();
    if (batchContext === null || !isContextCurrent(afterSave, batchContext)) {
      if (token === batchToken && !disposed) endWithoutPlayback();
      return;
    }
    if (!settings.ready()) {
      if (token === batchToken && !disposed) endWithoutPlayback();
      return;
    }

    const updatedItems: CelebrationItem[] = [];
    for (const item of candidates) {
      const mode = playbackMode(item.kind);
      const expectedGeneration = batchGenerations?.[item.kind];
      if (mode === null || expectedGeneration === undefined ||
          settings.resumeGeneration(item.kind) !== expectedGeneration) {
        if (token === batchToken && !disposed) endWithoutPlayback();
        return;
      }
      updatedItems.push({ ...item, mode });
    }

    cursor = -1;
    state = {
      ...state,
      status: 'saving',
      current: null,
      batch: updatedItems,
      choice: null,
    };
    startItem(0);
  }

  function sync(input: CelebrationSyncInput): Promise<void> {
    if (disposed) return Promise.resolve();
    if (!acceptGeneration(input.generation)) return Promise.resolve();
    if (input.lifetime !== undefined) latestLifetime = input.lifetime;

    if (isActive(state.status)) {
      if (!isActiveContextCurrent(visibility())) leave();
      return Promise.resolve();
    }

    pendingInput = input;
    syncVersion += 1;
    if (evaluation !== null) return evaluation;

    evaluation = (async () => {
      try {
        while (pendingInput !== null && !disposed && !isActive(state.status)) {
          const next = pendingInput;
          pendingInput = null;
          const version = syncVersion;
          await runSync(next, version);
        }
      } finally {
        evaluation = null;
        // A batch that started while a newer sync was pending owns the screen;
        // the newer observation must wait for a later explicit sync.
        if (isActive(state.status)) pendingInput = null;
      }
    })();
    return evaluation;
  }

  function subscribe(listener: (snapshot: CelebrationSnapshot) => void): () => void {
    if (disposed) return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function stop(): void {
    if (disposed) return;
    disposed = true;
    leave();
    listeners.clear();
  }

  return {
    sync,
    finishCurrent,
    skip,
    choose,
    leave,
    getSnapshot,
    subscribe,
    stop,
  };
}
