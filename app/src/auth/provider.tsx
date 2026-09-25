import type { Session, SupabaseClient } from '@supabase/supabase-js';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { getAppClient } from '../backend/client';
import { clearRememberedDestination } from '../navigation/entry';
import { assertRegistrationInput, suggestSimilarUserIds } from '../profiles/registration';
import { USER_ID_TAKEN_ERROR } from '../profiles/validation';
import { openAppDatabase, randomId, type Storage } from '../storage/database';
import { listPendingInvitations } from '../storage/invitations';
import { createCommandApi, type CommandOutcome } from '../sync/api';
import { startLogin, type LoginResult } from './oauth';
import {
  assertNoCrossEmailAutoLink,
  resolveSessionOutcome,
  type OAuthProvider,
} from './session';

// Task 10: auth + registration context.
//
// Ownership: the session lifecycle (mount → getSession → registration state
// read from the SERVER profile row), the provider round trip (delegated to
// auth/oauth.ts), the registration command, and the server-stored
// onboarding-seen flag. Screens read this context; they never talk to
// supabase-js directly.
//
// Registration state always comes from the server (profiles row via the
// owner-read RLS policy), never from local guesswork — the 未登録ガード and
// the entry branching share that single source of truth.

export type RegistrationStatus = 'loading' | 'unregistered' | 'registered';

export type AuthStatus = 'loading' | 'ready' | 'error';

export type RegistrationResult =
  | { status: 'registered' }
  | { status: 'conflict'; message: string; candidates: string[] }
  | { status: 'rejected'; message: string }
  | { status: 'failed'; message: string; retryable: boolean };

export interface RegistrationInput {
  userIdText: string;
  displayName: string;
}

export interface AuthContextValue {
  /** `error` covers missing Supabase config and failed state resolution. */
  status: AuthStatus;
  error: string | null;
  accountId: string | null;
  registration: RegistrationStatus;
  onboardingSeen: boolean;
  /** Account storage handle (drafts, pending invitation); null until opened. */
  storage: Storage | null;
  refresh(): Promise<void>;
  signIn(provider: OAuthProvider): Promise<LoginResult>;
  submitRegistration(input: RegistrationInput): Promise<RegistrationResult>;
  /**
   * Marks the guide as seen on the server (idempotent; the server keeps the
   * first timestamp). First-run guidance screens call this when acknowledged.
   */
  markOnboardingSeen(): Promise<boolean>;
  /**
   * Marks the guide as seen only when this account carries a pending
   * invitation (招待先確認到達 → 一般案内を重ねない). Returns whether the
   * server accepted the mark.
   */
  markOnboardingSeenIfInvited(): Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return value;
}

export interface AuthProviderProps {
  children: React.ReactNode;
  /** Injected client (tests); defaults to the app singleton. */
  client?: SupabaseClient;
  /** Injected storage (tests); defaults to the device SQLite database. */
  storage?: Storage | null;
}

interface OwnProfileRow {
  user_id_confirmed_at: string | null;
  onboarding_seen_at: string | null;
}

/**
 * Pending register operation. The id is reused while the payload is
 * unchanged, so retrying after a lost response replays the SAME command
 * (idempotent) instead of double-registering; editing the input starts a new
 * operation so the operation log never sees id/payload conflicts.
 */
interface PendingOperation {
  payloadKey: string;
  operationId: string;
}

export function AuthProvider({
  children,
  client: injectedClient,
  storage: injectedStorage,
}: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [registration, setRegistration] = useState<RegistrationStatus>('loading');
  const [onboardingSeen, setOnboardingSeen] = useState(false);
  const [storage, setStorage] = useState<Storage | null>(injectedStorage ?? null);
  const sessionEmailRef = useRef<string | null>(null);
  const pendingOperationRef = useRef<PendingOperation | null>(null);

  // Device storage for account-scoped drafts / the pending invitation.
  // A failure degrades to "no local drafts" instead of blocking auth.
  useEffect(() => {
    if (injectedStorage !== undefined) return;
    let alive = true;
    void openAppDatabase()
      .then((db) => {
        if (alive) setStorage(db);
      })
      .catch(() => {
        // Registration still works; the screen keeps its input in memory
        // and we never fabricate persistence we do not have.
      });
    return () => {
      alive = false;
    };
  }, [injectedStorage]);

  const clientOf = useCallback(
    (): SupabaseClient => injectedClient ?? getAppClient(),
    [injectedClient],
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const client = clientOf();
      const { data } = await client.auth.getSession();
      const session = data.session;
      if (!session) {
        sessionEmailRef.current = null;
        setAccountId(null);
        setRegistration('loading');
        setOnboardingSeen(false);
        setStatus('ready');
        setError(null);
        return;
      }
      const nextAccountId = session.user.id;
      const nextEmail = session.user.email ?? null;
      // A different verified email must never inherit the previous
      // account's local context (no auto-merge). Account-scoped storage
      // already isolates data; entry memory does not — drop it explicitly.
      try {
        assertNoCrossEmailAutoLink(sessionEmailRef.current, nextEmail);
      } catch {
        clearRememberedDestination();
      }
      sessionEmailRef.current = nextEmail;

      const { data: row, error: queryError } = await client
        .from('profiles')
        .select('user_id_confirmed_at, onboarding_seen_at')
        .eq('user_id', nextAccountId)
        .maybeSingle();
      if (queryError) throw new Error(queryError.message);
      const profile = row as OwnProfileRow | null;
      setAccountId(nextAccountId);
      setRegistration(profile?.user_id_confirmed_at ? 'registered' : 'unregistered');
      setOnboardingSeen(profile?.onboarding_seen_at != null);
      setError(null);
      setStatus('ready');
    } catch (cause) {
      setStatus('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [clientOf]);

  const markOnboardingSeen = useCallback(async (): Promise<boolean> => {
    try {
      const client = clientOf();
      const session = (await client.auth.getSession()).data.session;
      if (!session) return false;
      const api = createCommandApi({ client });
      const outcome = await api.send({
        accountId: session.user.id,
        operationId: randomId(),
        kind: 'mark_onboarding_seen',
        payload: {},
      });
      if (outcome.status === 'ok') {
        setOnboardingSeen(true);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [clientOf]);

  const markOnboardingSeenIfInvited = useCallback(async (): Promise<boolean> => {
    try {
      const client = clientOf();
      const session = (await client.auth.getSession()).data.session;
      if (!session || !storage) return false;
      const invitations = await listPendingInvitations(storage, session.user.id);
      if (invitations.length === 0) return false;
      return await markOnboardingSeen();
    } catch {
      return false;
    }
  }, [clientOf, markOnboardingSeen, storage]);

  const submitRegistration = useCallback(
    async (input: RegistrationInput): Promise<RegistrationResult> => {
      let client: SupabaseClient;
      try {
        client = clientOf();
      } catch (cause) {
        return {
          status: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: false,
        };
      }
      const session = (await client.auth.getSession()).data.session;
      if (!session) {
        return {
          status: 'failed',
          message: 'Your session expired. Sign in again.',
          retryable: false,
        };
      }
      const signedInAs = session.user.id;

      let confirmed: { userIdText: string; displayName: string };
      try {
        confirmed = assertRegistrationInput(input.userIdText, input.displayName);
      } catch (cause) {
        return {
          status: 'rejected',
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }

      const payload = {
        user_id_text: confirmed.userIdText,
        display_name: confirmed.displayName,
      };
      const payloadKey = JSON.stringify(payload);
      if (pendingOperationRef.current?.payloadKey !== payloadKey) {
        pendingOperationRef.current = { payloadKey, operationId: randomId() };
      }
      const operationId = pendingOperationRef.current.operationId;

      const api = createCommandApi({ client });
      let outcome: CommandOutcome;
      try {
        outcome = await api.send({
          accountId: signedInAs,
          operationId,
          kind: 'register',
          payload,
        });
      } catch (cause) {
        return {
          status: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: true,
        };
      }

      switch (outcome.status) {
        case 'ok':
          pendingOperationRef.current = null;
          // An invited account reaches its confirmation next, so the guide
          // is marked seen NOW and the general guidance is not stacked on.
          await markOnboardingSeenIfInvited();
          setRegistration('registered');
          setError(null);
          setStatus('ready');
          return { status: 'registered' };
        case 'rejected':
          if (outcome.message === USER_ID_TAKEN_ERROR) {
            return {
              status: 'conflict',
              message: outcome.message,
              candidates: suggestSimilarUserIds(confirmed.userIdText),
            };
          }
          return { status: 'rejected', message: outcome.message };
        case 'conflict':
          return { status: 'rejected', message: outcome.message };
        case 'transient':
        case 'unknown':
          // The SAME operation id is reused on retry: a replay of a command
          // that actually landed returns the stored result.
          return {
            status: 'failed',
            message: outcome.message ?? 'Network error.',
            retryable: true,
          };
      }
    },
    [clientOf, markOnboardingSeenIfInvited],
  );

  // Initial resolution + re-resolve on provider sign-in/out events.
  useEffect(() => {
    void refresh();
    let subscription: { unsubscribe(): void } | null = null;
    try {
      const handle = clientOf().auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') void refresh();
      });
      subscription = handle.data.subscription;
    } catch {
      // Unconfigured client: refresh() already surfaced the error state.
    }
    return () => subscription?.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = useCallback(
    async (provider: OAuthProvider): Promise<LoginResult> => {
      let client: SupabaseClient;
      try {
        client = clientOf();
      } catch (cause) {
        return {
          status: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: false,
        };
      }
      const result = await startLogin(provider, { client });
      if (result.status === 'authenticated') {
        // A session without a usable account id is unrecoverable — never
        // enter the app on it (Task 0 session helpers).
        const outcome = classifyCompletedLogin({ provider, session: result.session });
        if (outcome.kind === 'unrecoverable') {
          return {
            status: 'failed',
            message: 'The sign-in response did not contain an account.',
            retryable: true,
          };
        }
        await refresh();
      }
      return result;
    },
    [clientOf, refresh],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      error,
      accountId,
      registration,
      onboardingSeen,
      storage,
      refresh,
      signIn,
      submitRegistration,
      markOnboardingSeen,
      markOnboardingSeenIfInvited,
    }),
    [
      status,
      error,
      accountId,
      registration,
      onboardingSeen,
      storage,
      refresh,
      signIn,
      submitRegistration,
      markOnboardingSeen,
      markOnboardingSeenIfInvited,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Classifies the state right after an OAuth code exchange, built on the
 * Task 0 session helper: a session with a user id is a returning session
 * (its registration state is then read from the server); anything else is
 * unrecoverable and the user is sent back to login with a retry.
 */
export function classifyCompletedLogin(input: {
  provider: OAuthProvider;
  session: Session | null;
}):
  | { kind: 'returning'; accountId: string }
  | { kind: 'register' }
  | { kind: 'unrecoverable' } {
  const outcome = resolveSessionOutcome({
    provider: input.provider,
    accountId: input.session?.user?.id ?? null,
    providerAccountSelected: input.session !== null,
    allMethodsLost: input.session === null,
  });
  switch (outcome.kind) {
    case 'returning':
      return { kind: 'returning', accountId: outcome.accountId };
    case 'register':
      return { kind: 'register' };
    case 'unrecoverable':
      return { kind: 'unrecoverable' };
  }
}
