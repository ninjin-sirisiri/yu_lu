import { invitationExpiry, INVITATION_VALID_DAYS } from './share';

describe('INVITATION_VALID_DAYS', () => {
  it('is 7 days', () => {
    expect(INVITATION_VALID_DAYS).toBe(7);
  });
});

describe('invitationExpiry', () => {
  it('is createdAt + 7 days', () => {
    const createdAt = new Date('2026-09-11T00:00:00+09:00');
    const expected = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(invitationExpiry(createdAt).getTime()).toBe(expected.getTime());
  });

  it('does not mutate the input date', () => {
    const createdAt = new Date('2026-09-11T00:00:00+09:00');
    const before = createdAt.getTime();
    invitationExpiry(createdAt);
    expect(createdAt.getTime()).toBe(before);
  });
});
