import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import type { ChatContextValue } from '../messages/provider';
import { useChat } from '../messages/provider';
import { useTheme } from '../theme/provider';
import type { ThemeScheme } from '../theme/tokens';
import { calculateAppearance, type AppearanceVisual } from './calculate';
import type { AppearanceVibrancy } from './catalog';
import type { ChatAppearance, StreakAppearance } from './contracts';
import { useDevPreview, type DevAppearancePreview } from './devPreview';
import {
  conversationObservation,
  conversationSubject,
  displayAppearance,
  homeObservation,
  type AppearanceObservation,
} from './observations';
import { useAppearancePreferences } from './preferences';
import {
  chatProgress,
  streakProgress,
  type ChatProgress,
  type StreakProgress,
} from './progress';

/**
 * Task 12: authenticated appearance application boundary.
 *
 * The provider is mounted ONCE inside the existing chat owner + theme +
 * device-preference providers. It owns no account lifecycle of its own: the
 * chat store already fences observations by account/owner. It only turns the
 * latest canonical observation (plus the display cache while offline) into a
 * render-ready hierarchy:
 *
 *   protected readability > conversation shared appearance > personal frame.
 *
 * No decoration is applied at the root. Screens apply the nearest explicit
 * scope; login/register/callback have no scope and stay on the plain tokens.
 * Unknown appearance never becomes a confirmed zero: `checking` is true,
 * progress is null, and the only allowed visual is the safe monochrome
 * calculation at day 0 with decoration off.
 */

interface AppearanceRuntime {
  chat: ChatContextValue | null;
  scheme: ThemeScheme;
  /** Already normalized: 'off' until the device setting is known. */
  vibrancy: AppearanceVibrancy;
  reduceMotion: boolean;
  /** Bumped by every canonical observation; also a memo dependency. */
  version: number;
}

const AppearanceRuntimeContext = createContext<AppearanceRuntime | null>(null);

export interface AppearanceProviderProps {
  children: React.ReactNode;
}

export function AppearanceProvider({ children }: AppearanceProviderProps) {
  const chat = useChat();
  const { scheme } = useTheme();
  const preferences = useAppearancePreferences();
  const observations = chat?.appearanceObservations ?? null;
  const [version, setVersion] = useState(0);

  // The store notifies on accept() and clear(). Chat state updates already
  // re-render this provider, but the explicit subscription guarantees a new
  // canonical observation is never missed between those publications.
  useEffect(() => {
    if (!observations) return;
    return observations.subscribe(() => setVersion((value) => value + 1));
  }, [observations]);

  const vibrancy: AppearanceVibrancy =
    preferences.status === 'ready' ? preferences.preferences.vibrancy : 'off';

  const value = useMemo<AppearanceRuntime>(
    () => ({
      chat,
      scheme,
      vibrancy,
      reduceMotion: preferences.reducedMotion,
      version,
    }),
    [chat, scheme, vibrancy, preferences.reducedMotion, version],
  );

  return (
    <AppearanceRuntimeContext.Provider value={value}>
      {children}
    </AppearanceRuntimeContext.Provider>
  );
}

export type AppearanceScopeRole = 'personal' | 'conversation';

export interface AppearanceScopeValue {
  role: AppearanceScopeRole;
  /** null for the personal frame. */
  peerId: string | null;
  /** Safe monochrome visual when the confirmed values are unavailable. */
  visual: AppearanceVisual | null;
  /** Foreground, not stopped, and (for a conversation) actually selected. */
  active: boolean;
  /** True while the display source is unavailable: show 確認中, never 0日. */
  checking: boolean;
  personalProgress: StreakProgress | null;
  conversationProgress: ChatProgress | null;
  /** Personal streak from the same source as the visual. */
  personal: StreakAppearance | null;
  /** Conversation pair shared appearance; always null for a personal scope. */
  shared: ChatAppearance | null;
  canChange: boolean;
  /** OS reduce-motion value, so Screen need not require the preferences hook. */
  reduceMotion: boolean;
}

const AppearanceScopeContext = createContext<AppearanceScopeValue | null>(null);

/** Nearest explicit scope, or null on an unauthenticated/undecorated screen. */
export function useAppearanceScope(): AppearanceScopeValue | null {
  return useContext(AppearanceScopeContext);
}

export interface AppearanceScopeProps {
  role: AppearanceScopeRole;
  peerId?: string;
  /** Caller visibility (route focus / workspace active). */
  active?: boolean;
  children: React.ReactNode;
}

function cachedObservation(
  chat: ChatContextValue,
  role: AppearanceScopeRole,
  peerId: string | null,
): AppearanceObservation | null {
  const meta = { accountId: chat.accountId, owner: chat.session.owner };
  if (role === 'personal') {
    return chat.home?.home ? homeObservation(chat.home.home, meta) : null;
  }
  // Only the displayed detail snapshot can stand in for the live pair. A home
  // value is never borrowed for a conversation (or vice versa).
  if (!peerId || chat.activePeerId !== peerId) return null;
  const metadata = chat.conversation?.metadata;
  if (!metadata || metadata.peer_id !== peerId) return null;
  return conversationObservation(metadata, meta);
}

function buildScopeValue(
  runtime: AppearanceRuntime,
  role: AppearanceScopeRole,
  peerId: string | null,
  callerActive: boolean,
  preview: DevAppearancePreview | null,
): AppearanceScopeValue {
  const chat = runtime.chat;
  const subject = role === 'conversation'
    ? (peerId ? conversationSubject(peerId) : null)
    : 'home';
  const live = subject ? chat?.appearanceObservations.latest(subject) ?? null : null;
  const cached = chat ? cachedObservation(chat, role, peerId) : null;
  const display = displayAppearance(live, cached);
  const ready = display.status === 'checking' ? null : display.value;
  // Dev-only display override (see devPreview.ts). It replaces the values used
  // to calculate this scope, but never the canonical observation store, so a
  // server refresh still wins as soon as the override is cleared.
  const previewPersonal: StreakAppearance | null = preview?.streak ? {
    currentStreak: preview.streak.currentStreak,
    earnedDays: preview.streak.earnedDays,
    appearanceVersion: 1,
  } : null;
  const previewGrowthDays = role === 'conversation' ? preview?.growthDays ?? null : null;
  const previewShared: ChatAppearance | null = previewGrowthDays === null ? null : {
    growthDays: previewGrowthDays,
    autoPresetId: 'b-pop',
    selectedPresetId: null,
    effectivePresetId: 'b-pop',
    catalogVersion: 1,
    settingsRevision: 0,
    canChange: false,
  };
  const personal = previewPersonal ?? ready?.personal ?? null;
  const shared = role === 'conversation' ? previewShared ?? ready?.shared ?? null : null;
  const previewApplies = previewPersonal !== null || previewShared !== null;
  const checking = previewApplies ? false : display.status === 'checking';

  const days = role === 'conversation' ? shared?.growthDays ?? 0 : personal?.earnedDays ?? 0;
  const presetId = role === 'conversation' ? shared?.effectivePresetId ?? 'b-pop' : 'b-pop';
  // Loading/unavailable device settings fall back to monochrome, and an
  // unknown display value also forces decoration off even at a nonzero stage.
  const vibrancy: AppearanceVibrancy = checking ? 'off' : runtime.vibrancy;
  const visual = calculateAppearance({
    subject: role === 'conversation' ? 'chat' : 'streak',
    days,
    presetId,
    scheme: runtime.scheme,
    vibrancy,
  });

  const foreground = !!chat && !chat.stopped && chat.foreground;
  const selected = role === 'conversation'
    ? !!peerId && chat?.activePeerId === peerId
    : true;
  const active = callerActive && foreground && selected;

  return {
    role,
    peerId,
    visual,
    active,
    checking,
    personalProgress: personal
      ? streakProgress({
          currentStreak: personal.currentStreak,
          earnedDays: personal.earnedDays,
        })
      : null,
    conversationProgress: shared ? chatProgress(shared.growthDays) : null,
    personal,
    shared,
    canChange: role === 'conversation' ? shared?.canChange ?? false : false,
    reduceMotion: runtime.reduceMotion,
  };
}

function ScopedAppearance({
  runtime,
  role,
  peerId,
  callerActive,
  children,
}: {
  runtime: AppearanceRuntime;
  role: AppearanceScopeRole;
  peerId: string | null;
  callerActive: boolean;
  children: React.ReactNode;
}) {
  // Always subscribed; the store returns null in release builds. Changes
  // re-render this scope so the dev panel applies immediately.
  const preview = useDevPreview();
  const value = useMemo(
    () => buildScopeValue(runtime, role, peerId, callerActive, preview),
    [runtime, role, peerId, callerActive, preview],
  );
  return (
    <AppearanceScopeContext.Provider value={value}>
      {children}
    </AppearanceScopeContext.Provider>
  );
}

export function AppearanceScope({
  role,
  peerId,
  active = true,
  children,
}: AppearanceScopeProps) {
  const runtime = useContext(AppearanceRuntimeContext);
  // A scope outside the authenticated provider is a no-op. Existing route and
  // component tests can mount chat pieces without the appearance layer; the
  // real app always has the provider inside the root layout.
  if (!runtime) return <>{children}</>;
  return (
    <ScopedAppearance
      runtime={runtime}
      role={role}
      peerId={role === 'conversation' ? peerId ?? null : null}
      callerActive={active}
    >
      {children}
    </ScopedAppearance>
  );
}
