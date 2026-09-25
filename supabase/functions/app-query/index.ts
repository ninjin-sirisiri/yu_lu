// Task 5: app-query Edge Function entry point.
// All handling lives in _shared/queries.ts so tests can import the handler
// without binding a port; this file only starts the server when it is the
// entry.
import { handler } from '../_shared/queries.ts';

Deno.serve(handler);
