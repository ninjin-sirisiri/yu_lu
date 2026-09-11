import { resolveSingleCandidate, PublicProfile } from './lookup';

function profile(userIdText: string): PublicProfile {
  return {
    displayName: 'Display',
    userIdText,
    avatarPath: null,
    introduction: null,
  };
}

describe('resolveSingleCandidate', () => {
  it('returns the single candidate with pre-request profile exposure', () => {
    const candidate = {
      displayName: 'Hanako',
      userIdText: 'hanako',
      avatarPath: '/avatars/hanako.png',
      introduction: 'Hello',
    };
    expect(resolveSingleCandidate([candidate])).toBe(candidate);
  });

  it('throws when no candidate resolves', () => {
    expect(() => resolveSingleCandidate([])).toThrow(
      'User ID input must resolve to exactly one candidate.',
    );
  });

  it('throws when two or more candidates resolve', () => {
    expect(() => resolveSingleCandidate([profile('hanako'), profile('hanako2')])).toThrow(
      'User ID input must resolve to exactly one candidate.',
    );
    expect(
      () => resolveSingleCandidate([profile('a'), profile('b'), profile('c')]),
    ).toThrow('User ID input must resolve to exactly one candidate.');
  });
});
