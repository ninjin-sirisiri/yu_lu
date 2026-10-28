# Common conversation UI (Task 17)

## Entry and ownership

Use `conversationEntry(peerId, 'home' | 'chat' | 'profile')`. The shared route
`/conversations/[peerId]` guards authentication and completed registration,
rejects malformed/self peers, and never accepts a return URL. Back uses the
existing in-app navigation history; without history, the finite origin maps to
`/home`, `/chat`, or `/friends/<same-peer>`. Warm destination recording retains
only the validated peer and origin, not arbitrary query parameters.

`ConversationPanel` uses the existing `useChat()` account owner. Reuse it in
the later split-list presentation, passing `active=false` when covered or not
selected. Do not create another provider/repository/worker. Optional `onBack`
and `onOpenSendStatus` callbacks keep the panel independent of Router. The
standalone route wires the latter to the existing `/mypage/sync` screen.

## History and read intent

- Initial repository loading uses `first_unread`, never `jumpLatest`.
- Variable-height history is positioned after layout, with a bounded
  measure/scroll retry; no fabricated fixed-row `getItemLayout` or
  unsupported `initialScrollIndex` assumption. Viewability configuration and
  its callback retain stable native identities.
- Paging uses the returned before/after cursors (50-message server pages),
  with native visible-position maintenance. A first-unread realtime refresh
  preserves an already extended cursor edge unless its response extends it.
- Viewport offsets/follow intent are scoped to the provider session and peer.
  Remounting a presentation does not replace drafts or cursor state.
- Only reported visible incoming IDs are recorded while the panel is active,
  the app is foregrounded, this peer is selected, and no image modal covers it.
  Merely fetching, rendering offscreen, following an arrival or reopening a
  screen never creates a prefix read intent.
- The explicit latest/new-arrival button uses the repository's fetched fixed
  bound. Automatic arrivals follow only an already-bottom viewport; past
  reading retains position and offers navigation.
- Pending synchronization and inexact unread metadata are labeled, without
  manufacturing an exact count. Stale daily snapshots retain their actual
  date and are not labeled today's role. Server fields determine role/status.

## Composer and local send items

`Composer` serializes durable peer-draft writes while keeping input responsive.
`enqueueMessage({ body, attachments, clearDraft: true })` now clears the durable
composer in the SAME guarded transaction as enqueue and attachment pinning.
Failure leaves both the displayed and stored input intact and no queued send.
Once enqueue commits, a subsequent snapshot-publication failure is recovered
independently and does not misreport the committed send as a failed reservation.
The existing shared sender owns dispatch, retry, leases and FIFO.

`MessageInput` invokes the real library-only picker and existing chat image
processor: up to four durable JPEG/PNG references, original JPEG/PNG/HEIC,
10MiB checks, orientation, aspect fit, metadata stripping and existing quality
rules. Text-only, image-only and combined sends use existing exact validation.
The `media` port is injectable for tests; default production ports are native.

The repository snapshot adds `cancelled` separately from accepted `messages`
and unresolved `pending`. Guarded facade methods are `cancelUnsent`,
`saveCancelled`, `discardCancelled`, and `retryConfirmed`. A cancelled item's
editor never replaces the current composer. Explicit resend uses the queue's
new-operation rules (cancelled items join the tail; unresolved eligible items
retain their position) and the currently confirmed relationship epoch.
Unknown/dispatched and relationship-stopped items cannot be cancelled, edited,
or retried as new. Accepted rows have no editing/withdrawal actions. Canonical
`canSend`, rather than cached metadata alone, enables new sends.

## Private images and native layout

`ImageViewer` receives a message identity and a relative remote path, never an
external URL. The loader checks accepted local membership/redaction and live
account ownership, uses the existing authenticated Supabase client/session,
and GETs the configured project's private authenticated Storage endpoint with
an explicitly pinned actor token. Cache IO is followed by another ownership
check before HTTP dispatch. Redirects, URL/path traversal and foreign scopes
are rejected. No signed URLs or credentials enter SQLite or Image sources.

Downloaded bytes use the existing account-scoped 100MiB LRU. Guarded cache
publication cannot recreate purged rows; rolled-back newly imported viewing
files are removed even on generation invalidation without account logout.
The dialog only displays the returned local copy; withdrawals close it.

Existing theme tokens, safe-area screen framing, native keyboard avoidance,
scrollable editor/actions, wrapping controls and uncapped font scaling are
used. History tools scroll rather than consuming all remaining space at large
text sizes. The modal supports close, accessibility escape, Android Back,
and button zoom with horizontal/vertical scrolling, in addition to native
iOS pinch zoom. No animation, OS notification permission, list/home screen,
banner, relationship-management UI or new backend boundary is introduced.

Verification is mocked-transport React Native/Router plus real SQLite/files,
not a physical-device visual or live HTTP journey. See the Task17 report for
actual command results and the pre-existing SDK57 patch-check warning.
