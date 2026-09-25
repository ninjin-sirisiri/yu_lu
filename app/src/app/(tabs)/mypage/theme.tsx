import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  SAME_TIME_MESSAGE,
  THEME_MODES,
  THEME_MODE_LABELS,
  TIME_FORMAT_MESSAGE,
  parseTimeOfDay,
  type ThemeMode,
} from '../../../theme/schedule';
import { useTheme } from '../../../theme/provider';
import { spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Field } from '../../../ui/Field';
import { Screen } from '../../../ui/Screen';
import { StatusNotice } from '../../../ui/StatusNotice';

// Task 11: テーマ設定画面 (マイページのスタック内).
//
// 4 modes — ライト / ダーク / 端末に合わせる (初期既定) / 時間帯で切り替える.
// The schedule editor appears only in 時間帯 mode, validates on save and
// rejects identical times BEFORE anything is persisted (同時刻は保存不可).
// The settings are device-scoped (provider.tsx): they survive logout and are
// never tied to the signed-in account.

export default function ThemeSettingsScreen() {
  const { mode, schedule, scheme, setMode, saveSchedule, ready, tokens } = useTheme();

  const [lightStart, setLightStart] = useState(schedule.lightStart);
  const [darkStart, setDarkStart] = useState(schedule.darkStart);
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirtyRef = useRef(false);

  // Sync the inputs with the persisted schedule until the user edits them
  // (the provider hydrates asynchronously after the first render).
  useEffect(() => {
    if (dirtyRef.current) return;
    setLightStart(schedule.lightStart);
    setDarkStart(schedule.darkStart);
  }, [schedule.lightStart, schedule.darkStart]);

  const lightFormatError = parseTimeOfDay(lightStart) === null;
  const darkFormatError = parseTimeOfDay(darkStart) === null;
  const sameTime =
    !lightFormatError && !darkFormatError && parseTimeOfDay(lightStart) === parseTimeOfDay(darkStart);

  const editLight = (text: string): void => {
    dirtyRef.current = true;
    setSaved(false);
    setLightStart(text);
  };
  const editDark = (text: string): void => {
    dirtyRef.current = true;
    setSaved(false);
    setDarkStart(text);
  };

  const onSave = async (): Promise<void> => {
    setAttempted(true);
    setSaved(false);
    const result = await saveSchedule({ lightStart, darkStart });
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    setSaveError(null);
    setSaved(true);
    dirtyRef.current = false;
  };

  return (
    <Screen scroll testID="theme-settings-screen">
      <StatusNotice
        tone="neutral"
        title={`現在の表示: ${scheme === 'dark' ? 'ダーク' : 'ライト'}`}
        message="テーマ設定はこの端末に保存され、ログアウトしても残ります。"
        testID="theme-current-scheme"
      />

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: tokens.text }]}>テーマ</Text>
        <View style={styles.picker}>
          {THEME_MODES.map((option: ThemeMode) => (
            <Button
              key={option}
              testID={`theme-mode-${option}`}
              label={THEME_MODE_LABELS[option]}
              variant={option === mode ? 'primary' : 'ghost'}
              selected={option === mode}
              accessibilityHint={option === mode ? '選択中のテーマ' : undefined}
              onPress={() => {
                setSaved(false);
                setSaveError(null);
                void setMode(option);
              }}
              style={styles.modeButton}
            />
          ))}
        </View>
        {!ready && (
          <Text style={[styles.footnote, { color: tokens.muted }]}>端末設定を読み込んでいます…</Text>
        )}
      </View>

      {mode === 'schedule' && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: tokens.text }]}>
            時間帯 (端末の現地時刻)
          </Text>
          <Field
            label="ライト開始時刻"
            testID="theme-light-start"
            value={lightStart}
            onChangeText={editLight}
            hint="07:00 からライト表示になります。"
            error={attempted && lightFormatError ? TIME_FORMAT_MESSAGE : null}
            keyboardType="numbers-and-punctuation"
          />
          <Field
            label="ダーク開始時刻"
            testID="theme-dark-start"
            value={darkStart}
            onChangeText={editDark}
            hint="19:00 からダーク表示になります。"
            error={
              attempted
                ? darkFormatError
                  ? TIME_FORMAT_MESSAGE
                  : sameTime
                    ? SAME_TIME_MESSAGE
                    : null
                : null
            }
            keyboardType="numbers-and-punctuation"
          />
          <Button
            label="時間帯を保存"
            testID="theme-schedule-save"
            onPress={() => void onSave()}
          />
          {saveError !== null && (
            <StatusNotice
              tone="error"
              title={saveError}
              message="別の時刻を入力してください。入力内容は保持されます。"
              testID="theme-schedule-error"
            />
          )}
          {saved && (
            <StatusNotice
              tone="success"
              title="時間帯を保存しました"
              message="閉じている間に時刻を過ぎても、復帰時に反映されます。"
              testID="theme-schedule-saved"
            />
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.s5,
    gap: spacing.s3,
  },
  sectionTitle: {
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  picker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.s2,
  },
  modeButton: {
    flexGrow: 1,
    minWidth: 150,
  },
  footnote: {
    fontSize: typography.sizes.caption,
  },
});
