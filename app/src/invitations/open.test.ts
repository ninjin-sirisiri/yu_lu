import { assertUserIdConfirmed } from '../profiles/registration';
import { assertInvitationOpenable, invitationReturnTarget } from './open';
import { invitationExpiry } from './share';

describe('assertInvitationOpenable', () => {
  it('passes while now is before expiry', () => {
    const createdAt = new Date('2026-09-11T00:00:00+09:00');
    const expiresAt = invitationExpiry(createdAt);
    const now = new Date(expiresAt.getTime() - 1000);
    expect(() => assertInvitationOpenable(now, expiresAt)).not.toThrow();
  });

  it('throws with reissue guidance when now equals expiry, so no request can start', () => {
    const createdAt = new Date('2026-09-11T00:00:00+09:00');
    const expiresAt = invitationExpiry(createdAt);
    expect(() => assertInvitationOpenable(expiresAt, expiresAt)).toThrow(
      'This invitation expired. Ask for a new invitation.',
    );
  });

  it('throws with reissue guidance after expiry', () => {
    const createdAt = new Date('2026-09-11T00:00:00+09:00');
    const expiresAt = invitationExpiry(createdAt);
    const now = new Date(expiresAt.getTime() + 1000);
    expect(() => assertInvitationOpenable(now, expiresAt)).toThrow(
      'This invitation expired. Ask for a new invitation.',
    );
  });
});

describe('invitationReturnTarget', () => {
  it('keeps the token for an unregistered opener so they return after registration', () => {
    expect(invitationReturnTarget('tok-123')).toBe('invitation:tok-123');
  });

  it('returns null when there is no invitation token', () => {
    expect(invitationReturnTarget(null)).toBeNull();
    expect(invitationReturnTarget('')).toBeNull();
  });

  it('gates app use behind User ID confirmation after the return', () => {
    const target = invitationReturnTarget('tok-123');
    expect(target).not.toBeNull();
    // An unregistered invitation opener returns automatically after OAuth
    // registration, then must confirm the User ID before using the app.
    expect(() => assertUserIdConfirmed(null, null)).toThrow(
      'Confirm the User ID before using the app.',
    );
    expect(() => assertUserIdConfirmed('hanako', '2026-09-11T00:00:00+09:00')).not.toThrow();
  });
});
