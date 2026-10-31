import React, { useContext } from 'react';
import {
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaInsetsContext, type EdgeInsets } from 'react-native-safe-area-context';

import { AppearanceDecorations } from '../appearance/AppearanceDecorations';
import { useAppearanceScope } from '../appearance/provider';
import { useTheme } from '../theme/provider';
import { radius, spacing, typography } from '../theme/tokens';

/**
 * Shared screen frame: themed background, safe-area padding, optional
 * header/footer and a scroll or fixed content area.
 *
 * Insets come from the app-level `<SafeAreaProvider>` (src/app/_layout.tsx).
 * Reading the context directly (instead of `useSafeAreaInsets`) keeps the
 * component renderable without a provider — unit tests and embedded previews
 * get zero insets instead of a thrown error, while the real app still gets
 * notch/home-indicator insets.
 */

const ZERO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export function useScreenInsets(): EdgeInsets {
  return useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;
}

export interface ScreenProps {
  children: React.ReactNode;
  /** Visible screen title; announced with `accessibilityRole="header"`. */
  title?: string;
  subtitle?: string;
  /** Scrolls the content area; otherwise content fills the remaining space. */
  scroll?: boolean;
  /** Pinned below the content (still inside the safe area). */
  footer?: React.ReactNode;
  /** Rendered at the top right of the header row (back/menu actions…). */
  headerAccessory?: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
  /**
   * Exposes the `scroll` content area to the caller (Task 22: the tab
   * re-select signal scrolls this ref back to the top). Ignored when
   * `scroll` is off — there is no scrollable to reference.
   */
  scrollViewRef?: React.RefObject<ScrollViewInstance | null>;
}

export function Screen({
  children,
  title,
  subtitle,
  scroll = false,
  footer,
  headerAccessory,
  contentStyle,
  testID,
  scrollViewRef,
}: ScreenProps) {
  const { tokens } = useTheme();
  const scope = useAppearanceScope();
  const visual = scope?.visual ?? null;
  const decoratedVisual =
    visual !== null && visual.stage > 0 && visual.vibrancy !== 'off' ? visual : null;
  const insets = useScreenInsets();
  const hasHeader = title !== undefined || subtitle !== undefined || headerAccessory !== undefined;
  // The decoration is an absolute sibling. The content keeps its own opaque
  // visual body surface, so body text never sits directly on a moving pattern
  // (保護された読みやすさ first). No measurement/padding/keyboard changes.
  const contentBackground = visual ? { backgroundColor: visual.bodySurface } : null;

  const content = scroll ? (
    <ScrollView
      ref={scrollViewRef}
      style={[styles.flex, contentBackground]}
      contentContainerStyle={[styles.scrollContent, contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, styles.fixedContent, contentBackground, contentStyle]}>{children}</View>
  );

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: visual?.background ?? tokens.surface, paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
      testID={testID}
    >
      {decoratedVisual && (
        <View
          testID={`${testID ?? 'screen'}-decorations`}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <AppearanceDecorations
            visual={decoratedVisual}
            active={scope?.active ?? false}
            reduceMotion={scope?.reduceMotion ?? false}
          />
        </View>
      )}
      {hasHeader && (
        <View style={styles.header}>
          <View
            style={[
              styles.flex,
              decoratedVisual && {
                backgroundColor: visual?.bodySurface,
                borderRadius: radius.md,
                paddingHorizontal: spacing.s2,
                paddingVertical: spacing.s1,
              },
            ]}
          >
            {title !== undefined && (
              <Text
                style={[styles.title, { color: visual?.text ?? tokens.text }]}
                accessibilityRole="header"
                allowFontScaling
              >
                {title}
              </Text>
            )}
            {subtitle !== undefined && (
              <Text style={[styles.subtitle, { color: visual?.mutedText ?? tokens.muted }]} allowFontScaling>
                {subtitle}
              </Text>
            )}
          </View>
          {headerAccessory}
        </View>
      )}
      {content}
      {footer !== undefined && (
        <View style={[styles.footer, contentBackground]}>{footer}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.s3,
    paddingHorizontal: spacing.s5,
    paddingTop: spacing.s5,
    paddingBottom: spacing.s4,
  },
  title: {
    fontSize: typography.sizes.title,
    fontWeight: typography.weights.semibold,
    lineHeight: typography.sizes.title * typography.lineHeightRatio,
  },
  subtitle: {
    fontSize: typography.sizes.small,
    lineHeight: typography.sizes.small * typography.lineHeightRatio,
    marginTop: spacing.s1,
  },
  fixedContent: {
    paddingHorizontal: spacing.s5,
  },
  scrollContent: {
    paddingHorizontal: spacing.s5,
    paddingBottom: spacing.s6,
  },
  footer: {
    paddingHorizontal: spacing.s5,
    paddingTop: spacing.s3,
    paddingBottom: spacing.s4,
    gap: spacing.s2,
  },
});
