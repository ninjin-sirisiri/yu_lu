import { zeroFriendGuidance } from './zeroFriends';

describe('zeroFriendGuidance', () => {
  it('shows add entries, keeps the Streak unchanged, and uses the exact message', () => {
    expect(zeroFriendGuidance()).toEqual({
      showAddEntries: true,
      streakChanges: false,
      message: '友達がいない日は抽選対象外です。Streakは変わりません。',
    });
  });

  it('creates no assignment: a zero-friend day stays out of the draw', () => {
    const guidance = zeroFriendGuidance();
    expect(guidance.showAddEntries).toBe(true);
    expect(guidance.streakChanges).toBe(false);
  });
});
