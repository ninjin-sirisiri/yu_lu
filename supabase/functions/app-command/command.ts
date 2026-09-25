// Task 2: app-command handler — the single HTTP write boundary.
//
// Ownership: request order is method check -> verified actor (401 before
// anything else) -> envelope validation plus one `public.app_command` RPC
// call. The RPC records the operation and runs the registered business
// handler in the same DB transaction; the caller's Authorization header is
// forwarded so the database derives the actor from the same verified JWT.
// There is no actor field in the body — clients cannot choose who executed
// a command. Later tasks register their command kinds (register, request,
// …) as handlers; this task wires `ping`.
//
// The handler factory takes injectable dependencies so tests exercise the
// real control flow offline; `index.ts` serves the default wiring.

import { jsonError, requireActor } from '../_shared/auth.ts';
import { executeCommand } from '../_shared/commands.ts';

export interface CommandHandlerDeps {
  requireActor: typeof requireActor;
  executeCommand: typeof executeCommand;
}

export function createCommandHandler(
  overrides: Partial<CommandHandlerDeps> = {},
): (req: Request) => Promise<Response> {
  const deps: CommandHandlerDeps = {
    requireActor: overrides.requireActor ?? requireActor,
    executeCommand: overrides.executeCommand ?? executeCommand,
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return jsonError(405, 'method not allowed');
    }
    const actor = await deps.requireActor(req);
    if (actor instanceof Response) return actor;
    const authorization = req.headers.get('authorization');
    if (!authorization) return jsonError(401, 'authentication required');
    return deps.executeCommand(req, authorization);
  };
}

export const handler = createCommandHandler();
