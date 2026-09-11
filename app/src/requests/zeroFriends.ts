export function zeroFriendGuidance(): { showAddEntries: true; streakChanges: false; message: string } {
  return {
    showAddEntries: true,
    streakChanges: false,
    message: '友達がいない日は抽選対象外です。Streakは変わりません。',
  };
}
