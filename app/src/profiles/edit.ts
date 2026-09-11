export const EDITABLE_PROFILE_FIELDS = ['display_name', 'avatar_path', 'introduction'] as const;

export function assertEditableProfileField(field: string): void {
  if (!(EDITABLE_PROFILE_FIELDS as readonly string[]).includes(field)) {
    throw new Error('Only display name, image, and introduction can be changed.');
  }
}
