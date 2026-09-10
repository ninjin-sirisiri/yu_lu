import { cancelReservation, reserveBlock } from './blocks';

function fakeClient(errorMessage: string | null = null) {
  const calls: Array<{ table: string; op: string; row: unknown }> = [];
  const err = errorMessage ? { message: errorMessage } : null;
  const client = {
    from: (table: string) => ({
      insert: (row: unknown) => {
        calls.push({ table, op: 'insert', row });
        return Promise.resolve({ error: err });
      },
      delete: () => ({
        is: (column: string, value: unknown) => ({
          eq: (col: string, val: unknown) => {
            calls.push({ table, op: 'delete', row: { is: [column, value], eq: [col, val] } });
            return Promise.resolve({ error: err });
          },
        }),
      }),
    }),
  };
  return { calls, client };
}

describe('reserveBlock', () => {
  it('inserts the blocked user into block_reservations (never blocks directly)', async () => {
    const f = fakeClient();
    await reserveBlock('user-b', f.client as never);
    expect(f.calls).toEqual([
      { table: 'block_reservations', op: 'insert', row: { blocked_user_id: 'user-b' } },
    ]);
  });

  it('throws when the reservation insert fails', async () => {
    const f = fakeClient('duplicate reservation');
    await expect(reserveBlock('user-b', f.client as never)).rejects.toThrow(
      'duplicate reservation',
    );
  });
});

describe('cancelReservation', () => {
  it('deletes only the unapplied reservation for the blocked user', async () => {
    const f = fakeClient();
    await cancelReservation('user-b', f.client as never);
    expect(f.calls).toEqual([
      {
        table: 'block_reservations',
        op: 'delete',
        row: { is: ['applied_at', null], eq: ['blocked_user_id', 'user-b'] },
      },
    ]);
  });

  it('throws when the cancel fails', async () => {
    const f = fakeClient('cancel failed');
    await expect(cancelReservation('user-b', f.client as never)).rejects.toThrow(
      'cancel failed',
    );
  });
});
