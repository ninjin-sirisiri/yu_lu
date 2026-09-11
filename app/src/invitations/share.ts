export const INVITATION_VALID_DAYS = 7;

export function invitationExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + INVITATION_VALID_DAYS * 24 * 60 * 60 * 1000);
}
