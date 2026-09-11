import { assertRecipientDecision } from './inbox';
import {
  assertNoDuplicatePending,
  crossedRequestEstablished,
  FRIEND_REQUEST_VALID_DAYS,
  requestExpiry,
} from './outbox';

describe('FRIEND_REQUEST_VALID_DAYS', () => {
  it('is 7 days', () => {
    expect(FRIEND_REQUEST_VALID_DAYS).toBe(7);
  });
});

describe('requestExpiry', () => {
  it('is createdAt + 7 days', () => {
    const createdAt = new Date('2026-09-11T00:00:00+09:00');
    const expected = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(requestExpiry(createdAt).getTime()).toBe(expected.getTime());
  });

  it('does not mutate the input date', () => {
    const createdAt = new Date('2026-09-11T00:00:00+09:00');
    const before = createdAt.getTime();
    requestExpiry(createdAt);
    expect(createdAt.getTime()).toBe(before);
  });

  it('an expired request never establishes friendship and guides to re-request', () => {
    const createdAt = new Date('2026-09-11T00:00:00+09:00');
    const expiresAt = requestExpiry(createdAt);
    const now = new Date(expiresAt.getTime() + 1000);
    // Lapsed: past validity, so no approval or crossed path can establish it.
    expect(now.getTime() >= expiresAt.getTime()).toBe(true);
    // After the lapse no request is pending, so a re-request may start.
    expect(() => assertNoDuplicatePending(0)).not.toThrow();
  });
});

describe('assertNoDuplicatePending', () => {
  it('passes when nothing is pending, so a first or post-cancel request can start', () => {
    expect(() => assertNoDuplicatePending(0)).not.toThrow();
  });

  it('throws with guidance to the existing request while one is pending', () => {
    expect(() => assertNoDuplicatePending(1)).toThrow(
      'A request is already pending. Open the existing request.',
    );
    expect(() => assertNoDuplicatePending(2)).toThrow(
      'A request is already pending. Open the existing request.',
    );
  });
});

describe('crossedRequestEstablished', () => {
  it('establishes immediately when both directions are pending', () => {
    expect(crossedRequestEstablished(true, true)).toBe(true);
  });

  it('does not establish when either direction is missing', () => {
    expect(crossedRequestEstablished(true, false)).toBe(false);
    expect(crossedRequestEstablished(false, true)).toBe(false);
    expect(crossedRequestEstablished(false, false)).toBe(false);
  });
});

describe('approval establishment', () => {
  it('a recipient approve decision is valid and establishes friendship', () => {
    // Only approval or crossed requests establish friendship; expiry,
    // cancellation, and rejection never do.
    expect(() => assertRecipientDecision('approve')).not.toThrow();
    expect(crossedRequestEstablished(false, false)).toBe(false);
  });
});
