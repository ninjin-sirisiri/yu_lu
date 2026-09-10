export const RESEND_LIMIT_HOURS = 24;
export const PREVIEW_CHARS = 100;

export function previewBody(body: string): string {
  return body.slice(0, PREVIEW_CHARS);
}

export function backoffMs(attempt: number): number {
  return Math.min(60000 * 2 ** attempt, 3600000);
}
