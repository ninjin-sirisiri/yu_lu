import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme/provider';
import { controls, radius, spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import {
  DEV_PREVIEW_STAGES,
  devPreviewAvailable,
  devStreakForStage,
  setDevPreview,
  useDevPreview,
} from './devPreview';
import { chatProgress, streakProgress } from './progress';

/**
 * Development-build control for the streak/growth appearance.
 *
 * It only changes what `AppearanceProvider` renders, so the milestone
 * palettes, patterns, stickers and progress copy can be checked immediately
 * without waiting for real days or writing to Supabase. A release build
 * renders nothing (`devPreviewAvailable()` is false).
 *
 * Position: a small pill above the tab bar, outside the content's touch path.
 * The sheet is a plain Modal so it works on top of every route.
 */

export function DevPreviewPanel() {
  const insets = useSafeAreaInsets();
  const { tokens } = useTheme();
  const preview = useDevPreview();
  const [open, setOpen] = useState(false);

  if (!devPreviewAvailable()) return null;

  const streak = preview?.streak ?? null;
  const growthDays = preview?.growthDays ?? null;
  const streakPreview = streak ? streakProgress(streak) : null;
  const growthPreview = growthDays === null ? null : chatProgress(growthDays);
  const resetSelected = streak?.currentStreak === 0 && streak.earnedDays === 29;

  const setStreak = (days: number) => {
    setDevPreview({ streak: devStreakForStage(days), growthDays });
  };
  const setResetStreak = () => {
    setDevPreview({
      streak: { currentStreak: 0, earnedDays: 29 },
      growthDays,
    });
  };
  const setGrowth = (days: number) => {
    setDevPreview({ streak, growthDays: days });
  };
  const restore = () => {
    setDevPreview(null);
  };
  const active = preview !== null;

  return (
    <>
      <Pressable
        testID="dev-preview-open"
        accessible
        accessibilityRole="button"
        accessibilityLabel="開発用の見た目プレビューを開く"
        accessibilityHint="ストリークとチャット成長の表示を一時的に切り替えます"
        hitSlop={8}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.trigger,
          {
            bottom: insets.bottom + 64,
            backgroundColor: tokens.accent,
            opacity: pressed ? 0.6 : active ? 1 : 0.55,
          },
        ]}
      >
        <Text style={[styles.triggerLabel, { color: tokens.onAccent }]} allowFontScaling={false}>
          DEV
        </Text>
      </Pressable>

      <Modal
        transparent
        visible={open}
        animationType="fade"
        onRequestClose={() => setOpen(false)}
        statusBarTranslucent
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable
            testID="dev-preview-sheet"
            accessibilityViewIsModal
            onPress={(event) => event.stopPropagation()}
            style={[
              styles.sheet,
              {
                backgroundColor: tokens.surface,
                borderColor: tokens.line,
                paddingBottom: insets.bottom + spacing.s4,
              },
            ]}
          >
            <ScrollView
              contentContainerStyle={styles.sheetContent}
              keyboardShouldPersistTaps="handled"
            >
              <Text accessibilityRole="header" style={[styles.title, { color: tokens.text }]}>
                開発用：見た目プレビュー
              </Text>
              <Text style={[styles.note, { color: tokens.muted }]}>
                表示だけを切り替えます。サーバーの連続記録・獲得日数は変更しません。
              </Text>

              <Text style={[styles.sectionTitle, { color: tokens.text }]}>自分のストリーク</Text>
              <View style={styles.chips}>
                {DEV_PREVIEW_STAGES.map((days) => (
                  <Chip
                    key={days}
                    testID={`dev-preview-streak-${days}`}
                    label={`${days}日`}
                    selected={streak?.currentStreak === days && streak.earnedDays === days}
                    onPress={() => setStreak(days)}
                  />
                ))}
              </View>
              <Pressable
                testID="dev-preview-reset-streak"
                accessible
                accessibilityRole="button"
                accessibilityState={{ selected: resetSelected }}
                accessibilityHint="獲得済みは7日段階のまま、現在の連続だけ0日に戻した表示"
                onPress={setResetStreak}
                style={({ pressed }) => [
                  styles.scenario,
                  {
                    backgroundColor: resetSelected ? tokens.accent : tokens.soft,
                    borderColor: resetSelected ? tokens.accent : tokens.muted,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.scenarioLabel,
                    { color: resetSelected ? tokens.onAccent : tokens.text },
                  ]}
                  allowFontScaling
                >
                  リセット中を再現（現在0日 / 獲得29日）
                </Text>
              </Pressable>
              <Text style={[styles.footnote, { color: tokens.muted }]}>
                獲得日数で段階と装飾、現在日数で「次まであと」が変わります。
              </Text>

              {streakPreview && (
                <View
                  testID="dev-preview-streak-copy"
                  style={[styles.copy, { backgroundColor: tokens.soft, borderColor: tokens.line }]}
                >
                  <Text style={[styles.copyLine, { color: tokens.text }]} allowFontScaling>
                    {streakPreview.copy.current}
                  </Text>
                  <Text style={[styles.copyLine, { color: tokens.text }]} allowFontScaling>
                    {streakPreview.copy.stage}
                  </Text>
                  <Text style={[styles.copyLine, { color: tokens.muted }]} allowFontScaling>
                    {streakPreview.copy.next}
                  </Text>
                </View>
              )}

              <Text style={[styles.sectionTitle, { color: tokens.text }]}>チャットの成長</Text>
              <View style={styles.chips}>
                {DEV_PREVIEW_STAGES.map((days) => (
                  <Chip
                    key={days}
                    testID={`dev-preview-growth-${days}`}
                    label={`${days}日`}
                    selected={growthDays === days}
                    onPress={() => setGrowth(days)}
                  />
                ))}
              </View>
              <Text style={[styles.footnote, { color: tokens.muted }]}>
                会話画面の背景・模様・「累計N日」表示に反映します。
              </Text>

              {growthPreview && (
                <View
                  testID="dev-preview-growth-copy"
                  style={[styles.copy, { backgroundColor: tokens.soft, borderColor: tokens.line }]}
                >
                  <Text style={[styles.copyLine, { color: tokens.text }]} allowFontScaling>
                    {growthPreview.copy.current}
                  </Text>
                  <Text style={[styles.copyLine, { color: tokens.text }]} allowFontScaling>
                    {growthPreview.copy.stage}
                  </Text>
                  <Text style={[styles.copyLine, { color: tokens.muted }]} allowFontScaling>
                    {growthPreview.copy.next}
                  </Text>
                </View>
              )}

              <View style={styles.actions}>
                <Button
                  label="サーバーの値に戻す"
                  variant="secondary"
                  testID="dev-preview-off"
                  disabled={preview === null}
                  onPress={restore}
                  style={styles.action}
                />
                <Button
                  label="閉じる"
                  variant="ghost"
                  testID="dev-preview-close"
                  onPress={() => setOpen(false)}
                  style={styles.action}
                />
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? tokens.accent : tokens.soft,
          borderColor: selected ? tokens.accent : tokens.muted,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text
        style={[styles.chipLabel, { color: selected ? tokens.onAccent : tokens.text }]}
        allowFontScaling
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: {
    position: 'absolute',
    right: spacing.s3,
    minHeight: 34,
    paddingHorizontal: spacing.s3,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    elevation: 100,
  },
  triggerLabel: {
    fontSize: 11,
    fontWeight: typography.weights.semibold,
    letterSpacing: 0.5,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '86%',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  sheetContent: {
    padding: spacing.s4,
    gap: spacing.s3,
  },
  title: {
    fontSize: typography.sizes.bodyLarge,
    fontWeight: typography.weights.semibold,
  },
  note: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  sectionTitle: {
    marginTop: spacing.s2,
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.s2,
  },
  chip: {
    minHeight: controls.minTouchTarget,
    minWidth: 56,
    paddingHorizontal: spacing.s3,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipLabel: {
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.medium,
  },
  scenario: {
    minHeight: controls.actionMinHeight,
    paddingHorizontal: spacing.s3,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  scenarioLabel: {
    fontSize: typography.sizes.body,
  },
  footnote: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  copy: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.s3,
    gap: spacing.s1,
  },
  copyLine: {
    fontSize: typography.sizes.body,
    lineHeight: typography.sizes.body * typography.lineHeightRatio,
  },
  actions: {
    marginTop: spacing.s2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.s2,
  },
  action: {
    flexGrow: 1,
  },
});
