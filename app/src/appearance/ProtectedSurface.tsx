import type { ReactNode } from 'react';
import { StyleSheet, View, type AccessibilityRole, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme/provider';
import { radius } from '../theme/tokens';

/**
 * Task 11: protected (input / error / confirmation / send-status) surface.
 *
 * Growth decoration never enters this component. It keeps the existing
 * light/dark semantic tokens, uses an opaque surface and a meaningful
 * boundary colour with at least 3:1 contrast (the low-contrast `line` token is
 * deliberately not used for an operation boundary). Child text colours are
 * preserved; error/status meaning must also be carried by text or an icon,
 * never by colour alone.
 *
 * There is no absolute overlay, no measurement and no padding: the wrapper
 * does not alter the child's layout, safe area or keyboard behaviour.
 */

export interface ProtectedSurfaceProps {
  children: ReactNode;
  tone?: 'default' | 'error';
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityRole?: AccessibilityRole;
}

const styles = StyleSheet.create({
  surface: {
    borderWidth: 1,
    borderRadius: radius.md,
  },
});

export function ProtectedSurface({
  children,
  tone = 'default',
  style,
  testID,
  accessibilityRole,
}: ProtectedSurfaceProps) {
  const { tokens } = useTheme();
  const boundary = tone === 'error' ? tokens.danger : tokens.muted;

  return (
    <View
      testID={testID}
      accessibilityRole={accessibilityRole}
      style={[
        styles.surface,
        { backgroundColor: tokens.surface, borderColor: boundary },
        style,
      ]}
    >
      {children}
    </View>
  );
}
