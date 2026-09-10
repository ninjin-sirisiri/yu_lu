import { labelForState, type SendState } from './states';

describe('labelForState', () => {
  it.each<[SendState, string]>([
    ['draft', 'Draft'],
    ['sending', 'Sending'],
    ['sent', 'Sent'],
    ['failed', 'Failed'],
  ])('labels %s as %s', (state, expected) => {
    expect(labelForState(state)).toBe(expected);
  });
});
