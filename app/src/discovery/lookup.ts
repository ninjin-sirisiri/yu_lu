export interface PublicProfile {
  displayName: string;
  userIdText: string;
  avatarPath: string | null;
  introduction: string | null;
}

export function resolveSingleCandidate(candidates: PublicProfile[]): PublicProfile {
  if (candidates.length !== 1) {
    throw new Error('User ID input must resolve to exactly one candidate.');
  }
  return candidates[0];
}
