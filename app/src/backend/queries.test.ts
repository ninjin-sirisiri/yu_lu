import {
  getProfile,
  listFriends,
  listRequests,
  QueryError,
  searchProfiles,
} from './queries';
import * as appClient from './client';

// Task 5: the client adapter only maps and transports - these tests pin
// the wire contract (snake_case page envelope, opaque cursors, the streak
// key copied through only when sent) and the error surface.

function fakeClient(response: { data?: unknown; error?: unknown }) {
  const calls: Array<{ name: string; body: unknown }> = [];
  const client = {
    functions: {
      invoke: (name: string, options: { body: unknown }) => {
        calls.push({ name, body: options.body });
        return Promise.resolve(response);
      },
    },
  };
  return { calls, client: client as never };
}

const wireProfile = {
  user_id: 'u-1',
  user_id_text: 'alice',
  display_name: 'Alice',
  avatar_path: '/avatars/alice.png',
  introduction: 'Hello',
  relationship: 'friend',
  streak: 5,
};

describe('searchProfiles', () => {
  it('maps the wire page to camelCase and sends the op envelope', async () => {
    const f = fakeClient({
      data: {
        op: 'search_profiles',
        result: { items: [wireProfile], next_cursor: 'CURSOR-1' },
      },
      error: null,
    });

    const page = await searchProfiles('ali', null, f.client);

    expect(page.nextCursor).toBe('CURSOR-1');
    expect(page.items).toEqual([
      {
        userId: 'u-1',
        userIdText: 'alice',
        displayName: 'Alice',
        avatarPath: '/avatars/alice.png',
        introduction: 'Hello',
        relationship: 'friend',
        streak: 5,
      },
    ]);
    expect(f.calls).toEqual([
      {
        name: 'app-query',
        body: { op: 'search_profiles', payload: { query: 'ali', cursor: null } },
      },
    ]);
  });

  it('never invents a streak key the server did not send', async () => {
    const f = fakeClient({
      data: {
        op: 'search_profiles',
        result: {
          items: [
            {
              user_id: 'u-2',
              user_id_text: 'bob',
              display_name: 'Bob',
              avatar_path: null,
              introduction: null,
              relationship: 'none',
            },
          ],
          next_cursor: null,
        },
      },
      error: null,
    });

    const page = await searchProfiles('bob', null, f.client);

    expect(page.nextCursor).toBeNull();
    expect('streak' in page.items[0]).toBe(false);
  });
});

describe('getProfile', () => {
  it('maps the profile result and addresses the user by uuid', async () => {
    const f = fakeClient({ data: { op: 'get_profile', result: wireProfile }, error: null });

    const profile = await getProfile('u-1', f.client);

    expect(profile.userId).toBe('u-1');
    expect(profile.relationship).toBe('friend');
    expect(profile.streak).toBe(5);
    expect(f.calls[0].body).toEqual({
      op: 'get_profile',
      payload: { user_id: 'u-1' },
    });
  });
});

describe('listFriends', () => {
  it('uses the signed-in app client when no client is injected', async () => {
    const f = fakeClient({
      data: { op: 'list_friends', result: { items: [wireProfile], next_cursor: null } },
      error: null,
    });
    const shared = jest.spyOn(appClient, 'getAppClient').mockReturnValue(f.client);
    try {
      const page = await listFriends();
      expect(page.items[0]?.displayName).toBe('Alice');
      expect(f.calls[0]?.name).toBe('app-query');
    } finally {
      shared.mockRestore();
    }
  });

  it('passes the opaque cursor through untouched', async () => {
    const f = fakeClient({
      data: { op: 'list_friends', result: { items: [], next_cursor: null } },
      error: null,
    });

    const page = await listFriends('f1|abc|00000000-0000-4000-8000-000000000001', f.client);

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(f.calls[0].body).toEqual({
      op: 'list_friends',
      payload: {
        cursor: 'f1|abc|00000000-0000-4000-8000-000000000001',
      },
    });
  });
});

describe('listRequests', () => {
  it('maps entries with their counterpart and end time', async () => {
    const f = fakeClient({
      data: {
        op: 'list_requests',
        result: {
          items: [
            {
              request_id: 'r-1',
              status: 'ended',
              created_at: '2026-09-25T00:00:00.000Z',
              expires_at: '2026-10-02T00:00:00.000Z',
              ended_at: '2026-09-26T00:00:00.000Z',
              counterpart: {
                user_id: 'u-9',
                user_id_text: 'hanako',
                display_name: 'Hanako',
                avatar_path: null,
              },
            },
          ],
          next_cursor: null,
        },
      },
      error: null,
    });

    const page = await listRequests('outgoing', null, f.client);

    expect(page.items).toEqual([
      {
        requestId: 'r-1',
        status: 'ended',
        createdAt: '2026-09-25T00:00:00.000Z',
        expiresAt: '2026-10-02T00:00:00.000Z',
        endedAt: '2026-09-26T00:00:00.000Z',
        counterpart: {
          userId: 'u-9',
          userIdText: 'hanako',
          displayName: 'Hanako',
          avatarPath: null,
        },
      },
    ]);
    expect(f.calls[0].body).toEqual({
      op: 'list_requests',
      payload: { direction: 'outgoing', cursor: null },
    });
  });
});

describe('error surfacing', () => {
  it('surfaces the boundary message and HTTP status', async () => {
    const f = fakeClient({
      data: null,
      error: {
        message: 'Edge Function returned a non-2xx status code',
        context: {
          status: 403,
          json: async () => ({
            error: 'Confirm the User ID before using the app.',
          }),
        },
      },
    });

    const caught = await searchProfiles('a', null, f.client).then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(QueryError);
    const queryError = caught as QueryError;
    expect(queryError.message).toBe('Confirm the User ID before using the app.');
    expect(queryError.status).toBe(403);
  });

  it('falls back to a safe message when the error body is unreadable', async () => {
    const f = fakeClient({ data: null, error: new Error('network down') });

    await expect(getProfile('u-1', f.client)).rejects.toThrow('network down');
  });

  it('rejects a response without the result envelope', async () => {
    const f = fakeClient({ data: { op: 'search_profiles' }, error: null });

    await expect(searchProfiles('a', null, f.client)).rejects.toThrow(
      'unexpected query response',
    );
  });
});
