# Chat repository integration (Task 15)

These are UI-free, injected repositories. They do not create clients, subscribe
to events, start background workers, download images, or bypass the command API.

## Provider ownership

Create one `createRepositorySession({ storage, accountId, getAccountId })` for
each authenticated provider lifetime. Share it between all conversation, home,
and read-state repositories. `getAccountId` must consult the current auth owner,
not a captured account constant. Call `session.stop()` **before** account switch
or confirmed logout, then use the existing stop/purge lifecycle. A stopped
session is never reusable. The existing `logout.pending` marker also fences all
writes. No late result may recreate purged account rows.
The existing logout finalizer clears that marker to `''`; both repository and
shared send-pipeline guards treat this as cleared, while any nonempty marker
continues to stop work.

Create `createChatClient({ client, accountId })` with the existing authenticated
Supabase client. It exposes `getHome`, `listChats(cursor?)`,
`getMessages(peerId, anchor, cursor?)`, and `getUnread`. DTOs retain Task 8/9 wire
names, ISO timestamp text, opaque cursors, and actor-only revisions. Queries
verify the actor and explicitly pin its credential. `QueryError.status` preserves
HTTP failures. No actor, date override, or local claim field enters a query body.

Forward actor-private realtime revision tokens to `session.observeRevision`.
Revisions are monotonic invalidation tokens, not counts. Repository loads return
`false` when superseded/revoked; actual query/storage errors still reject. A
provider should coalesce/retry invalidations; it must not assume that every
request produced a newly accepted snapshot.

## Per-peer conversation

`createConversationRepository({ session, peerId, client, reads, now? })` binds an
immutable peer. Dispose it when its selection owner goes away; a response cannot
be retargeted to a different peer.

- `loadInitial()` fetches `first_unread` without marking anything read.
- `loadBefore()` / `loadAfter()` use only the corresponding returned cursor.
  Different directions retain each other's cursor. Cache and page overlaps merge
  idempotently, and confirmed history sorts by server sequence, never local time.
- `jumpLatest()` explicitly fetches `latest` and atomically records only that
  response's `latest_sequence` as the read bound. Neither subsequent arrivals nor
  a larger cached sequence can widen this intent.
- `snapshot()` returns `{ messages, pending, metadata, canSend }`. Accepted
  receipts are merged with cached history; pending rows are separate and ordered
  by durable peer FIFO. Actor/client-key matches deduplicate local echoes. A
  history match also durably confirms the outbox receipt and revokes a late worker
  callback. Withdrawal remains monotonically redacted by the storage layer.
- `enqueueMessage({ body, attachments, clientKey? })` requires a live, confirmed
  relationship epoch, calls Task 14's existing durable `sendMessage`, and returns
  the operation ID. Persistent attachment pins and enqueue are atomic. Use
  `canSend`, **not cached `metadata.can_send`**, for UI enablement. A newer home
  relationship response can revoke send permission before this peer refetches.
- `recordVisible(messageIds)` records only loaded incoming receipts actually
  reported visible by the UI. It never infers a prefix from scrolling or marks
  outgoing/unloaded IDs read.

Relationship metadata from home and conversation queries shares a canonical
account/peer cache. Ending/changing an epoch stops old queued work in the same
transaction. Proven unsent rows become `needs_confirmation`. Possibly dispatched
rows use the nonclaimable `relationship_stopped` FIFO blocker, retaining reach
evidence; they must **not** be presented as safely cancelled or retry-as-new.
Definitely rejected rows retain their rejection state and safe local exclusion.
Stopped uncertain rows remain included in the existing logout uncertainty count.
The existing shared sync-status catalog also retains them as unfinished with no
cancel/retry-as-new action; this is compatibility for the new state, not a new
home/chat screen or interaction design.
Refriending never automatically revives either kind. Existing explicit
confirmation/exclusion rules still apply to FIFO blockers. Accepted history can
settle a previously unknown/stopped row normally.

## Durable read union

`createReadStateRepository({ session, commandApi, now?, newId? })` receives the
existing authenticated `CommandApi` (configured with the same client).

- `record(peerId, conversationId, incomingIds, throughSequence)` persists a new
  immutable intent for genuinely new sparse IDs/a stronger explicit bound.
  Its optional transaction handle is for composing inside an already guarded
  repository transaction, not a provider bypass.
- `state(peerId, conversationId)` returns max bound + sparse union, including
  pending and acknowledged state. Visibility never turns into a prefix.
- `sync()` coalesces concurrent drains and replays immutable operation IDs via
  `mark_chat_read`. It is independent of the message outbox/FIFO. Failures keep
  the intent, do not starve another peer, and never expire at 24 hours. A valid,
  covering receipt is merged before the intent is removed atomically. Old
  idempotency receipts cannot undo a newer union.
- `version()` and the optional baseline argument of `state` let home distinguish
  pre-acknowledgement snapshots from fresh server counts. Acknowledgements also
  invalidate in-flight snapshots, avoiding double subtraction.

The foreground provider should call `sync()` when visible reads are recorded and
on reconnect/resume, using its existing coalescing/retry scheduling. This task
does not install an independent automatic background sender.

## Home and daily boundary

`createHomeRepository({ session, client, reads, now? })` exposes `refreshHome()`,
`loadMore()`, `snapshot()`, and `dispose()`. `refreshHome` atomically accepts
home/list/unread snapshots only at one revision and one daily key; concurrent
changes may require another refresh. `loadMore` keeps every daily target separate
from other-chat pages, deduplicates peers, and stops at a null cursor.

Inject a monotonic elapsed clock for home (default `performance.now`). It adds
elapsed time to the fetched `server_now` and compares with the server's next
04:00-JST `deadline`. A reopened cache has no trusted live clock and is `stale`,
not relabeled today. `snapshot().home.daily_key` always remains its actual day;
`dayStatus` is `current`, `stale`, or `unavailable`. Refresh on boundary/resume;
never calculate achievement, reply completion, or streak locally.

Counts and badge use the same pending read overlay over **all** unread peers,
including those not in a loaded other-chat page. Bounded jumps clear the fetched
snapshot only; newer arrivals remain unread. The four query DTOs expose a count
and first hole, **not** each message's server sparse-read membership. Consequently
the client subtracts only provably unread IDs. If a partial page or a preexisting
sparse hole prevents exact inference, `unreadCountsExact` is false and the
optimistic counts/badge are conservative upper bounds, not fabricated exact
zeros. The UI must preserve that uncertainty until an authoritative refresh;
do not silently display an inexact count as exact. Full-range proof and latest
bounds produce exact counts without inventing a new server read API.
