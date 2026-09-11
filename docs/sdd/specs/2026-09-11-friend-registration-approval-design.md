# Friend registration and approval design

**Classification:** architectural

**Chosen approach:** Supabase single stack with acceptance of same verified-email auto-linking. The client uses Apple or Google OAuth only, with no shared mandatory contact. Supabase Auth plus data storage is used. Apple and Google logins that share the same verified email are accepted as one account under Supabase Auth standard behavior. OAuth logins with different emails are never auto-linked. Adding a different-email method requires explicit linking after signing into the existing account and verifying the new method.

## Goals

- Complete OAuth registration through profile creation.
- Find a partner by User ID, Invitation link or QR, and ID search, then send and approve a Friend Request.
- Return an unregistered Invitation opener to the Invitation automatically after registration and User ID confirmation.
- Keep request, approval, expiry, notification, and zero-friend handling consistent.
- Connect with the existing daily draw, Streak, and relationship protection.

## Non-goals

- Email or SMS authentication, passwords, recovery codes, and operator recovery.
- Merging two separately created accounts.
- In-request block and report flows, except post-report restriction.
- Ranking, automatic image moderation, and support beyond Japanese and Japan time.

## Architecture

- Client with one codebase for iOS and Android.
- Client holds the OAuth session, User ID decision, profile creation and editing, request inbox and outbox, Invitation display and opening, pre-request confirmation, zero-friend guidance, and push reception.
- Server side provides auth, database, image storage, and push integration.
- Server is the only place that confirms User ID uniqueness, request state transitions, friendship creation, and expiry.
- New friendships apply from the next daily draw.
- A zero-friend day creates no assignment, preserves the Streak, and allows read-only access to prior history.

## Components

- **Registration:** Verifies Apple or Google OAuth identity, confirms the User ID and display name, accepts optional image and introduction, and blocks app use until the User ID is confirmed.
- **Profile:** Keeps the internal account separate from the searchable User ID. Shows name, User ID, image, and introduction before approval, and adds the current Streak only for the user and established Friends. Never shows per-partner send and reply state to others.
- **Discovery:** Resolves exactly one candidate from an exchanged User ID. Opens an Invitation link or QR to the inviter display plus request button within its 7-day validity. Supports ID search to the same pre-request confirmation.
- **Invitation:** Shares a time-limited link or QR code that opens the inviter display and starts a Friend Request. Expires after 7 days. Keeps the invitation identifier for an unregistered opener and returns automatically after OAuth registration and User ID confirmation.
- **Friend Request:** Sends one request from sender to recipient. Allows sender cancellation at any time. Allows recipient approval or rejection only. Hides rejection facts from the sender and shows only a neutral non-establishment message. Creates no duplicate while one is pending. Treats crossed requests as immediate establishment with notice to both sides. Expires automatically after 7 days.
- **Relationship Guard:** Allows block and delete only for established Friends. Forbids blocking a request-only partner. Rejects new requests while blocked and allows re-request after unblock. Keeps delete and report from affecting re-request eligibility. Preserves existing same-day draw protection and time and order rules.
- **Notification:** Sends request arrival, approval establishment, mutual establishment, expiry guidance, and invitation expiry guidance in Japanese.
- **Visibility:** Shows the current Streak count only to established Friends. Shows per-partner progress only to the user. Shows the no-change explanation on zero-friend days.

## Data flow

1. Client verifies OAuth identity and confirms the User ID.
2. Server creates the profile after confirming User ID uniqueness.
3. Client resolves a partner by User ID, Invitation, or ID search and shows the pre-request confirmation.
4. Client sends the Friend Request to the server.
5. Server stores the pending request with its expiry.
6. Recipient approves or rejects the request.
7. Server creates the friendship on approval and clears related requests.
8. Established friendships become eligible from the next draw.
9. A zero-friend day creates no assignment and preserves counts.

## Ordering guarantees

- Crossed requests establish friendship when both directions are expressed.
- Related requests are cleared at establishment.
- No unanswered request remains after friendship establishment.
- Expiry, cancellation, and rejection never establish friendship.
- A duplicate request is never created while one is pending.
- Blocked recipients accept no new request until unblock.
- Request-only partners cannot be blocked.

## Numeric defaults

| Area | Default |
| --- | --- |
| Invitation validity | 7 days |
| Friend Request validity | 7 days |
| User ID reservation hold | None |
| User ID case handling | Case-insensitive identity with display preserved |

## Error handling

- Expired Invitations cannot start a request and guide the user to reissue.
- Expired requests lapse automatically and guide the user to re-request.
- Rejection reason and timing are never disclosed.
- Duplicate requests guide the user to the existing pending request.
- Requests to blocked recipients are rejected.
- User ID collisions reject confirmation and suggest similar IDs.

## Negative requirements

- Do not offer email or SMS authentication, passwords, recovery codes, or operator recovery.
- Do not merge two separately created accounts.
- Do not auto-link OAuth logins with different emails.
- Do not use Apple private relay addresses for contact purposes.
- Do not allow app use before User ID confirmation.
- Do not allow User ID changes after confirmation.
- Do not create a separate add code apart from the User ID.
- Do not disclose rejection facts, reasons, or timing.
- Do not allow blocking of request-only partners.
- Do not apply rate limits to requests or searches in the first version.
- Do not use friend or display-name information for operator identity verification.

## Testing

- OAuth registration completes User ID confirmation and profile creation.
- All three entry points reach pre-request confirmation.
- An unregistered Invitation returns after registration and User ID confirmation.
- Recipient approval establishes friendship, while crossed requests establish immediately with notice to both.
- Cancellation, rejection, and expiry never establish friendship.
- Rejection display contains no reason or timing.
- No duplicate request is created while one is pending.
- Blocked recipients reject new requests and accept re-request after unblock.
- Request-only partners cannot be blocked.
- Zero-friend days stay out of the draw and preserve the Streak.
- Same verified-email auto-linking is accepted.
- Different-email auto-linking never happens.

## Consuming paths

- `CONTEXT.md`
- `CONTEXT.html`
- `docs/sdd/assets/sdd.css`
- `docs/sdd/specs/2026-09-11-friend-registration-approval-design.md`
- `docs/sdd/specs/2026-09-11-friend-registration-approval-design.html`
