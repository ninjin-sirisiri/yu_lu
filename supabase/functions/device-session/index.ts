// Task 18: device (push token) registration endpoint - authenticated only.
//
// Ownership: this function owns the client-facing registration contract
// that Task 19 calls with the user JWT. The flow lives in
// _shared/notifications.ts so tests import it without binding a port; this
// file only starts the server (the app-query entry-point pattern).
//
// Contract (kept deliberately small for Task 19/20):
// - POST {action: "register", push_token: "<string>"}
//     -> 200 {action: "register", device_id: "<uuid>", status: "registered"}
// - POST {action: "unregister", device_id: "<uuid>"}
//     -> 200 {action: "unregister", device_id: "<uuid>", status: "unregistered"}
// - 401 without/with an invalid session (the actor comes ONLY from the
//   verified JWT), 400 on payload shape, 405 for non-POST. Registering an
//   already-known token rebinds it to the current actor/session (idempotent
//   re-registration); unregister is actor-scoped and idempotent.
// The platform verify_jwt check plus requireActor fail closed, so an
// unauthenticated registration attempt is rejected before any database
// work happens.
import { executeDeviceSession } from '../_shared/notifications.ts';

Deno.serve((req: Request): Promise<Response> => executeDeviceSession(req));
