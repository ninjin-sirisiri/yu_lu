# Chat provider integration (Task 16)

`AuthenticatedChatProvider` is mounted once beneath `AuthProvider` in
`app/src/app/_layout.tsx`. It uses the existing authenticated client and storage;
there is no additional Supabase singleton. `useChat()` returns `null` until an
authenticated, registered account and storage are available. Its provider node
does not remount route descendants when ownership becomes available.

## Account ownership

`createChatStore(deps)` owns one irreversible repository session, a read-state
repository, a home/list/unread repository and cached immutable-peer repositories.
Platform, realtime and existing-sender wakeup ports are injectable. `start()` is
idempotent but **cannot revive a stopped store**. React's effect creates a fresh
store for each lifetime (including StrictMode effect replay); `ChatProvider`'s
`createStore` callback must be stable for that lifetime and return a fresh owner.

- Auth callbacks stop the old owner synchronously, before async profile refresh.
  A rapid same-account sign-out/in also creates a fresh session.
- `stop()` stops the session **first**, then revokes callbacks, retry/boundary
  timers, realtime/native subscriptions and all repositories. Late responses
  retain Task15's transactional write/rollback fences.
- `messages/lifetime.ts` registers account owners without importing React into
  logout. Confirmed `performLogout` and pending-logout finalization revoke them
  before worker stop/invalidation/session discard/purge. Declining confirmation
  does not stop anything. Clearing the existing pending marker does not revive
  any old owner.
- A live account/logout check precedes attaching actor realtime. Failed ownership
  checks during work stop the owner, rather than leaving retry timers alive.

## Shared state and calls

`useChat()` exposes the immutable current `ChatState` together with store methods:

- `activePeerId`, `foreground`, `connected`: selection, actual AppState `active`
  status, and realtime subscription establishment respectively. `connected` is
  not a claim that all snapshots are current.
- `home`: Task15's **unchanged** `HomeSnapshot`, including `dayStatus`, actual
  daily key, `unreadCountsExact`, decorated counts and peer badge.
- `conversation`: the selected peer's snapshot, including accepted/pending
  separation and canonical `canSend`. It is cleared immediately on peer change;
  an old peer's response cannot retarget it.
- `pendingReadSync`, `refreshPending`, `error`: synchronization metadata. Future
  panels must label pending synchronization and conservative/inexact counts;
  never display `unreadCountsExact=false` upper bounds as exact counts/zeros.
- `selectPeer(peerId | null)`: selection survives layout/route presentation changes
  in this provider lifetime. Panels should not instantiate their own owners.
- `getConversation(peerId)`: returns the same provider-owned repository facade
  for that peer. Paging, latest jump, visible-ID recording and enqueue retain
  Task15's semantics. Facades publish mutations and schedule independent read
  sync/sender wakeups. Automatic refresh uses `loadInitial`, **not** `jumpLatest`;
  merely receiving a revision never marks a message read. Provider-owned facades
  deliberately do not expose `dispose`; the provider owns their lifetime.
- `homeRepository.refreshHome()`, `loadMore()`, `snapshot()`: the same shared
  repository, with mutation publication. Other-chat paging remains 20 items and
  does not cap daily targets.
- `reads.record(...)`, `state(...)`, `version()`, `sync()`: the shared read union.
  Public `record` schedules sync; its transaction-only composition argument is
  kept internal to repositories. Prefer `recordVisible` or explicit `jumpLatest`
  for UI read intent and let the provider schedule retries.
- `setDraft(peerId, {body, attachments})`, `readDraft(peerId)`, `drafts`: reuse
  Task11's **chat_drafts** and ordered attachment pins, not generic form drafts.
  Only persistent account-owned image references are accepted. Draft saves use
  the same guarded session; a query-generation change caused by a read ack retries
  only the latest edit, never a superseded/stopped capability. Failed persistence
  rejects without overwriting the previous durable composer. `readDraft` hydrates
  the shared in-memory draft map for a selected peer after a new lifetime.
- `refresh()`: coalesced recovery; `stop()`: irreversible revocation.

## Realtime and recovery

`createChatRealtime(existingClient)` subscribes only to public `chat_updates`,
filtered by `user_id=eq.<actor UUID>`. It verifies actor/revision payloads again,
ignores malformed/foreign rows, and revokes callbacks before asynchronous channel
removal. It never subscribes to messages, peer streams, notification receipts or
OS notification APIs. Existing RLS remains the authorization boundary.

An initial fetch is followed by another fetch on **every `SUBSCRIBED`**, closing
the fetch/join race and recovering disconnected arrivals even without an event.
Increasing revision tokens advance Task15's monotonic session floor; duplicate
and reversed events do not enqueue repeated work. A newer invalidation during a
fetch schedules another pass; rejected/incoherent snapshots retry with the
existing 5-second exponential/jittered backoff, capped at 15 minutes.

Read synchronization, home/selected-peer refetch, and the **existing** shared
message sender are independent coalesced lanes. A stalled message FIFO cannot
block reads or home/unread recovery. Read acknowledgements trigger a fresh query;
pending intents retry independently without a 24-hour cutoff. Reconnect, network
regain and foreground resume wake recovery. The server-relative next daily
deadline also wakes a refresh. Backgrounding clears timers; foreground resume
rechecks the server rather than calculating daily achievement locally.

No conversation panels, banner generation, OS permissions or new background
sender were implemented. Tasks17–20 consume these interfaces; subscription or
hydration alone must not be treated as proof of a new arrival/banner.
