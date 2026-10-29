import type { HomeResult } from '../backend/chat';

export type PersonProgress = {
  partnerId: string;
  sent: boolean;
  received: boolean;
  replied: boolean;
};

export function pendingPartners(rows: PersonProgress[]): string[] {
  return rows.filter((r) => r.received && !r.replied).map((r) => r.partnerId);
}

/** Keep the legacy per-person helper above independent of the authoritative
 * daily result. Neither local messages nor outbox states prove a strict reply. */
export function dailyProgress(home: HomeResult) {
  const confirmed = home.participation === 'eligible' && home.draw_state === 'succeeded';
  return {
    state: !confirmed ? 'unavailable' : home.achieved ? 'achieved' : home.actionable_complete ? 'actionable_complete' : 'incomplete',
    send: home.send_completed === null ? 'not_applicable' : home.send_completed ? 'complete' : 'incomplete',
    replyCompleted: home.reply_completed,
    replyTotal: home.reply_total,
  } as const;
}
