import { pendingPartners, type PersonProgress } from './progress';

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
