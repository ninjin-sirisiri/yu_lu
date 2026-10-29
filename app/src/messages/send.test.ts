import {
  buildEditInsert,
  buildWithdrawUpdate,
  editMessage,
  withdrawMessage,
} from './send';

function fakeClient(insertImpl: (row: unknown) => Promise<unknown>, updateImpl?: (row: unknown) => Promise<unknown>) {
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const single = () => Promise.resolve({ error: null, data: { message_id: 'mid-1' } });
  return {
    inserted,
    updated,
    client: {
      from: (table: string) => ({
        insert: (row: unknown) => {
          inserted.push({ table, row });
          const p = insertImpl(row);
          return table === 'messages' ? { select: () => ({ single: () => p.then(() => single()) }) } : p.then(() => ({ error: null }));
        },
        update: (row: unknown) => {
          updated.push({ table, row });
          return {
            eq: () => (updateImpl ? updateImpl(row) : Promise.resolve({ error: null })),
          };
        },
      }),
    },
  };
}

describe('edit history', () => {
  it('buildEditInsert keeps the message row key and version without accepted_at', () => {
    expect(
      buildEditInsert({ messageId: 'm', version: 2, body: 'new', imagePaths: ['p'] }),
    ).toEqual({ message_id: 'm', version: 2, body: 'new', image_paths: ['p'] });
  });

  it('editMessage inserts into message_edits', async () => {
    const f = fakeClient(async () => ({}));
    await editMessage({ messageId: 'm', version: 1, body: 'b', imagePaths: [] }, f.client as never);
    expect(f.inserted).toEqual([
      { table: 'message_edits', row: { message_id: 'm', version: 1, body: 'b', image_paths: [] } },
    ]);
  });
});

describe('withdrawal', () => {
  it('buildWithdrawUpdate only sets the withdrawn flag', () => {
    expect(buildWithdrawUpdate()).toEqual({ withdrawn: true });
  });

  it('withdrawMessage updates only the withdrawn flag (row kept, accepted_at untouched)', async () => {
    const f = fakeClient(async () => ({}), async () => ({}));
    await withdrawMessage('m', f.client as never);
    expect(f.updated).toEqual([{ table: 'messages', row: { withdrawn: true } }]);
  });
});
