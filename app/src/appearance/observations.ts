import type { ChatMessagesResult, HomeResult } from '../backend/chat';
import {
  readChatAppearance,
  readStreakAppearance,
  type AppearanceRead,
  type ChatAppearance,
  type StreakAppearance,
} from './contracts';

/** A canonical appearance read observed from one live query response. It is
 * deliberately separate from the display cache: replaying an old cache is not
 * a canonical synchronization and must not create a first baseline or replay
 * an achievement. */
export interface AppearanceObservation {
  accountId: string;
  /** Stable repository/store lifetime identity, never a revision or token. */
  owner: number;
  source: 'home' | 'conversation';
  /** null for home; the detail response's peer_id for a conversation. */
  peerId: string | null;
  revision: number;
  /** Home carries only the actor's own state. */
  personal: AppearanceRead<StreakAppearance>;
  /** null for home. A conversation pair is always from ONE detail response. */
  shared: AppearanceRead<ChatAppearance> | null;
  fetchedAt: number;
}

export type AppearanceSubject = 'home' | `conversation:${string}`;

export interface AppearanceObservationMeta {
  accountId: string;
  owner: number;
  fetchedAt?: number;
}

export function conversationSubject(peerId: string): AppearanceSubject {
  return `conversation:${peerId}`;
}

function fetchedAt(meta: AppearanceObservationMeta): number {
  return meta.fetchedAt ?? Date.now();
}

/** Home has no shared conversation appearance, even if home target rows happen
 * to carry one. A conversation celebration must come from the detail pair. */
export function homeObservation(home: HomeResult, meta: AppearanceObservationMeta): AppearanceObservation {
  return {
    accountId: meta.accountId,
    owner: meta.owner,
    source: 'home',
    peerId: null,
    revision: home.revision,
    personal: readStreakAppearance(home.streak_appearance),
    shared: null,
    fetchedAt: fetchedAt(meta),
  };
}

/** Both reads come from the same detail response and therefore the same
 * snapshot revision. Do not combine a personal read from home/list with the
 * conversation's shared read. */
export function conversationObservation(detail: ChatMessagesResult, meta: AppearanceObservationMeta): AppearanceObservation {
  return {
    accountId: meta.accountId,
    owner: meta.owner,
    source: 'conversation',
    peerId: detail.peer_id,
    revision: detail.revision,
    personal: readStreakAppearance(detail.streak_appearance),
    shared: readChatAppearance(detail.appearance),
    fetchedAt: fetchedAt(meta),
  };
}

export interface AppearanceObservationStore {
  readonly accountId: string;
  readonly owner: number;
  accept(observation: AppearanceObservation): boolean;
  latest(subject: string): AppearanceObservation | null;
  list(): readonly AppearanceObservation[];
  clear(): void;
  subscribe(listener: (observations: readonly AppearanceObservation[]) => void): () => void;
}

function isRead(value: unknown): value is AppearanceRead<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const status = (value as { status?: unknown }).status;
  if (status === 'ready') return 'value' in value;
  return status === 'unavailable' &&
    ((value as { reason?: unknown }).reason === 'missing' ||
      (value as { reason?: unknown }).reason === 'invalid' ||
      (value as { reason?: unknown }).reason === 'unsupported_version');
}

function subjectOf(observation: AppearanceObservation): AppearanceSubject | null {
  if (!isRead(observation.personal)) return null;
  if (observation.shared !== null && !isRead(observation.shared)) return null;
  if (observation.source === 'home') {
    return observation.peerId === null && observation.shared === null ? 'home' : null;
  }
  if (observation.source === 'conversation') {
    return typeof observation.peerId === 'string' && observation.peerId.length > 0 &&
      observation.shared !== null ? conversationSubject(observation.peerId) : null;
  }
  return null;
}

/** One store per authenticated repository lifetime. clear() is irreversible so
 * a late response from a stopped/logged-out lifetime can never repopulate it. */
export function createAppearanceObservationStore(deps: {
  accountId: string; owner: number; now?: () => number;
}): AppearanceObservationStore {
  const now = deps.now ?? Date.now;
  const observations = new Map<AppearanceSubject, AppearanceObservation>();
  const listeners = new Set<(observations: readonly AppearanceObservation[]) => void>();
  let cleared = false;
  function snapshot(): readonly AppearanceObservation[] {
    return [...observations.values()];
  }
  function notify() {
    const current = snapshot();
    for (const listener of [...listeners]) {
      try { listener(current); } catch { /* A consumer must not break canonical state. */ }
    }
  }
  return {
    accountId: deps.accountId,
    owner: deps.owner,
    accept(observation) {
      if (cleared) return false;
      if (observation.accountId !== deps.accountId || observation.owner !== deps.owner) return false;
      if (!Number.isSafeInteger(observation.revision) || observation.revision < 0) return false;
      const subject = subjectOf(observation);
      if (!subject) return false;
      const previous = observations.get(subject);
      if (previous && observation.revision <= previous.revision) return false;
      const at = Number.isFinite(observation.fetchedAt) && observation.fetchedAt >= 0
        ? observation.fetchedAt : now();
      observations.set(subject, { ...observation, fetchedAt: at });
      notify();
      return true;
    },
    latest(subject) {
      return observations.get(subject as AppearanceSubject) ?? null;
    },
    list: snapshot,
    clear() {
      cleared = true;
      observations.clear();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export interface AppearanceValues {
  personal: StreakAppearance;
  shared: ChatAppearance | null;
}

export type AppearanceDisplay =
  | { status: 'confirmed'; value: AppearanceValues }
  | { status: 'cached'; value: AppearanceValues }
  | { status: 'checking'; value: null };

function readyValues(observation: AppearanceObservation | null | undefined): AppearanceValues | null {
  if (!observation || observation.personal.status !== 'ready') return null;
  if (observation.source === 'home') {
    return observation.shared === null
      ? { personal: observation.personal.value, shared: null } : null;
  }
  if (!observation.shared || observation.shared.status !== 'ready') return null;
  return { personal: observation.personal.value, shared: observation.shared.value };
}

function sameSubject(a: AppearanceObservation, b: AppearanceObservation): boolean {
  return a.source === b.source && a.peerId === b.peerId;
}

/** Live canonical data wins. A display cache is only a fallback while offline
 * and is never promoted to canonical state. A partial conversation read is
 * "checking", never a zero or a personal value borrowed from another fetch. */
export function displayAppearance(
  live: AppearanceObservation | null | undefined,
  cached: AppearanceObservation | null | undefined,
): AppearanceDisplay {
  const confirmed = readyValues(live);
  if (confirmed) return { status: 'confirmed', value: confirmed };
  // Never mix a home personal read with a conversation's cached shared pair
  // (or vice versa); both halves must come from the same subject snapshot.
  const usableCache = cached && (!live || sameSubject(live, cached)) ? readyValues(cached) : null;
  if (usableCache) return { status: 'cached', value: usableCache };
  return { status: 'checking', value: null };
}
