import { REJECTION_DISPLAY } from './outbox';

export type RequestDecision = 'approve' | 'reject';

export function rejectionDisplay(): string {
  return REJECTION_DISPLAY;
}

export function assertRecipientDecision(decision: RequestDecision): void {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error('Recipients can only approve or reject.');
  }
}

export function assertRequestAllowedForRecipient(blocked: boolean): void {
  if (blocked) {
    throw new Error('Requests cannot be sent to a blocked recipient.');
  }
}
