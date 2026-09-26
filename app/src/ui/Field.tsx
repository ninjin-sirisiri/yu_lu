import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { useTheme } from '../theme/provider';
import { controls, focusRing, radius, spacing, typography } from '../theme/tokens';

/**
 * Labeled text field.
 *
 * Accessibility: a visible label always accompanies the input and is passed
 * as `accessibilityLabel` (screen readers announce it even when the visual
 * label scrolled away), `accessibilityHint` explains purpose/format, focus
 * shows a ring, and the error is rendered as TEXT (never colour alone) with
 * `accessibilityLiveRegion` + `accessibilityRole="alert"` so it is announced
 * when it appears.
 */

export interface FieldProps extends Pick<
  TextInputProps,
  | 'keyboardType'
  | 'autoCapitalize'
  | 'autoCorrect'
  | 'secureTextEntry'
  | 'maxLength'
  | 'returnKeyType'
  | 'onSubmitEditing'
  | 'textContentType'
  | 'autoComplete'
  | 'editable'
  // Task 12: the search field needs the raw change event for IME
  // composition detection (入力変換中は検索しない); forwarded verbatim.
  | 'onChange'
> {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  /** Error text shown under the field; `null`/`undefined` hides it. */
  error?: string | null;
  /** Helper text (also announced as the input's hint). */
  hint?: string | null;
  placeholder?: string;
  testID?: string;
  accessibilityHint?: string;
}

export function Field({
  label,
  value,
  onChangeText,
  error,
  hint,
  placeholder,
  testID,
  accessibilityHint,
  ...inputProps
}: FieldProps) {
  const { tokens } = useTheme();
  const [focused, setFocused] = useState(false);
  const hasError = error !== null && error !== undefined && error !== '';

  return (
    <View style={styles.wrapper}>
      <Text style={[styles.label, { color: tokens.text }]} allowFontScaling>
        {label}
      </Text>
      <TextInput
        testID={testID}
        style={[
          styles.input,
          {
            backgroundColor: tokens.surface,
            borderColor: hasError ? tokens.danger : focused ? focusRing.color : tokens.line,
            color: tokens.text,
          },
          focused && {
            outlineColor: focusRing.color,
            outlineWidth: focusRing.width,
            outlineStyle: 'solid',
          },
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        // onChange (composition detection) rides along via {...inputProps}.
        placeholderTextColor={tokens.muted}
        accessibilityLabel={label}
        accessibilityHint={
          accessibilityHint ?? (hint !== null && hint !== undefined ? hint : undefined)
        }
        accessibilityState={{ disabled: inputProps.editable === false }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        allowFontScaling
        {...inputProps}
      />
      {hint !== null && hint !== undefined && !hasError && (
        <Text style={[styles.hint, { color: tokens.muted }]} allowFontScaling>
          {hint}
        </Text>
      )}
      {hasError && (
        <Text
          style={[styles.error, { color: tokens.danger }]}
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          allowFontScaling
        >
          {`エラー: ${error}`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: spacing.s1,
  },
  label: {
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  input: {
    minHeight: controls.buttonMinHeight,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s3,
    fontSize: typography.sizes.bodyLarge,
  },
  hint: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  error: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
    fontWeight: typography.weights.semibold,
  },
});
