import type { SupabaseClient } from '@supabase/supabase-js';

import { getAppClient } from '../backend/client';

// Task 9: the injectable network port of the send queue.
//
// Ownership: the `CommandApi` interface (what the worker needs from the
// network), the `CommandOutcome` classification, and a default
// implementation that POSTs one command to the app-command Edge Function
// through the Supabase client - the same wire shape Task 7's adapter uses
// ({operation_id, kind, payload}, actor derived from the verified JWT, no
// actor field). Tests inject fakes; real end-to-end wiring happens in
// Task 13+.
//
// Outcome classification is the port's job because only the transport can
// know what happened on the wire:
//
// - ok           2xx: the server settled the operation (idempotent replay
//                of an already-stored operation also answers 200).
// - conflict     HTTP 409 with a `conflict` payload (profile version
//                conflict): settled WITHOUT changing anything; the caller
//                rebases and saves a NEW operation - never retried.
//                A 409 without a conflict body is the operation-id conflict
//                (same id, different payload) and falls into `rejected`.
// - rejected     other 4xx (400 validation, 401/403 permission, 404 …):
//                non-retryable; repeating it would fail the same way.
// - transient    408/429/5xx and connection-level failures with no HTTP
//                status: treated as NOT delivered, so the operation stays
//                未送信 with its original 24-hour deadline and is retried
//                automatically with the SAME operation id (接続復帰で再試行).
//                A connection error cannot prove delivery either way, and
//                the same-id retry replays idempotently if it did arrive.
// - unknown      the port KNOWS the request may have reached the server but
//                the answer is unreadable (lost response). The queue moves
//                the entry to 結果確認中 and only ever re-sends the same
//                id to confirm it - it is never blindly retried as new.
//                The default implementation returns this when a response
//                arrives but its body cannot be interpreted; tests inject
//                the acceptance-then-lost-response case directly.

function defaultClient(): SupabaseClient {
  return getAppClient();
}

/** Name of the single command boundary function. */
export const APP_COMMAND_FUNCTION = 'app-command';

/** One command as the queue hands it to the network. */
export interface CommandEnvelope {
  /** Account the operation belongs to; the session must match it. */
  accountId: string;
  operationId: string;
  kind: string;
  payload: Record<string, unknown>;
}

export type CommandOutcome =
  | { status: 'ok'; data?: Record<string, unknown> }
  | { status: 'conflict'; message: string; conflict: Record<string, unknown> }
  | { status: 'rejected'; httpStatus: number; message: string }
  | { status: 'transient'; httpStatus?: number; message?: string }
  | { status: 'unknown'; message?: string };

/** The network port: send one command and classify the result. */
export interface CommandApi {
  send(command: CommandEnvelope): Promise<CommandOutcome>;
}

export interface CommandApiOptions {
  /** Injected Supabase client (tests pass a fake). */
  client?: SupabaseClient;
}

interface InvokeErrorLike {
  message?: unknown;
  context?: unknown;
}

/** Extract {status, message, body} from a supabase-js functions error. */
async function readInvokeError(error: unknown): Promise<{
  status: number;
  message: string;
  body: Record<string, unknown> | null;
}> {
  let status = 0;
  let message = error instanceof Error ? error.message : 'command execution failed';
  let body: Record<string, unknown> | null = null;
  const context = (error as InvokeErrorLike | null)?.context;
  if (context !== null && typeof context === 'object') {
    const candidate = context as { status?: unknown; json?: unknown };
    if (typeof candidate.status === 'number') status = candidate.status;
    if (typeof candidate.json === 'function') {
      try {
        const parsed = await (candidate.json as () => Promise<unknown>)();
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
          if (typeof body['error'] === 'string') message = body['error'];
        }
      } catch {
        // Keep the fallback message when the error body is unreadable.
      }
    }
  }
  return { status, message, body };
}

function isConflictShape(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['status'] === 'conflict'
  );
}

function conflictOutcome(value: Record<string, unknown>): CommandOutcome {
  const message = typeof value['message'] === 'string' ? value['message'] : 'conflict';
  return { status: 'conflict', message, conflict: value };
}

/**
 * Default implementation: one `functions.invoke` POST per command.
 *
 * Before sending it verifies that the current session belongs to
 * `envelope.accountId`, so a queued operation is never replayed under a
 * different account's credentials (認証失効では別アカウントの資格情報で
 * 再送しない). Mismatches and missing sessions are `rejected`, not
 * transient - retrying them would fail identically.
 */
export function createCommandApi(options: CommandApiOptions = {}): CommandApi {
  return {
    async send(envelope: CommandEnvelope): Promise<CommandOutcome> {
      const client = options.client ?? defaultClient();

      let sessionId: string | null = null;
      try {
        const { data } = await client.auth.getSession();
        sessionId = data.session?.user?.id ?? null;
      } catch (error) {
        // Session storage unreadable: nothing was sent.
        return {
          status: 'transient',
          message: error instanceof Error ? error.message : 'session unavailable',
        };
      }
      if (!sessionId) {
        return { status: 'rejected', httpStatus: 401, message: 'authentication required' };
      }
      if (sessionId !== envelope.accountId) {
        return {
          status: 'rejected',
          httpStatus: 401,
          message: 'queued operation belongs to a different account',
        };
      }

      const { data, error } = await client.functions.invoke(APP_COMMAND_FUNCTION, {
        body: {
          operation_id: envelope.operationId,
          kind: envelope.kind,
          payload: envelope.payload,
        },
      });

      if (error) {
        const { status, message, body } = await readInvokeError(error);
        const conflict = body?.['conflict'];
        if (status === 409 && isConflictShape(conflict)) return conflictOutcome(conflict);
        if (status === 0) {
          // Connection-level failure: no HTTP status means the request
          // never produced a response we can attribute - classify as a
          // transient 一時失敗 so the entry stays 送信待ち with its
          // original deadline (see the header comment).
          return { status: 'transient', message };
        }
        if (status === 408 || status === 429 || status >= 500) {
          return { status: 'transient', httpStatus: status, message };
        }
        return { status: 'rejected', httpStatus: status, message };
      }

      const envelopeData = (data ?? {}) as Record<string, unknown>;
      // Defensive: a settled conflict normally arrives as HTTP 409, but a
      // 200 body carrying the conflict shape must not count as success.
      const result = envelopeData['result'];
      if (isConflictShape(result)) return conflictOutcome(result);
      return { status: 'ok', data: envelopeData };
    },
  };
}
