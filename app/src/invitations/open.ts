export function assertInvitationOpenable(now: Date, expiresAt: Date): void {
  if (now.getTime() >= expiresAt.getTime()) {
    throw new Error('This invitation expired. Ask for a new invitation.');
  }
}

export function invitationReturnTarget(invitationToken: string | null): string | null {
  if (!invitationToken) return null;
  return `invitation:${invitationToken}`;
}
