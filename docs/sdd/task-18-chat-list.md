# Chat list and friend entry (Task 18)

## Presentation

`/chat` renders `ChatWorkspace` and `ChatList`; `/chat/new` is a stack child,
not a fifth tab. Narrow list entry uses `conversationEntry(peerId, 'chat')`.
The current-friend picker and profile's friend-only message button use the
same guarded common route, with finite `chat` / `profile` origins. Pending
requests have no message entry, and the conversation repository remains the
authority for live send permission if a relationship changes after selection.

At logical width >=900 and font scale <=1.3, the workspace shows the list and
the existing `ConversationPanel`. A selected split panel stays mounted when
shrinking to one column or increasing text size. Selection is presentation-only;
the account provider still owns peer repositories, composer drafts, paging and
viewport memory. Switching peers restores their separate drafts/scroll. Covered
panels receive `active=false`. Back/reselect returns to the list; reselect also
scrolls its actual scrollable to the top. Other-tab switches retain the stack.

## Repository projection

`HomeSnapshot.targets` / `others` are `ChatListRow[]` (a `ChatSummary` subtype).
The optional `local` contains `{ draft, states, updatedAt, only }`; it is computed
from the existing account SQLite data, never sent to the backend or another
device. No additional provider, sender, relationship query or server API exists.

- All daily targets remain separate from the 20-item server other-chat pages.
- Daily status order and microsecond receipt/message-ID order are preserved.
  Empty targets retain the server's registered-User-ID order: that field is not
  exposed in the chat DTO, so display names/internal UUIDs cannot replace it.
- Other rows merge server pages, accepted local history/receipts, nonempty
  text/image drafts, and unresolved/cancelled local sends by peer ID. Receipt
  sequence can advance a stale server row, but drafts cannot change an accepted
  chat's sort timestamp. Equal local timestamps use the internal peer ID.
- `listChatDrafts` omits empty composers. `listLocalMessagePeers` derives
  membership from actual accepted messages, not viewed-peer metadata. A viewed
  empty non-target friend never becomes a list row.
- Composer persistence publishes a new home/list projection. Explicit local
  outbox actions record account-scoped `chat.localActivity.<peer>` in their
  existing guarded transaction; draft timestamps and queue creation timestamps
  supply the other local activity times. Receipt facts are never labeled pending.
- Pagination failure retains loaded rows/cursor and offers retry. Friend selection
  also pages/deduplicates, retains loaded entries on failure, and fences late
  account/blur responses.

Unread row labels consume the same Task15 overlay as the peer count. When
`unreadCountsExact=false`, they explicitly show conservative upper bounds and
synchronization uncertainty; pending reads are labeled separately. Stale targets
retain their actual date and are not presented as today's roles/achievement.

Theme tokens, scalable wrapping native text, safe-area frames, semantic controls,
48-unit minimum touch targets and shared busy/disabled feedback are reused.
No home dashboard, badge/banner host, OS notification permission, relationship
management screen, search, or new message editing/withdrawal action is added.
