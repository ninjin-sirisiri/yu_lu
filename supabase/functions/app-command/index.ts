// Task 2: app-command Edge Function entry point.
// All handling lives in command.ts so tests can import the handler without
// binding a port; this file only starts the server when it is the entry.
import { handler } from './command.ts';

Deno.serve(handler);
