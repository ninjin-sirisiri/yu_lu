import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppearanceDecorations } from './AppearanceDecorations';
import type { AppearanceVisual } from './calculate';

/**
 * Task 11: full-size appearance surface.
 *
 * The decoration is an absolute sibling behind the content. It never measures
 * or reserves height, so a 100-day appearance cannot take body area from the
 * text/input above it. Children are rendered once and are not keyed by the
 * visual, day or stage: changing the appearance must not remount the chat or
 * lose an active input.
 */

export interface AppearanceSurfaceProps {
  visual: AppearanceVisual;
  children: ReactNode;
  /** False for offscreen/inactive surfaces: static background only. */
  active?: boolean;
  /** OS reduced-motion setting. */
  reduceMotion?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

const styles = StyleSheet.create({
  surface: {
    flex: 1,
    position: 'relative',
  },
  content: {
    flex: 1,
  },
});

export function AppearanceSurface({
  visual,
  children,
  active = true,
  reduceMotion = false,
  style,
  contentStyle,
  testID = 'appearance-surface',
}: AppearanceSurfaceProps) {
  return (
    <View
      testID={testID}
      style={[styles.surface, { backgroundColor: visual.background }, style]}
    >
      <AppearanceDecorations
        visual={visual}
        active={active}
        reduceMotion={reduceMotion}
        testID={`${testID}-decorations`}
      />
      <View testID={`${testID}-content`} style={[styles.content, contentStyle]}>
        {children}
      </View>
    </View>
  );
}
