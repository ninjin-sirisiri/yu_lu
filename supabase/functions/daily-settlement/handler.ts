import { jsonError, requireServiceCall } from '../_shared/auth.ts';
import type { DailyCycleSummary } from '../_shared/daily-cycle.ts';

interface Dependencies {
  credential?: string;
  advance: () => Promise<DailyCycleSummary>;
}

export async function handleDailySettlement(req: Request, deps: Dependencies): Promise<Response> {
  const denied = requireServiceCall(req, deps.credential);
  if (denied) return denied;
  if (req.method !== 'POST') return jsonError(405, 'POST required');
  if (new URL(req.url).search) return jsonError(400, 'parameters are not accepted');
  try {
    const text = await req.text();
    const body = text.trim() ? JSON.parse(text) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
      return jsonError(400, 'empty object required');
    }
  } catch {
    return jsonError(400, 'invalid JSON');
  }
  try {
    const result = await deps.advance();
    return new Response(JSON.stringify(result), {
      status: result.retry_required || result.failed_days > 0 ? 503 : 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return jsonError(503, 'daily cycle unavailable');
  }
}
