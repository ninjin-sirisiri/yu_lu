import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useAuth } from '../auth/provider';
import { getAppClient } from '../backend/client';
import { createChatClient, type ChatClient } from '../backend/chat';
import { createHomeRepository, type HomeSnapshot } from '../daily/homeRepository';
import type { Storage } from '../storage/database';
import { listReadIntents, readChatDraft, saveChatDraft } from '../storage/chat';
import { createCommandApi, type CommandApi } from '../sync/api';
import { expoNetworkPort, getSharedSyncLifecycle, type NetworkPort } from '../sync/lifecycle';
import { backoffDelay } from '../sync/retry';
import { registerChatLifetime } from './lifetime';
import { createChatRealtime, type ChatRealtimePort } from './realtime';
import { createReadStateRepository } from './readState';
import { createConversationRepository, createRepositorySession, type ConversationSnapshot } from './repository';
import type { ChatDraft as StoredChatDraft } from './types';

export type ChatDraft = Pick<StoredChatDraft, 'body' | 'attachments'>;
export interface ChatState {
  accountId: string; activePeerId: string | null; foreground: boolean; connected: boolean;
  home: HomeSnapshot | null; conversation: ConversationSnapshot | null;
  drafts: Readonly<Record<string, ChatDraft>>;
  pendingReadSync: boolean; refreshPending: boolean; error: string | null; stopped: boolean;
}
export interface ChatStoreDeps {
  storage: Storage; accountId: string; getAccountId(): Promise<string | null>;
  client: ChatClient; commandApi: CommandApi; realtime: ChatRealtimePort;
  appState?: { currentState?: string | null; addEventListener(event: 'change', listener: (state: string) => void): { remove(): void } } | null;
  network?: NetworkPort | null;
  /** Wake the EXISTING shared sender, never another worker/FIFO. Not awaited by reads. */
  drainOutbox?(): Promise<unknown>;
  elapsedNow?: () => number; random?: () => number;
}

/** One irreversible account owner. Platform/transport ports are injected; the
 * repositories, read intents, receipt reconciliation and SQLite stay real. */
export function createChatStore(deps: ChatStoreDeps) {
  const session = createRepositorySession(deps);
  const reads = createReadStateRepository({ session, commandApi: deps.commandApi });
  const now = deps.elapsedNow ?? (() => performance.now());
  const homeRepository = createHomeRepository({ session, client: deps.client, reads, now });
  const appState = deps.appState === undefined ? AppState : deps.appState;
  const peers = new Map<string, ReturnType<typeof createConversationRepository>>();
  const draftGenerations = new Map<string, number>();
  const listeners = new Set<() => void>();
  const cleanup: Array<() => void> = [];
  let state: ChatState = { accountId: deps.accountId, activePeerId: null,
    foreground: appState ? appState.currentState === 'active' : true, connected: false,
    home: null, conversation: null, drafts: {}, pendingReadSync: false, refreshPending: false, error: null, stopped: false };
  let started = false;
  let stopped = false;
  let publishGeneration = 0;
  let revision = -1;
  let fetchRunning = false;
  let fetchRequested = false;
  let readRunning = false;
  let readRequested = false;
  let outboxRunning = false;
  let outboxRequested = false;
  let fetchAttempt = 0;
  let readAttempt = 0;
  type Timer = ReturnType<typeof setTimeout>;
  let fetchTimer: Timer | null = null;
  let readTimer: Timer | null = null;
  let boundaryTimer: Timer | null = null;
  let unregister: (() => void) | null = null;
  const canRun = () => started && !stopped && state.foreground;
  function update(value: Partial<ChatState>) {
    if (stopped && !value.stopped) return;
    state = { ...state, ...value };
    for (const listener of listeners) listener();
  }
  function clearTimers() {
    if (fetchTimer !== null) clearTimeout(fetchTimer);
    if (readTimer !== null) clearTimeout(readTimer);
    if (boundaryTimer !== null) clearTimeout(boundaryTimer);
    fetchTimer = readTimer = boundaryTimer = null;
  }
  function timer(callback: () => void, delay: number): Timer {
    const handle = setTimeout(() => { if (canRun()) callback(); }, Math.min(2_147_483_647, Math.max(1, delay)));
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
  }
  function rawPeer(peerId: string) {
    let peer = peers.get(peerId);
    if (!peer) {
      peer = createConversationRepository({ session, peerId, client: deps.client, reads });
      if (stopped) peer.dispose();
      peers.set(peerId, peer);
    }
    return peer;
  }
  async function publish() {
    const generation = ++publishGeneration;
    const peerId = state.activePeerId;
    const [home, conversation, intents] = await Promise.all([homeRepository.snapshot(),
      peerId ? rawPeer(peerId).snapshot() : null, listReadIntents(deps.storage, deps.accountId)]);
    if (!await session.active()) { stop(); return; }
    if (stopped || generation !== publishGeneration || peerId !== state.activePeerId) return;
    update({ home, conversation, pendingReadSync: intents.length > 0 });
  }
  function armBoundary(startedAt: number) {
    if (boundaryTimer !== null) clearTimeout(boundaryTimer);
    const home = state.home?.home;
    if (!canRun() || !home) return;
    // Server-relative remaining duration; no device-calendar achievement/day math.
    const remaining = Date.parse(home.deadline) - Date.parse(home.server_now) - (now() - startedAt);
    if (Number.isFinite(remaining)) boundaryTimer = timer(() => { boundaryTimer = null; refresh(); }, Math.max(1_000, remaining));
  }
  function requestFetch() {
    if (stopped) return;
    fetchRequested = true;
    if (fetchTimer !== null) clearTimeout(fetchTimer);
    fetchTimer = null;
    if (canRun()) void runFetch();
  }
  async function runFetch() {
    if (!canRun() || fetchRunning || !fetchRequested) return;
    fetchRunning = true; fetchRequested = false;
    update({ refreshPending: true });
    const startedAt = now();
    let accepted = false;
    try {
      if (!await session.active()) { stop(); return; }
      const peerId = state.activePeerId;
      // Concurrent, not on the sender promise chain; one failure cannot suppress
      // the other repository's accepted data or relationship/outbox reconciliation.
      const results = await Promise.allSettled([homeRepository.refreshHome(),
        peerId ? rawPeer(peerId).loadInitial() : Promise.resolve(true)]);
      accepted = results.every(result => result.status === 'fulfilled' && result.value);
      if (!stopped) {
        update({ error: accepted ? null : 'Chat refresh pending.' });
        await publish();
        if (accepted) { fetchAttempt = 0; armBoundary(startedAt); }
      }
    } catch {
      update({ error: 'Chat refresh pending.' });
    } finally {
      fetchRunning = false;
      if (canRun()) {
        if (fetchRequested) void runFetch();
        else if (!accepted) fetchTimer = timer(() => { fetchTimer = null; requestFetch(); }, backoffDelay(++fetchAttempt, deps.random ?? Math.random));
        else update({ refreshPending: false });
      }
    }
  }
  function requestReads() {
    if (stopped) return;
    readRequested = true;
    if (readTimer !== null) clearTimeout(readTimer);
    readTimer = null;
    if (canRun()) void runReads();
  }
  async function runReads() {
    if (!canRun() || readRunning || !readRequested) return;
    readRunning = true; readRequested = false;
    let pending = true;
    try {
      if (!await session.active()) { stop(); return; }
      const before = await reads.version();
      await reads.sync();
      pending = (await listReadIntents(deps.storage, deps.accountId)).length > 0;
      if (await reads.version() !== before) requestFetch();
      await publish();
    } catch { /* Durable intents remain pending, retry independently. */ }
    finally {
      readRunning = false;
      if (canRun()) {
        if (readRequested) void runReads();
        else if (pending) readTimer = timer(() => { readTimer = null; requestReads(); }, backoffDelay(++readAttempt, deps.random ?? Math.random));
        else readAttempt = 0;
      }
    }
  }
  function wakeOutbox() {
    if (!canRun() || !deps.drainOutbox) return;
    outboxRequested = true;
    if (outboxRunning) return;
    outboxRequested = false; outboxRunning = true;
    // Do not wait for a possibly-dispatched FIFO head to recover home/unread.
    void Promise.resolve().then(async () => {
      if (canRun() && await session.active()) await deps.drainOutbox?.();
    }).catch(() => { /* The existing sender owns its retry/uncertainty rules. */ }).finally(() => {
      outboxRunning = false;
      if (canRun()) { requestFetch(); if (outboxRequested) wakeOutbox(); }
    });
  }
  function refresh() { requestReads(); requestFetch(); wakeOutbox(); }
  function stop() {
    if (stopped) return;
    session.stop(); // FIRST: revoke writes even while transport cleanup awaits.
    stopped = true; publishGeneration++;
    clearTimers(); unregister?.(); unregister = null;
    for (const detach of cleanup.splice(0)) {
      try { detach(); } catch { /* All remaining callbacks are still revoked. */ }
    }
    homeRepository.dispose(); for (const peer of peers.values()) peer.dispose();
    update({ stopped: true, activePeerId: null, home: null, conversation: null, drafts: {},
      connected: false, pendingReadSync: false, refreshPending: false });
  }
  const wrappedPeers = new Map<string, ReturnType<typeof wrapPeer>>();
  function wrapPeer(peerId: string) {
    const peer = rawPeer(peerId);
    const load = async (action: () => Promise<boolean>, read = false) => {
      const accepted = await action();
      if (!stopped) { await publish(); if (read) requestReads(); if (!accepted) requestFetch(); }
      return accepted;
    };
    return { snapshot: peer.snapshot,
      loadInitial: () => load(peer.loadInitial), loadBefore: () => load(peer.loadBefore), loadAfter: () => load(peer.loadAfter),
      jumpLatest: () => load(peer.jumpLatest, true),
      async recordVisible(ids: readonly string[]) {
        await peer.recordVisible(ids); if (!stopped) { await publish(); requestReads(); }
      },
      async enqueueMessage(input: Parameters<typeof peer.enqueueMessage>[0]) {
        const id = await peer.enqueueMessage(input);
        if (!stopped) {
          if (input.clearDraft) update({ drafts: { ...state.drafts, [peerId]: { body: '', attachments: [] } } });
          // Enqueue already committed. A view/cache refresh failure must not
          // reject that receipt and invite another tap with a fresh client key.
          try { await publish(); }
          catch { update({ error: 'Chat refresh pending.' }); requestFetch(); }
          wakeOutbox();
        } return id;
      },
      async cancelUnsent(id: string) { const result = await peer.cancelUnsent(id); await publish(); return result; },
      async saveCancelled(id: string, draft: ChatDraft) { const result = await peer.saveCancelled(id, draft); await publish(); return result; },
      async discardCancelled(id: string) { const result = await peer.discardCancelled(id); await publish(); return result; },
      async retryConfirmed(id: string) { const result = await peer.retryConfirmed(id); await publish(); wakeOutbox(); return result; },
    };
  }
  async function attach() {
    try {
      if (!await session.active()) { stop(); return; }
      if (stopped) return;
      if (appState) {
        const subscription = appState.addEventListener('change', value => {
          if (stopped) return;
          const foreground = value === 'active';
          const resumed = foreground && !state.foreground;
          update({ foreground });
          if (resumed) refresh();
          else if (!foreground) clearTimers();
        });
        cleanup.push(() => subscription.remove());
      }
      const network = deps.network === undefined ? expoNetworkPort() : deps.network;
      let connected: boolean | null = null;
      if (network) cleanup.push(network.subscribe(value => {
        if (stopped) return;
        if (value && connected !== true) refresh();
        connected = value;
      }));
      try {
        cleanup.push(deps.realtime.subscribe(deps.accountId, {
          revision(value) {
            if (stopped || !Number.isSafeInteger(value) || value < 0 || value <= revision) return;
            revision = value; session.observeRevision(value); refresh();
          },
          status(value) {
            if (stopped) return;
            update({ connected: value === 'SUBSCRIBED' });
            // Every establishment, including reconnect, closes the fetch/join
            // gap even if no event was delivered during disconnection.
            if (value === 'SUBSCRIBED') refresh();
          },
        }));
      } catch { update({ connected: false, error: 'Chat connection unavailable.' }); }
      refresh();
    } catch { stop(); }
  }
  return {
    session,
    reads: { ...reads, async record(peerId: string, conversationId: string, ids: readonly string[], through: number | null) {
      await reads.record(peerId, conversationId, ids, through);
      if (!stopped) { await publish(); requestReads(); }
    } },
    homeRepository: { snapshot: homeRepository.snapshot,
      async refreshHome() { const accepted = await homeRepository.refreshHome(); await publish(); return accepted; },
      async loadMore() { const accepted = await homeRepository.loadMore(); await publish(); return accepted; },
    },
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (started || stopped) return;
      started = true;
      unregister = registerChatLifetime(deps.accountId, stop);
      void attach();
    },
    stop, refresh,
    getConversation(peerId: string) {
      let peer = wrappedPeers.get(peerId);
      if (!peer) { peer = wrapPeer(peerId); wrappedPeers.set(peerId, peer); }
      return peer;
    },
    selectPeer(peerId: string | null) {
      if (stopped || state.activePeerId === peerId) return;
      publishGeneration++;
      update({ activePeerId: peerId, conversation: null });
      if (peerId) rawPeer(peerId);
      requestFetch();
    },
    async readDraft(peerId: string): Promise<ChatDraft | null> {
      if (stopped || !await session.active()) return null;
      const generation = draftGenerations.get(peerId);
      const draft = await readChatDraft(deps.storage, deps.accountId, peerId);
      if (stopped || !await session.active()) return null;
      if (generation !== draftGenerations.get(peerId)) return state.drafts[peerId] ?? null;
      const value = draft ? { body: draft.body, attachments: draft.attachments } : null;
      if (value) update({ drafts: { ...state.drafts, [peerId]: value } });
      return value;
    },
    async setDraft(peerId: string, draft: ChatDraft): Promise<void> {
      if (stopped) return;
      const generation = (draftGenerations.get(peerId) ?? 0) + 1;
      draftGenerations.set(peerId, generation);
      const value = { body: draft.body, attachments: draft.attachments.map(image => ({ ...image })) };
      const current = () => !stopped && draftGenerations.get(peerId) === generation;
      // A read acknowledgement invalidates query generations, not the user's
      // latest composer edit. Retry only that still-current edit, never a stopped
      // capability or an older edit that has since been replaced.
      while (current() && await session.active()) {
        const applied = await session.commit(session.token(), null, async tx => {
          await saveChatDraft(tx, { ...value, accountId: deps.accountId, peerId, updatedAt: Date.now() }); return true;
        }, current);
        if (applied && current()) { update({ drafts: { ...state.drafts, [peerId]: value } }); return; }
      }
    },
  };
}
export type ChatStore = ReturnType<typeof createChatStore>;
export type ChatContextValue = ChatState & ChatStore;
const ChatContext = createContext<ChatContextValue | null>(null);
export const useChat = () => useContext(ChatContext);

const subscribeUnavailable = () => () => {};
const snapshotUnavailable = () => null;

/** createStore must have stable identity for a lifetime. Creation belongs to
 * the effect: StrictMode cleanup must NEVER reuse a stopped repository session. */
export function ChatProvider({ createStore, children }: { createStore: (() => ChatStore) | null; children: React.ReactNode }) {
  const [owned, setOwned] = useState<{ factory: () => ChatStore; store: ChatStore } | null>(null);
  const store = owned?.factory === createStore ? owned.store : null;
  const state = useSyncExternalStore(store?.subscribe ?? subscribeUnavailable,
    store?.getSnapshot ?? snapshotUnavailable, store?.getSnapshot ?? snapshotUnavailable);
  useEffect(() => {
    if (!createStore) { setOwned(null); return; }
    const owner = createStore(); setOwned({ factory: createStore, store: owner }); owner.start();
    return () => owner.stop();
  }, [createStore]);
  // A stable provider node preserves route-local input/effects during setup.
  return <ChatContext.Provider value={store && state ? { ...store, ...state } : null}>{children}</ChatContext.Provider>;
}

/** Root bridge: existing authenticated Supabase client and storage only. Auth
 * callbacks revoke synchronously, before AuthProvider's async profile refresh. */
export function AuthenticatedChatProvider({ children, client: injectedClient }: { children: React.ReactNode; client?: SupabaseClient }) {
  const auth = useAuth();
  const [authGeneration, setAuthGeneration] = useState(0);
  const [factory, setFactory] = useState<{ accountId: string; storage: Storage; createStore(): ChatStore } | null>(null);
  useEffect(() => {
    if (auth.status !== 'ready' || auth.registration !== 'registered' || !auth.accountId || !auth.storage) {
      setFactory(null); return;
    }
    const accountId = auth.accountId;
    const storage = auth.storage;
    let client: SupabaseClient;
    try { client = injectedClient ?? getAppClient(); }
    catch {
      // AuthProvider owns configuration errors. Keep routes/error recovery
      // mounted without inventing a client or an authenticated chat lifetime.
      setFactory(null); return;
    }
    let owner: ChatStore | null = null;
    let revoked = false;
    const subscription = client.auth.onAuthStateChange((event, session) => {
      if (session?.user.id !== accountId) {
        revoked = true; owner?.stop(); setFactory(null);
      } else if (event === 'SIGNED_IN' && owner?.getSnapshot().stopped) {
        // A rapid sign-out/in may be batched before AuthProvider ever renders
        // null. Rebuild ownership even when the final account ID is unchanged.
        setAuthGeneration(value => value + 1);
      }
    }).data.subscription;
    setFactory({ accountId, storage, createStore() {
      owner = createChatStore({ accountId, storage, client: createChatClient({ client, accountId }),
        commandApi: createCommandApi({ client }), realtime: createChatRealtime(client),
        getAccountId: async () => (await client.auth.getSession()).data.session?.user.id ?? null,
        drainOutbox: () => getSharedSyncLifecycle().drain('foreground') });
      if (revoked) owner.stop();
      return owner;
    } });
    return () => { owner?.stop(); subscription.unsubscribe(); };
  }, [auth.accountId, auth.storage, auth.status, auth.registration, injectedClient, authGeneration]);
  const available = factory?.accountId === auth.accountId && factory?.storage === auth.storage &&
    auth.status === 'ready' && auth.registration === 'registered';
  return <ChatProvider createStore={available && factory ? factory.createStore : null}>{children}</ChatProvider>;
}
