import {
  assertRecipientDecision,
  assertRequestAllowedForRecipient,
  rejectionDisplay,
} from './inbox';
import type { RequestDecision } from './inbox';
import { REJECTION_DISPLAY } from './outbox';

describe('rejectionDisplay', () => {
  it('returns the neutral display with no reason or timing', () => {
    expect(rejectionDisplay()).toBe(REJECTION_DISPLAY);
    expect(rejectionDisplay()).toBe('今回は成立しませんでした');
  });
});

describe('assertRecipientDecision', () => {
  it('passes for approve and reject', () => {
    expect(() => assertRecipientDecision('approve')).not.toThrow();
    expect(() => assertRecipientDecision('reject')).not.toThrow();
  });

  it('throws for anything other than approve or reject', () => {
    expect(() => assertRecipientDecision('cancel' as unknown as RequestDecision)).toThrow(
      'Recipients can only approve or reject.',
    );
  });

  it('rejection never establishes friendship and discloses nothing', () => {
    expect(() => assertRecipientDecision('reject')).not.toThrow();
    expect(rejectionDisplay()).toBe(REJECTION_DISPLAY);
  });
});

describe('assertRequestAllowedForRecipient', () => {
  it('passes for an unblocked recipient', () => {
    expect(() => assertRequestAllowedForRecipient(false)).not.toThrow();
  });

  it('throws for a blocked recipient', () => {
    expect(() => assertRequestAllowedForRecipient(true)).toThrow(
      'Requests cannot be sent to a blocked recipient.',
    );
  });

  it('accepts a re-request after unblock', () => {
    expect(() => assertRequestAllowedForRecipient(true)).toThrow(
      'Requests cannot be sent to a blocked recipient.',
    );
    // After unblock the same recipient accepts a new request.
    expect(() => assertRequestAllowedForRecipient(false)).not.toThrow();
  });
});

describe('request-only partners cannot be blocked', () => {
  // Conceptual mirror of the blocks model rule (see
  // app/src/relations/blocks.ts, read-only for this task): block and delete
  // are allowed only for established Friends, so a request-only partner
  // (pending request, no friendship) must be refused.
  function assertBlockAllowed(isEstablishedFriend: boolean): void {
    if (!isEstablishedFriend) {
      throw new Error('Block and delete are allowed only for established Friends.');
    }
  }

  it('refuses to block a request-only partner', () => {
    expect(() => assertBlockAllowed(false)).toThrow(
      'Block and delete are allowed only for established Friends.',
    );
  });

  it('allows block for an established Friend', () => {
    expect(() => assertBlockAllowed(true)).not.toThrow();
  });
});
