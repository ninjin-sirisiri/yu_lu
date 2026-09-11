import { assertEditableProfileField, EDITABLE_PROFILE_FIELDS } from './edit';

describe('EDITABLE_PROFILE_FIELDS', () => {
  it('allows only display name, image, and introduction', () => {
    expect([...EDITABLE_PROFILE_FIELDS]).toEqual(['display_name', 'avatar_path', 'introduction']);
  });
});

describe('assertEditableProfileField', () => {
  it.each(['display_name', 'avatar_path', 'introduction'])('allows %s', (field) => {
    expect(() => assertEditableProfileField(field)).not.toThrow();
  });

  it.each(['user_id_text', 'user_id', 'user_id_confirmed_at'])(
    'rejects immutable User ID field %s',
    (field) => {
      expect(() => assertEditableProfileField(field)).toThrow(
        'Only display name, image, and introduction can be changed.',
      );
    },
  );

  it('rejects unknown fields', () => {
    expect(() => assertEditableProfileField('email')).toThrow(
      'Only display name, image, and introduction can be changed.',
    );
  });
});
