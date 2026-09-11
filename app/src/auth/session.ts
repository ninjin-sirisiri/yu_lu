export type OAuthProvider = 'apple' | 'google';
export type SessionOutcome =
  | { kind: 'returning'; provider: OAuthProvider; accountId: string }
  | { kind: 'register'; provider: OAuthProvider }
  | { kind: 'unrecoverable' };

export function resolveSessionOutcome(input: {
  provider: OAuthProvider;
  accountId: string | null;
  providerAccountSelected: boolean;
  allMethodsLost: boolean;
}): SessionOutcome {
  if (input.allMethodsLost) return { kind: 'unrecoverable' };
  if (input.accountId && input.providerAccountSelected) {
    return { kind: 'returning', provider: input.provider, accountId: input.accountId };
  }
  return { kind: 'register', provider: input.provider };
}

export function assertNoCrossEmailAutoLink(existingEmail: string | null, nextEmail: string | null): void {
  if (existingEmail && nextEmail && existingEmail.toLowerCase() !== nextEmail.toLowerCase()) {
    throw new Error('Do not auto-link OAuth logins with different emails.');
  }
}
