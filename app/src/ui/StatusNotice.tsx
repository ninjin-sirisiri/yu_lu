import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme/provider';
import { radius, spacing, typography } from '../theme/tokens';

/**
 * Status / notice block (neutral, success, warning, error).
 *
 * The state is carried by a visible TEXT badge (「完了」「注意」「エラー」…), so
 * it is never conveyed by colour alone; colour only adds emphasis. Errors and
 * warnings are announced with `accessibilityRole="alert"` and a polite live
 * region.
 */

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const TONE_BADGES: Record<StatusTone, string> = {
  neutral: '情報',
  info: '情報',
  success: '完了',
  warning: '注意',
  error: 'エラー',
};

const ANNOUNCED_TONES: readonly StatusTone[] = ['warning', 'error'];

export interface StatusNoticeProps {
  tone: StatusTone;
  /** Main line (e.g. what happened / what to do). */
  title: string;
  /** Optional detail under the title. */
  message?: string | null;
  testID?: string;
}

export function StatusNotice({ tone, title, message, testID }: StatusNoticeProps) {
  const { tokens } = useTheme();
  const announced = ANNOUNCED_TONES.includes(tone);
  const strong = tone === 'error' || tone === 'warning' || tone === 'success';
  const accentLine =
    tone === 'error' ? tokens.danger : tone === 'neutral' || tone === 'info' ? tokens.line : tokens.accent;

  return (
    <View
      style={[
        styles.box,
        { backgroundColor: tokens.soft, borderColor: tokens.line, borderLeftColor: accentLine },
      ]}
      testID={testID}
      accessible={false}
    >
      <View style={[styles.badge, { backgroundColor: tokens.accentSoft }]}>
        <Text
          style={[styles.badgeText, { color: tone === 'error' ? tokens.danger : tokens.accent }]}
          allowFontScaling
        >
          {TONE_BADGES[tone]}
        </Text>
      </View>
      <View style={styles.body}>
        <Text
          style={[
            styles.title,
            { color: tokens.text },
            strong && styles.strong,
          ]}
          accessibilityRole={announced ? 'alert' : 'text'}
          accessibilityLiveRegion={announced ? 'polite' : 'none'}
          allowFontScaling
        >
          {title}
        </Text>
        {message !== null && message !== undefined && (
          <Text style={[styles.message, { color: tokens.muted }]} allowFontScaling>
            {message}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.s3,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: radius.md,
    padding: spacing.s3,
  },
  badge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.s2,
    paddingVertical: spacing.s1,
    minWidth: 44,
    alignItems: 'center',
  },
  badgeText: {
    fontSize: typography.sizes.caption,
    fontWeight: typography.weights.bold,
  },
  body: {
    flex: 1,
    gap: spacing.s1,
  },
  title: {
    fontSize: typography.sizes.body,
    lineHeight: typography.sizes.body * typography.lineHeightRatio,
  },
  strong: {
    fontWeight: typography.weights.semibold,
  },
  message: {
    fontSize: typography.sizes.small,
    lineHeight: typography.sizes.small * typography.lineHeightRatio,
  },
});
