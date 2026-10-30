import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppearancePreferences } from '../../../appearance/preferences';
import type { AppearanceVibrancy } from '../../../appearance/catalog';
import { useTheme } from '../../../theme/provider';
import { controls, radius, spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';
import { StatusNotice } from '../../../ui/StatusNotice';

// Task 9: 見た目設定 (マイページのスタック内).
//
// 派手／控えめ／オフ chooses the device-local vibrancy, and the two switches
// stop chat / streak celebrations independently. 控えめ keeps colour but stops
// constant motion and celebrations; オフ returns to a scheme-appropriate
// monochrome. The OS reduce-motion flag is reflected read-only: it turns a
// flashy celebration into a static display and never overrides 控えめ/オフ.
//
// The setting is device-scoped (Task 8 `appearance.preferences`, NULL account):
// it survives logout, applies to every account on this device and is never
// synced to the server or another device.

const VIBRANCY_OPTIONS: ReadonlyArray<{
  id: AppearanceVibrancy;
  label: string;
  description: string;
}> = [
  {
    id: 'flashy',
    label: '派手',
    description: '色・模様・動きと節目演出を楽しみます（初期値）。',
  },
  {
    id: 'subtle',
    label: '控えめ',
    description: '色と模様は残し、恒常的な動きと節目演出を止めます。',
  },
  {
    id: 'off',
    label: 'オフ',
    description: '装飾と色づきを止め、選択中の明暗に合わせたモノクロにします。',
  },
];

export default function AppearanceSettingsScreen() {
  const { tokens } = useTheme();
  const {
    preferences,
    status,
    saveError,
    reducedMotion,
    setVibrancy,
    setKindEnabled,
    retrySave,
  } = useAppearancePreferences();

  return (
    <Screen scroll testID="appearance-settings-screen">
      <StatusNotice
        tone="neutral"
        title="この端末だけの設定"
        message="見た目設定はこの端末に保存され、ログアウトしても残ります。他の端末やアカウントには同期されません。"
        testID="appearance-local-note"
      />

      {status === 'loading' && (
        <Text style={[styles.placeholder, { color: tokens.muted }]} testID="appearance-loading">
          端末設定を読み込んでいます…
        </Text>
      )}

      {status === 'unavailable' && (
        <StatusNotice
          tone="warning"
          title="見た目設定を読み込めませんでした"
          message="端末の保存領域を開けないため、この起動中は節目演出を再生しません。アプリを開き直してください。"
          testID="appearance-unavailable"
        />
      )}

      {status === 'ready' && (
        <>
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: tokens.text }]}>派手さ</Text>
            <View style={styles.picker}>
              {VIBRANCY_OPTIONS.map((option) => {
                const selected = option.id === preferences.vibrancy;
                return (
                  <Button
                    key={option.id}
                    testID={`appearance-vibrancy-${option.id}`}
                    label={option.label}
                    variant={selected ? 'primary' : 'ghost'}
                    selected={selected}
                    accessibilityHint={option.description}
                    onPress={() => {
                      void setVibrancy(option.id);
                    }}
                    style={[
                      styles.vibrancyButton,
                      // Unselected choices are ghost buttons; a meaningful
                      // control boundary must stay at 3:1, unlike tokens.line.
                      !selected && { borderColor: tokens.muted },
                    ]}
                  />
                );
              })}
            </View>
            <Text style={[styles.footnote, { color: tokens.muted }]}>
              {VIBRANCY_OPTIONS.find((option) => option.id === preferences.vibrancy)?.description}
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: tokens.text }]}>種類別の節目演出</Text>
            <SwitchRow
              testID="appearance-chat-toggle"
              label="チャットの節目演出"
              description="友達とのチャットの成長が節目に達したときに表示します。"
              value={preferences.chatEnabled}
              onPress={() => {
                void setKindEnabled('chat', !preferences.chatEnabled);
              }}
            />
            <SwitchRow
              testID="appearance-streak-toggle"
              label="ストリークの節目演出"
              description="本人の連続記録が節目に達したときに表示します。"
              value={preferences.streakEnabled}
              onPress={() => {
                void setKindEnabled('streak', !preferences.streakEnabled);
              }}
            />
            <Text style={[styles.footnote, { color: tokens.muted }]}>
              種類別の停止は節目演出だけを止め、普段の色・模様・成長は変えません。
            </Text>
          </View>

          {reducedMotion && preferences.vibrancy === 'flashy' && (
            <StatusNotice
              tone="info"
              title="OSの動き軽減が有効です"
              message="派手のままでも、背景の動きを止めて節目を静止表示に置き換えます。"
              testID="appearance-os-reduced"
            />
          )}

          {saveError !== null && (
            <View style={styles.section}>
              <StatusNotice
                tone="error"
                title="見た目設定を保存できませんでした"
                message="選択内容はこの起動中は反映されています。保存を再試行してください。"
                testID="appearance-save-error"
              />
              <Button
                label="再試行"
                variant="secondary"
                testID="appearance-save-retry"
                accessibilityHint="最新の見た目設定をもう一度保存します"
                onPress={() => {
                  void retrySave();
                }}
              />
            </View>
          )}
        </>
      )}
    </Screen>
  );
}

interface SwitchRowProps {
  testID: string;
  label: string;
  description: string;
  value: boolean;
  onPress: () => void;
}

function SwitchRow({ testID, label, description, value, onPress }: SwitchRowProps) {
  const { tokens } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessible
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked: value }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.switchRow,
        {
          // A meaningful control boundary needs 3:1; tokens.line is decorative.
          borderColor: tokens.muted,
          backgroundColor: tokens.soft,
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      <View style={styles.switchText}>
        <Text style={[styles.switchLabel, { color: tokens.text }]} allowFontScaling>
          {label}
        </Text>
        <Text style={[styles.switchDescription, { color: tokens.muted }]} allowFontScaling>
          {description}
        </Text>
      </View>
      <Text style={[styles.switchState, { color: tokens.text }]} allowFontScaling>
        {value ? 'オン' : 'オフ'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    marginTop: spacing.s5,
    fontSize: typography.sizes.bodyLarge,
  },
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
  vibrancyButton: {
    flexGrow: 1,
    minWidth: 150,
  },
  footnote: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  switchRow: {
    minHeight: controls.actionMinHeight,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
  },
  switchText: {
    flex: 1,
    gap: spacing.s1,
  },
  switchLabel: {
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  switchDescription: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  switchState: {
    fontSize: typography.sizes.control,
    fontWeight: typography.weights.bold,
    minWidth: 32,
    textAlign: 'right',
  },
});
