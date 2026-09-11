import { assertNoCrossEmailAutoLink, resolveSessionOutcome } from './session';

describe('resolveSessionOutcome', () => {
  it('returns an existing account for returning users', () => {
    expect(
      resolveSessionOutcome({
        provider: 'apple',
        accountId: 'account-1',
        providerAccountSelected: true,
        allMethodsLost: false,
      }),
    ).toEqual({ kind: 'returning', provider: 'apple', accountId: 'account-1' });
  });

  it('starts registration for new users without an account', () => {
    expect(
      resolveSessionOutcome({
        provider: 'google',
        accountId: null,
        providerAccountSelected: false,
        allMethodsLost: false,
      }),
    ).toEqual({ kind: 'register', provider: 'google' });
  });

  it('registers when a different account was selected', () => {
    expect(
      resolveSessionOutcome({
        provider: 'apple',
        accountId: 'account-1',
        providerAccountSelected: false,
        allMethodsLost: false,
      }),
    ).toEqual({ kind: 'register', provider: 'apple' });
  });

  it('reports unrecoverable when all methods are lost', () => {
    expect(
      resolveSessionOutcome({
        provider: 'google',
        accountId: 'account-1',
        providerAccountSelected: true,
        allMethodsLost: true,
      }),
    ).toEqual({ kind: 'unrecoverable' });
  });
});

describe('assertNoCrossEmailAutoLink', () => {
  it('refuses to auto-link different emails', () => {
    expect(() => assertNoCrossEmailAutoLink('a@example.com', 'b@example.com')).toThrow(
      'Do not auto-link OAuth logins with different emails.',
    );
  });

  it('treats case variants as different emails', () => {
    expect(() => assertNoCrossEmailAutoLink('A@example.com', 'B@EXAMPLE.com')).toThrow(
      'Do not auto-link OAuth logins with different emails.',
    );
  });

  it('passes for the same email regardless of case', () => {
    expect(() => assertNoCrossEmailAutoLink('A@example.com', 'a@EXAMPLE.com')).not.toThrow();
  });

  it('passes when either email is missing', () => {
    expect(() => assertNoCrossEmailAutoLink(null, 'a@example.com')).not.toThrow();
    expect(() => assertNoCrossEmailAutoLink('a@example.com', null)).not.toThrow();
    expect(() => assertNoCrossEmailAutoLink(null, null)).not.toThrow();
  });
});
