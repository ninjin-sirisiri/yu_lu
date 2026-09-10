import {
  buildEditInsert,
  buildMessageInsert,
  buildWithdrawUpdate,
  editMessage,
  sendMessage,
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

describe('sendMessage guards', () => {
  it('rejects blank-only body with no image', async () => {
    const f = fakeClient(async () => ({}));
    await expect(
      sendMessage(
        { recipientId: 'r', body: '   \n ', localImageUris: [], clientKey: 'k' },
        f.client as never,
      ),
    ).rejects.toThrow('Blank-only body with no image cannot be sent');
    expect(f.inserted).toHaveLength(0);
  });

  it('sends whitespace-only body when an image is present', async () => {
    const f = fakeClient(async () => ({}));
    await expect(
      sendMessage({ recipientId: 'r', body: '  ', localImageUris: ['u1'], clientKey: 'k' }, f.client as never),
    ).resolves.toBe('mid-1');
  });

  it('caps images at 4', async () => {
    const f = fakeClient(async () => ({}));
    await sendMessage(
      { recipientId: 'r', body: 'hi', localImageUris: ['a', 'b', 'c', 'd', 'e'], clientKey: 'k' },
      f.client as never,
    );
    expect(f.inserted).toHaveLength(1);
    const row = (f.inserted[0] as { row: { image_paths: string[] } }).row;
    expect(row.image_paths).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never writes accepted_at (server truth)', async () => {
    const f = fakeClient(async () => ({}));
    await sendMessage({ recipientId: 'r', body: 'hi', localImageUris: [], clientKey: 'k' }, f.client as never);
    const row = (f.inserted[0] as { row: Record<string, unknown> }).row;
    expect(row).not.toHaveProperty('accepted_at');
    expect(row).not.toHaveProperty('acceptedAt');
  });

  it('buildMessageInsert maps recipient/body/key and truncates to 4', () => {
    const row = buildMessageInsert({
      recipientId: 'r',
      body: 'hi',
      localImageUris: ['a', 'b', 'c', 'd', 'e'],
      clientKey: 'k',
    });
    expect(row).toEqual({ recipient_id: 'r', body: 'hi', image_paths: ['a', 'b', 'c', 'd'], client_key: 'k' });
    expect(row).not.toHaveProperty('accepted_at');
  });
});

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
