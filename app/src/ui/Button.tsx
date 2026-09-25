import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme/provider';
import { controls, focusRing, radius, spacing, typography } from '../theme/tokens';

/**
 * Themed press button.
 *
 * Accessibility: explicit `accessibilityRole="button"`, an always-visible
 * label (or an explicit `accessibilityLabel`), `accessibilityState` carrying
 * disabled/busy/pressed so state is never colour-only, a 48pt minimum height
 * (44pt touch target), a visible pressed feedback (opacity, as in the spike's
 * `button:active`) and a focus ring using the spike's focus colour.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Shows the busy state (also marks the control as busy for readers). */
  busy?: boolean;
  /**
   * Marks a choice as currently selected (theme mode pickers). Exposed via
   * `accessibilityState.selected` and a visible ✓ marker — never colour alone.
   */
  selected?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  selected,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: ButtonProps) {
  const { tokens } = useTheme();
  const [focused, setFocused] = useState(false);
  // Explicit pressed state (also mirrored by Pressable's own style callback),
  // so the feedback is observable and testable without a native responder.
  const [pressed, setPressed] = useState(false);
  const inactive = disabled || busy;

  const palette = {
    primary: { bg: tokens.accent, fg: tokens.onAccent, border: tokens.accent },
    secondary: { bg: tokens.accentSoft, fg: tokens.accent, border: tokens.accentSoft },
    ghost: { bg: 'transparent', fg: tokens.text, border: tokens.line },
  }[variant];

  return (
    <Pressable
      testID={testID}
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy, selected }}
      disabled={inactive}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed: isPressed }) => [
        styles.base,
        {
          backgroundColor: palette.bg,
          borderColor: focused ? focusRing.color : palette.border,
          opacity: inactive ? 0.45 : pressed || isPressed ? 0.75 : 1,
        },
        focused && {
          outlineColor: focusRing.color,
          outlineWidth: focusRing.width,
          outlineStyle: 'solid',
        },
        style,
      ]}
    >
      <View style={styles.labelRow}>
        <Text style={[styles.label, { color: palette.fg }]} numberOfLines={2} allowFontScaling>
          {label}
        </Text>
        {selected === true && (
          <Text style={[styles.selectedMarker, { color: palette.fg }]} allowFontScaling>
            ✓
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: controls.buttonMinHeight,
    minWidth: controls.minTouchTarget,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.s4,
    paddingVertical: spacing.s3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s1,
  },
  label: {
    fontSize: typography.sizes.control,
    fontWeight: typography.weights.semibold,
    textAlign: 'center',
  },
  selectedMarker: {
    fontSize: typography.sizes.control,
    fontWeight: typography.weights.bold,
  },
});
