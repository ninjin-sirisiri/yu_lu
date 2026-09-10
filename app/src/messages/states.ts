export type SendState = 'draft' | 'sending' | 'sent' | 'failed';

export function labelForState(state: SendState): string {
  if (state === 'draft') return 'Draft';
  if (state === 'sending') return 'Sending';
  if (state === 'sent') return 'Sent';
  return 'Failed';
}
