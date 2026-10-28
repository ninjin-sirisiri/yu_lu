import { dailyProgress, pendingPartners, type PersonProgress } from './progress';
import { home } from '../messages/repositoryTestSupport';

describe('pendingPartners', () => {
  it('returns partnerIds that were received but not yet replied', () => {
    const rows: PersonProgress[] = [
      { partnerId: 'a', sent: true, received: true, replied: false },
      { partnerId: 'b', sent: true, received: true, replied: true },
      { partnerId: 'c', sent: true, received: false, replied: false },
    ];
    expect(pendingPartners(rows)).toEqual(['a']);
  });

  it('returns an empty list when nothing is pending', () => {
    expect(pendingPartners([])).toEqual([]);
  });

  it('preserves row order', () => {
    const rows: PersonProgress[] = [
      { partnerId: 'x', sent: false, received: true, replied: false },
      { partnerId: 'y', sent: false, received: true, replied: false },
    ];
    expect(pendingPartners(rows)).toEqual(['x', 'y']);
  });
});

describe('dailyProgress (server result only)', () => {
  it('keeps send and reply conditions separate, including zero reply targets', () => {
    expect(dailyProgress(home())).toEqual({ state: 'incomplete', send: 'incomplete', replyCompleted: 0, replyTotal: 0 });
    expect(dailyProgress(home({ send_completed: true, reply_completed: 1, reply_total: 3 })))
      .toEqual({ state: 'incomplete', send: 'complete', replyCompleted: 1, replyTotal: 3 });
  });
  it('does not infer achievement from sends, messages or counts', () => {
    expect(dailyProgress(home({ send_completed: true, reply_completed: 2, reply_total: 2 })).state).toBe('incomplete');
    expect(dailyProgress(home({ actionable_complete: true })).state).toBe('actionable_complete');
    expect(dailyProgress(home({ achieved: true, actionable_complete: true })).state).toBe('achieved');
  });
  it('withholds progress until the server confirms participation and draw success', () => {
    expect(dailyProgress(home({ participation: 'checking', draw_state: 'pending', achieved: true })).state).toBe('unavailable');
    expect(dailyProgress(home({ participation: 'draw_failed', draw_state: 'failed' })).state).toBe('unavailable');
    expect(dailyProgress(home({ send_completed: null })).send).toBe('not_applicable');
  });
});
