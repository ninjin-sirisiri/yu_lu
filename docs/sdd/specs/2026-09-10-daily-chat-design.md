# Daily Chat design

**Classification:** architectural

**Chosen approach:** Cross-platform single codebase plus managed backend. The client uses one codebase for iOS and Android. The backend uses a managed platform with database, auth, storage, realtime delivery, scheduled jobs, and push integration. Strict daily ordering lives in one server-side job. If stricter control becomes necessary, extract only that part to a custom API.

## Goals

- Assign a random daily chat partner from existing friends every day.
- Continue the Streak by sending to the Send Target and replying to all Reply Targets.
- Show the current Streak count to all friends to acknowledge continuation.
- Support iOS and Android with a small team.
- Keep receiving, sending, images, editing, withdrawal, blocking reservation, notifications, and visibility in one coherent daily-chat scope.

## Non-goals

- Registration and friend request and approval flow design.
- Automatic image moderation.
- Ranking display.
- Support for languages other than Japanese.
- Support for time zones other than Japan time.
- Scoring the value of chat content.

## Architecture

- Client with one codebase for iOS and Android.
- Client holds the authenticated session, conversation screen, send states, daily progress for the user, Streak count, image selection and upload and display, edit and withdrawal and history, block reservation and mute and hide and report, and push reception.
- Server side provides auth, database, image storage, realtime delivery, scheduled jobs, and push integration.
- Server is the only place that decides completion, Streak increment, and Streak reset.
- The truth for send and receive time is server acceptance time.
- External push delivery uses platform push services.
- Device background execution is used only within OS limits for automatic resend.

## Components

- **Assignment:** Creates and stores the daily Send Target and Reply Targets. New friendships apply from the next day. A failed day creates no assignment and is out of scope.
- **Message:** Handles one message as optional body plus zero or more images. Blank-only body with no image cannot be sent. Edit history is kept. Withdrawn content is not shown.
- **Completion:** Checks Send Target transmission and per Reply Target receive-then-send order. Achieved Reply Targets stay achieved for the day. Withdrawal does not change existing achievement or receipt facts.
- **Streak:** Adds one on the day conditions are all met. Resets to zero at 04:00 when unmet. Restarts from one on next achievement.
- **Relationship Guard:** Forbids blocking and unfriending the daily targets during the day. Accepts block reservations during the day and applies them after daily settlement before the next draw. Allows mute, hide, and report without changing conditions.
- **Notification:** Sends assignment confirmation, per-message reception, and pre-deadline warnings at fixed Japan times in Japanese.
- **Visibility:** Shows only the current count to friends. Shows per-person sent and received and replied state only to the user.
- **Media and Report:** Enforces image size and count limits. Accepts reports with manual handling and no automatic moderation.

## Data flow

1. Client sends a message to the server.
2. Server accepts the message and records acceptance time.
3. Server delivers the message through realtime delivery.
4. Recipient conversation screen reflects the message.
5. Server evaluates completion and increments the Streak at the moment conditions are met.
6. Image upload goes to storage first, then links to the message, then delivers to recipients.
7. Daily job runs settlement, then relationship changes, then the next draw.
8. Notification job creates push requests at fixed times for delivery through platform push services.

## Ordering guarantees

- Daily processing at 04:00 follows settlement, then reservation and relationship reflection, then draw.
- A reply requires Reply Target receipt time strictly before own send time. Equal timestamps do not count as a reply.
- Once a Reply Target is achieved for the day, later incoming messages do not revert it.
- Editing does not change send time or order.
- Withdrawal does not change achievement or receipt facts.
- Reply duty remains even when the original message was withdrawn before replying.
- Automatic resend after the deadline does not count for the previous day.

## Numeric defaults

| Area | Default |
| --- | --- |
| Day boundary | 04:00 Japan time |
| Assignment notification | 07:00 Japan time |
| Pre-deadline warnings | 22:00 and 02:30 Japan time |
| Images per message | Up to 4 images |
| Image size | Up to 10 MB per image |
| Supported image formats | JPEG, PNG, and HEIC |
| Body limit | 10000 characters |
| Notification body preview | Up to 100 characters |
| Notification image thumbnail | One image at 512 px long edge |
| Automatic resend | Exponential backoff for up to 24 hours |
| Edit history | Latest 20 generations |
| Image retention | Indefinite in the first version |

## Error handling

- When the daily draw fails, create no assignment for that day, keep counts unchanged, and allow read-only access to prior history.
- Before server acceptance, show sending or failed states and resend automatically within OS limits.
- Unaccepted messages do not count toward completion.
- Show that resend may miss the deadline.
- Push delay or loss does not change server deadlines or judgments.
- The app shows current targets and progress when opened.
- Treat duplicate acceptance of the same message as one message.
- Late acceptance after the deadline does not count for the previous day.
- Accept reports and handle them manually without automatic moderation.
- Allow block reservation cancellation before application and exclude reserved users from the next draw after application.

## Negative requirements

- Do not design registration and friend request and approval flow here.
- Do not build ranking display.
- Do not add automatic image moderation.
- Do not support languages or time zones beyond Japanese and Japan time.
- Do not score chat content value.
- Do not change achieved completion or receipt facts on withdrawal.
- Do not judge completion by device clock or read state.
- Do not show unmet breakdown or responsibility to anyone except the user.
- Do not add grace for last-minute reception.
- Do not allow blocking or unfriending daily targets during the day except by reservation.

## Testing

- New friendships apply from the next day.
- A failed day is out of scope and preserves counts.
- Messages link to the correct friends.
- Send Target transmission satisfies its condition.
- Only post-receipt sends count as replies per Reply Target.
- Equal timestamps do not count as replies.
- Mutual assignment needs one more message for the second achievement.
- A silent Reply Target makes the day unmet.
- Last-minute reception has no grace.
- Reply duty remains after pre-reply withdrawal.
- Editing does not change send time or order.
- Streak increments at achievement and resets at 04:00 when unmet.
- Next achievement restarts from one.
- Daily targets cannot be blocked or unfriended during the day.
- Block reservations apply before the next draw.
- Blank-only body with no image cannot be sent.
- Image failure is unsent and subject to resend.
- Edit history and withdrawal display follow the rules.
- Scheduled notifications use Japan time.
- Friends see only the count with no breakdown.
- The user sees per-person progress.

## Consuming paths

- `CONTEXT.md`
- `CONTEXT.html`
- `docs/sdd/assets/sdd.css`
- `docs/sdd/specs/2026-09-10-daily-chat-design.md`
- `docs/sdd/specs/2026-09-10-daily-chat-design.html`
