import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import { usePathname } from 'expo-router';

import { useAuth } from '../auth/provider';
import { useChat } from '../messages/provider';
import type { CelebrationVisibility } from './celebrations';

/**
 * Task 14: one visibility port for every celebration decision.
 *
 * The coordinator (Task 13) must never infer "the user is looking at this
 * conversation" from a list selection or a cached response. This module joins
 * the authenticated lifetime, the actual expo-router path, the app/chat
 * foreground state, the chat store's displayed peer and the registry of
 * important confirmations into a single immutable value:
 *
 *   auth current + route displayed + foreground + no confirmation
 *
 * A mounted-but-hidden tab is just a component tree: only the current pathname
 * can make it visible. A `/chat` split selection is visible only through the
 * chat store's actually-selected peer. A standalone `/conversations/:peerId`
 * route is visible for that route's peer.
 */

const INVISIBLE: CelebrationVisibility = {
  visible: false,
  foreground: false,
  authCurrent: false,
  importantConfirmation: false,
  activePeerId: null,
};

export interface CelebrationAppState {
  currentState?: string | null;
  addEventListener?(
    event: 'change',
    listener: (state: string) => void,
  ): { remove(): void };
}

export interface DeriveCelebrationVisibilityInput {
  pathname: string | null;
  authCurrent: boolean;
  foreground: boolean;
  stopped: boolean;
  activePeerId: string | null;
  importantConfirmation: boolean;
}

function pathSegments(pathname: string | null): string[] {
  const path = (pathname ?? '').split(/[?#]/, 1)[0] ?? '';
  return path.split('/').filter((segment) => segment.length > 0);
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The peer of a standalone `/conversations/:peerId` route, or null. */
export function conversationRoutePeer(pathname: string | null): string | null {
  const segments = pathSegments(pathname);
  if (segments[0] !== 'conversations' || segments.length < 2) return null;
  const peerId = decoded(segments[1]);
  return peerId.length > 0 ? peerId : null;
}

/** Personal/main screens allowed to show celebrations. */
export function isCelebrationPersonalRoute(pathname: string | null): boolean {
  const segments = pathSegments(pathname);
  if (segments.length === 0) return false;
  return segments[0] === 'home' ||
    segments[0] === 'chat' ||
    segments[0] === 'friends' ||
    segments[0] === 'mypage';
}

/**
 * Pure route/foreground/peer decision. Exported so the rules can be tested
 * without mounting expo-router or a chat store.
 *
 * - A hidden mounted tab never contributes its `activePeerId`.
 * - `/chat` exposes the split selection only (the chat store sets it when the
 *   detail pane is actually selected).
 * - `/conversations/:peerId` exposes that route's peer.
 * - Important confirmations block STARTING; the host also calls leave() for an
 *   already-running item.
 */
export function deriveCelebrationVisibility(
  input: DeriveCelebrationVisibilityInput,
): CelebrationVisibility {
  const routePeer = conversationRoutePeer(input.pathname);
  const personal = isCelebrationPersonalRoute(input.pathname);
  const stopped = input.stopped;
  const foreground = input.foreground && !stopped;
  const authCurrent = input.authCurrent && !stopped;
  const routeVisible = authCurrent && foreground && (routePeer !== null || personal);

  let activePeerId: string | null = null;
  if (routeVisible) {
    if (routePeer !== null) {
      activePeerId = routePeer;
    } else if (personal) {
      const segments = pathSegments(input.pathname);
      activePeerId = segments[0] === 'chat' ? input.activePeerId : null;
    }
  }

  return {
    visible: routeVisible && !input.importantConfirmation,
    foreground,
    authCurrent,
    importantConfirmation: input.importantConfirmation,
    activePeerId,
  };
}

interface VisibilityRuntime {
  getVisibility(): CelebrationVisibility;
  getPathname(): string | null;
  registerConfirmation(): () => void;
}

const VisibilityContext = createContext<VisibilityRuntime | null>(null);

export interface VisibilityProviderProps {
  children: React.ReactNode;
  /** Tests can inject the route; the app reads expo-router's usePathname(). */
  pathname?: string | null;
  /** Tests can inject AppState; defaults to React Native's AppState. */
  appState?: CelebrationAppState | null;
}

function useAppActive(appState: CelebrationAppState | null | undefined): boolean {
  const source = appState === undefined ? (AppState as CelebrationAppState) : appState;
  const [state, setState] = useState<string>(() => source?.currentState ?? 'active');

  useEffect(() => {
    if (!source?.addEventListener) return;
    const subscription = source.addEventListener('change', value => setState(value));
    return () => subscription.remove();
  }, [source]);

  return state === 'active';
}

function VisibilityRuntimeProvider({
  children,
  pathname,
  appState,
}: VisibilityProviderProps & { pathname: string | null }) {
  const auth = useAuth();
  const chat = useChat();
  const appActive = useAppActive(appState);
  const [version, setVersion] = useState(0);

  // Counted, not a boolean: two surfaces can overlap (image viewer + retry
  // confirmation) and each unmount must release only its own registration.
  const confirmationCount = useRef(0);

  const authCurrent =
    auth.status === 'ready' &&
    auth.registration === 'registered' &&
    typeof auth.accountId === 'string' &&
    auth.accountId.length > 0 &&
    (chat === null || (chat.accountId === auth.accountId && !chat.stopped));

  const foreground = appActive && (chat === null || (chat.foreground && !chat.stopped));

  const inputRef = useRef<DeriveCelebrationVisibilityInput>({
    pathname,
    authCurrent,
    foreground,
    stopped: chat?.stopped ?? false,
    activePeerId: chat?.activePeerId ?? null,
    importantConfirmation: confirmationCount.current > 0,
  });
  inputRef.current = {
    pathname,
    authCurrent,
    foreground,
    stopped: chat?.stopped ?? false,
    activePeerId: chat?.activePeerId ?? null,
    importantConfirmation: confirmationCount.current > 0,
  };

  const getVisibility = useCallback((): CelebrationVisibility => {
    const input = inputRef.current;
    return deriveCelebrationVisibility({
      ...input,
      importantConfirmation: confirmationCount.current > 0,
    });
  }, []);

  const getPathname = useCallback(() => inputRef.current.pathname, []);

  const registerConfirmation = useCallback((): (() => void) => {
    confirmationCount.current += 1;
    // The ref is authoritative for the coordinator's getter; the state bump
    // re-renders consumers (host/probe) with the new value.
    setVersion(value => value + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      confirmationCount.current = Math.max(0, confirmationCount.current - 1);
      setVersion(value => value + 1);
    };
  }, []);

  // A new object each render is intentional: any consumer (the host) must see
  // route/foreground/confirmation changes even when its own subscriptions did
  // not fire. The getter/register identities stay stable.
  const value: VisibilityRuntime = {
    getVisibility,
    getPathname,
    registerConfirmation,
  };

  // `version` is read here so React never drops the state update as unused.
  void version;

  return (
    <VisibilityContext.Provider value={value}>
      {children}
    </VisibilityContext.Provider>
  );
}

function RouterVisibilityProvider(props: VisibilityProviderProps) {
  const pathname = usePathname();
  return <VisibilityRuntimeProvider {...props} pathname={pathname ?? null} />;
}

export function VisibilityProvider(props: VisibilityProviderProps) {
  // Conditional mounting keeps `usePathname()` out of router-free tests while
  // the production layout always reads the real router.
  if (props.pathname !== undefined) {
    return (
      <VisibilityRuntimeProvider {...props} pathname={props.pathname ?? null} />
    );
  }
  return <RouterVisibilityProvider {...props} />;
}

/** Current immutable celebration visibility. Safe outside the provider. */
export function useCelebrationVisibility(): CelebrationVisibility {
  const runtime = useContext(VisibilityContext);
  return runtime ? runtime.getVisibility() : INVISIBLE;
}

const getInvisibleVisibility = (): CelebrationVisibility => INVISIBLE;

/**
 * A stable getter for the LIVE visibility port. The coordinator must read the
 * latest value (especially the confirmation ref) between React commits, not a
 * value captured by the host's last render.
 */
export function useCelebrationVisibilityPort(): () => CelebrationVisibility {
  const runtime = useContext(VisibilityContext);
  return runtime?.getVisibility ?? getInvisibleVisibility;
}

/** The current pathname used by the visibility port (host leave() trigger). */
export function useCelebrationRouteKey(): string | null {
  const runtime = useContext(VisibilityContext);
  return runtime ? runtime.getPathname() : null;
}

/**
 * Registers one inline important confirmation while `active` is true.
 *
 * The effect cleanup runs on deactivation and unmount, so a screen that goes
 * away can never leave a leaked registration (which would block every later
 * celebration).
 */
export function useImportantConfirmation(active: boolean): void {
  const runtime = useContext(VisibilityContext);
  const register = runtime?.registerConfirmation ?? null;
  // Layout timing: the registration must be visible to the host's passive
  // sync effect in the same commit, so an inline confirmation can never let a
  // celebration start for one frame behind the dialog.
  useLayoutEffect(() => {
    if (!register || !active) return;
    return register();
  }, [register, active]);
}
