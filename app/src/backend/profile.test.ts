import {
  getOwnPublication,
  PROFILE_IMAGE_BUCKET,
  PROFILE_IMAGE_URL_TTL_SECONDS,
  ProfileUpdateError,
  profileImagePath,
  profileImageUrl,
  updateProfile,
  uploadProfileImage,
} from './profile';

// Task 7: the client adapter only maps and transports - these tests pin
// the wire contract (snake_case payload with base_version, the 409
// {error, conflict} body mapped to a conflict result, the
// actor/operation-scoped storage path) and the fail-fast upload checks.

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

interface FakeOptions {
  invoke?: { data?: unknown; error?: unknown };
  getUser?: { data: { user: { id: string } | null }; error?: unknown };
  upload?: { data?: unknown; error?: { message: string } | null };
  row?: { data?: unknown; error?: { message: string } | null };
  signedUrl?: { data?: { signedUrl?: string } | null; error?: { message: string } | null };
}

function fakeClient(options: FakeOptions = {}) {
  const calls = {
    invoke: [] as Array<{ name: string; body: unknown }>,
    bucket: null as string | null,
    upload: [] as Array<{ path: string; data: unknown; opts: unknown }>,
    table: null as string | null,
    select: null as string | null,
    eq: null as Array<string> | null,
    signed: null as { path: string; ttl: number } | null,
  };
  const client = {
    functions: {
      invoke: (name: string, opts: { body: unknown }) => {
        calls.invoke.push({ name, body: opts.body });
        return Promise.resolve(options.invoke ?? { data: null, error: null });
      },
    },
    auth: {
      getUser: () =>
        Promise.resolve(
          options.getUser ?? { data: { user: { id: UUID_A } }, error: null },
        ),
    },
    storage: {
      from: (bucket: string) => {
        calls.bucket = bucket;
        return {
          upload: (path: string, data: unknown, opts: unknown) => {
            calls.upload.push({ path, data, opts });
            return Promise.resolve(options.upload ?? { data: { path }, error: null });
          },
          createSignedUrl: (path: string, ttl: number) => {
            calls.signed = { path, ttl };
            return Promise.resolve(
              options.signedUrl ?? { data: { signedUrl: `https://signed.test/${path}` }, error: null },
            );
          },
        };
      },
    },
    from: (table: string) => {
      calls.table = table;
      return {
        select: (cols: string) => {
          calls.select = cols;
          return {
            eq: (col: string, val: string) => {
              calls.eq = [col, val];
              return {
                maybeSingle: () =>
                  Promise.resolve(options.row ?? { data: null, error: null }),
              };
            },
          };
        },
      };
    },
  };
  return { calls, client: client as never };
}

describe('profileImagePath', () => {
  it('builds the actor/operation-scoped path', () => {
    expect(profileImagePath(UUID_A, UUID_B, 'photo.jpg')).toBe(
      `${UUID_A}/${UUID_B}/photo.jpg`,
    );
  });

  it.each([
    ['not a uuid', 'nope', UUID_B, 'photo.jpg'],
    ['uppercase uuid', 'ABCDABCD-ABCD-4ABC-8ABC-ABCDABCDABCD', UUID_B, 'photo.jpg'],
    ['missing operation id', UUID_A, 'nope', 'photo.jpg'],
    ['nested file name', UUID_A, UUID_B, 'a/photo.jpg'],
    ['empty file name', UUID_A, UUID_B, ''],
    ['dot file name', UUID_A, UUID_B, '..'],
  ])('rejects %s', (_label, userId, operationId, fileName) => {
    expect(() => profileImagePath(userId, operationId, fileName)).toThrow(
      ProfileUpdateError,
    );
  });
});

describe('uploadProfileImage', () => {
  it('uploads into the dedicated bucket under the caller folder', async () => {
    const f = fakeClient();
    const body = new ArrayBuffer(8);

    const path = await uploadProfileImage(
      UUID_B,
      { fileName: 'photo.jpg', contentType: 'image/jpeg', data: body },
      f.client,
    );

    expect(path).toBe(`${UUID_A}/${UUID_B}/photo.jpg`);
    expect(f.calls.bucket).toBe(PROFILE_IMAGE_BUCKET);
    expect(f.calls.upload[0].path).toBe(path);
    expect(f.calls.upload[0].opts).toEqual({
      contentType: 'image/jpeg',
      upsert: true,
    });
  });

  it('rejects unsupported content types before touching storage', async () => {
    const f = fakeClient();
    await expect(
      uploadProfileImage(
        UUID_B,
        {
          fileName: 'bad.gif',
          contentType: 'image/gif',
          data: new ArrayBuffer(8),
        },
        f.client,
      ),
    ).rejects.toThrow('Profile image must be a JPEG, PNG, or HEIC image.');
    expect(f.calls.upload).toHaveLength(0);
  });

  it('rejects an oversized upload before touching storage', async () => {
    const f = fakeClient();
    await expect(
      uploadProfileImage(
        UUID_B,
        {
          fileName: 'big.jpg',
          contentType: 'image/jpeg',
          data: new ArrayBuffer(8),
          sizeBytes: 10 * 1024 * 1024 + 1,
        },
        f.client,
      ),
    ).rejects.toThrow('Profile image must be 10MB or smaller.');
    expect(f.calls.upload).toHaveLength(0);
  });

  it('fails closed without a session', async () => {
    const f = fakeClient({
      getUser: { data: { user: null }, error: { message: 'no session' } },
    });
    await expect(
      uploadProfileImage(
        UUID_B,
        { fileName: 'photo.jpg', contentType: 'image/jpeg', data: new ArrayBuffer(1) },
        f.client,
      ),
    ).rejects.toThrow('authentication required');
  });
});

const SUCCESS_RESULT = {
  status: 'executed',
  kind: 'update_profile',
  result: {
    status: 'updated',
    version: 2,
    profile: {
      display_name: 'Pub Renamed',
      introduction: null,
      avatar_path: `${UUID_A}/${UUID_B}/photo.jpg`,
    },
  },
};

describe('updateProfile', () => {
  it('sends only the present fields in the snake_case payload', async () => {
    const f = fakeClient({ invoke: { data: SUCCESS_RESULT, error: null } });

    const result = await updateProfile(
      UUID_B,
      { baseVersion: 1, displayName: 'Pub Renamed', avatarPath: null },
      f.client,
    );

    expect(f.calls.invoke).toEqual([
      {
        name: 'app-command',
        body: {
          operation_id: UUID_B,
          kind: 'update_profile',
          payload: {
            base_version: 1,
            display_name: 'Pub Renamed',
            avatar_path: null,
          },
        },
      },
    ]);
    expect(result).toEqual({
      status: 'updated',
      version: 2,
      profile: {
        displayName: 'Pub Renamed',
        introduction: null,
        avatarPath: `${UUID_A}/${UUID_B}/photo.jpg`,
      },
    });
  });

  it('maps the 409 conflict body to a conflict result', async () => {
    const conflict = {
      status: 'conflict',
      message: 'profile version conflict',
      version: 4,
      profile: {
        display_name: 'Latest',
        introduction: 'Theirs',
        avatar_path: null,
      },
      differing_fields: ['display_name', 'introduction'],
    };
    const f = fakeClient({
      invoke: {
        data: null,
        error: {
          message: 'FunctionsHttpError',
          context: {
            status: 409,
            json: () =>
              Promise.resolve({ error: 'profile version conflict', conflict }),
          },
        },
      },
    });

    const result = await updateProfile(
      UUID_B,
      { baseVersion: 1, displayName: 'Mine' },
      f.client,
    );

    expect(result).toEqual({
      status: 'conflict',
      message: 'profile version conflict',
      version: 4,
      profile: { displayName: 'Latest', introduction: 'Theirs', avatarPath: null },
      differingFields: ['display_name', 'introduction'],
    });
  });

  it('surfaces a structured conflict the transport delivered with 200', async () => {
    const f = fakeClient({
      invoke: {
        data: {
          status: 'replayed',
          kind: 'update_profile',
          result: {
            status: 'conflict',
            message: 'profile version conflict',
            version: 3,
            profile: { display_name: 'A', introduction: null, avatar_path: null },
            differing_fields: ['display_name'],
          },
        },
        error: null,
      },
    });

    const result = await updateProfile(
      UUID_B,
      { baseVersion: 1, displayName: 'B' },
      f.client,
    );

    expect(result.status).toBe('conflict');
    expect(result).toMatchObject({
      version: 3,
      differingFields: ['display_name'],
    });
  });

  it('throws ProfileUpdateError with the server message and status', async () => {
    const f = fakeClient({
      invoke: {
        data: null,
        error: {
          message: 'FunctionsHttpError',
          context: {
            status: 400,
            json: () =>
              Promise.resolve({
                error: 'Referenced profile image was not found.',
              }),
          },
        },
      },
    });

    const failure = await updateProfile(
      UUID_B,
      { baseVersion: 2, avatarPath: `${UUID_A}/${UUID_B}/ghost.jpg` },
      f.client,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ProfileUpdateError);
    expect((failure as ProfileUpdateError).message).toBe(
      'Referenced profile image was not found.',
    );
    expect((failure as ProfileUpdateError).status).toBe(400);
  });

  it('rejects an unexpected success body', async () => {
    const f = fakeClient({ invoke: { data: { status: 'executed' }, error: null } });
    await expect(
      updateProfile(UUID_B, { baseVersion: 1, displayName: 'A' }, f.client),
    ).rejects.toThrow('unexpected command response');
  });
});

describe('getOwnPublication', () => {
  it('maps the own row to camelCase publication state', async () => {
    const f = fakeClient({
      row: {
        data: {
          display_name: 'Pub Renamed',
          introduction: null,
          avatar_path: `${UUID_A}/${UUID_B}/photo.jpg`,
          profile_version: 4,
          user_id_text: 'pub_renamed',
        },
        error: null,
      },
    });

    const publication = await getOwnPublication(f.client);

    expect(publication).toEqual({
      displayName: 'Pub Renamed',
      introduction: null,
      avatarPath: `${UUID_A}/${UUID_B}/photo.jpg`,
      profileVersion: 4,
      userIdText: 'pub_renamed',
    });
    expect(f.calls.table).toBe('profiles');
    expect(f.calls.eq).toEqual(['user_id', UUID_A]);
  });

  it('reports a null User ID as null instead of inventing one', async () => {
    const f = fakeClient({
      row: {
        data: {
          display_name: 'Pending',
          introduction: null,
          avatar_path: null,
          profile_version: 1,
          user_id_text: null,
        },
        error: null,
      },
    });

    const publication = await getOwnPublication(f.client);
    expect(publication.userIdText).toBeNull();
  });

  it('fails closed without a confirmed row', async () => {
    const f = fakeClient({ row: { data: null, error: null } });
    await expect(getOwnPublication(f.client)).rejects.toThrow('profile not found');
  });
});

describe('profileImageUrl', () => {
  it('signs the private-bucket path for a preview', async () => {
    const f = fakeClient();
    const url = await profileImageUrl(`${UUID_A}/${UUID_B}/photo.jpg`, f.client);
    expect(url).toBe(`https://signed.test/${UUID_A}/${UUID_B}/photo.jpg`);
    expect(f.calls.bucket).toBe(PROFILE_IMAGE_BUCKET);
    expect(f.calls.signed).toEqual({
      path: `${UUID_A}/${UUID_B}/photo.jpg`,
      ttl: PROFILE_IMAGE_URL_TTL_SECONDS,
    });
  });

  it('degrades to null instead of inventing a URL when signing fails', async () => {
    const f = fakeClient({ signedUrl: { data: null, error: { message: 'nope' } } });
    await expect(profileImageUrl('a/b/c.jpg', f.client)).resolves.toBeNull();
  });

  it('never signs an empty path', async () => {
    const f = fakeClient();
    await expect(profileImageUrl('', f.client)).resolves.toBeNull();
    expect(f.calls.bucket).toBeNull();
  });
});
