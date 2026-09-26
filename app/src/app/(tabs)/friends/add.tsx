import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type TextInputProps } from 'react-native';

import { searchProfiles } from '../../../backend/queries';
import { SearchController, RELATIONSHIP_LABELS, type SearchState } from '../../../discovery/searchController';
import { useTheme } from '../../../theme/provider';
import { radius, spacing, typography, controls } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Field } from '../../../ui/Field';
import { Screen } from '../../../ui/Screen';
import { StatusNotice } from '../../../ui/StatusNotice';
import {
  AdaptiveLayout,
  useAdaptiveLayoutState,
  type LayoutMetricsInput,
} from '../../../navigation/AdaptiveLayout';
import { ProfilePanel } from './[userId]';

// Task 12: 友達追加 = User ID 部分一致検索 + 確認プロフィール.
//
// The screen is only wiring: TextInput events → SearchController (which
// owns the 2文字/300ms/変換中/世代 rules), controller state → visible
// status blocks, candidate row → shared selection → ProfilePanel. The
// 旧 resolveSingleCandidate single-candidate flow is NOT used: any number
// of partial matches may render, each row selectable. QR / invite parts
// of the 友達追加画面 arrive with Task 14.

export interface AddAreaProps {
  /** Window metrics override (tests); defaults to the real window. */
  metrics?: LayoutMetricsInput;
}

export function AddArea({ metrics }: AddAreaProps) {
  const { tokens } = useTheme();
  const { selectedPeerId, selectPeer } = useAdaptiveLayoutState();
  const controller = useMemo(
    () => new SearchController({ search: (query, cursor) => searchProfiles(query, cursor) }),
    [],
  );
  const [state, setState] = useState<SearchState>(() => controller.getState());
  const composingRef = useRef(false);

  useEffect(() => controller.subscribe(setState), [controller]);
  useEffect(() => () => controller.dispose(), [controller]);

  // onChange composing detection: platforms that surface IME composition
  // in the change event keep the search suppressed while composing
  // (入力変換中は検索しない). Where the platform reports no composition
  // state the flag stays false and the 300ms debounce governs.
  const onChange: NonNullable<TextInputProps['onChange']> = (event) => {
    const native = event.nativeEvent as { text?: string; isComposing?: boolean };
    const composing = native.isComposing === true;
    composingRef.current = composing;
    const text = typeof native.text === 'string' ? native.text : controller.getState().input;
    controller.handleTextChange(text, { composing });
  };

  const onChangeText = (text: string): void => {
    controller.handleTextChange(text, { composing: composingRef.current });
  };

  return (
    <Screen testID="friends-add-screen">
      <Field
        label="User ID 検索"
        testID="search-input"
        value={state.input}
        onChangeText={onChangeText}
        onChange={onChange}
        placeholder="例: aoi_07"
        accessibilityHint="2文字以上のUser IDで部分一致検索します"
        autoCapitalize="none"
        autoCorrect={false}
      />

      {state.status === 'tooShort' && (
        <Text style={[styles.hint, { color: tokens.muted }]} testID="search-too-short">
          2文字以上で入力してください
        </Text>
      )}

      {state.status === 'loading' && (
        <Text style={[styles.hint, { color: tokens.muted }]} testID="search-loading">
          検索中…
        </Text>
      )}

      {state.status === 'error' && state.error === 'offline' && (
        <StatusNotice
          tone="warning"
          title="オフラインのため検索できません"
          message="接続後に自動で再検索できるよう、入力は保持されます。"
          testID="search-offline"
        />
      )}

      {state.status === 'error' && state.error === 'network' && (
        <View style={styles.errorBlock}>
          <StatusNotice tone="error" title="検索できませんでした" testID="search-network" />
          <Button
            label="再試行"
            variant="secondary"
            testID="search-retry"
            onPress={() => controller.retry()}
          />
        </View>
      )}

      {state.status === 'success' && state.results.length === 0 && (
        <Text style={[styles.hint, { color: tokens.muted }]} testID="search-empty">
          一致するUser IDが見つかりません
        </Text>
      )}

      <AdaptiveLayout
        metrics={metrics}
        testID="add-layout"
        list={
          <View style={styles.listRoot}>
            <ScrollView contentContainerStyle={styles.listContent}>
              {state.results.map((profile) => (
                <Pressable
                  key={profile.userId}
                  testID={`candidate-row-${profile.userIdText}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${profile.displayName} ${profile.userIdText}`}
                  onPress={() => selectPeer(profile.userId)}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      backgroundColor: pressed ? tokens.soft : 'transparent',
                      borderColor: tokens.line,
                    },
                  ]}
                >
                  <View style={[styles.rowAvatar, { backgroundColor: tokens.avatar }]}>
                    <Text style={[styles.rowAvatarText, { color: tokens.avatarInk }]} allowFontScaling>
                      {profile.displayName.slice(0, 1)}
                    </Text>
                  </View>
                  <View style={styles.rowName}>
                    <Text style={[styles.rowTitle, { color: tokens.text }]} allowFontScaling>
                      {profile.displayName}
                    </Text>
                    <Text style={[styles.rowMeta, { color: tokens.muted }]} allowFontScaling>
                      {profile.userIdText}
                    </Text>
                  </View>
                  <Text
                    style={[styles.rowState, { color: tokens.muted }]}
                    testID={`candidate-relationship-${profile.userIdText}`}
                    allowFontScaling
                  >
                    {RELATIONSHIP_LABELS[profile.relationship]}
                  </Text>
                </Pressable>
              ))}

              {state.nextCursor !== null && state.status === 'success' && (
                <View style={styles.moreBlock}>
                  {state.loadingMore ? (
                    <Text style={[styles.hint, { color: tokens.muted }]} testID="search-loading-more">
                      読み込み中…
                    </Text>
                  ) : (
                    <Button
                      label="もっと見る"
                      variant="secondary"
                      testID="search-load-more"
                      onPress={() => controller.loadMore()}
                    />
                  )}
                  {state.loadMoreError !== null && (
                    <StatusNotice
                      tone={state.loadMoreError === 'offline' ? 'warning' : 'error'}
                      title={
                        state.loadMoreError === 'offline'
                          ? 'オフラインのため続きを取得できません'
                          : '続きを読み込めませんでした'
                      }
                      testID="search-load-more-error"
                    />
                  )}
                </View>
              )}
            </ScrollView>
          </View>
        }
        detail={
          selectedPeerId === null ? null : (
            <ProfilePanel userId={selectedPeerId} onBack={() => selectPeer(null)} />
          )
        }
        emptyDetail={
          <Text style={[styles.emptyDetail, { color: tokens.muted }]} testID="add-empty-detail">
            候補を選ぶとプロフィールを確認できます
          </Text>
        }
      />
    </Screen>
  );
}

export default function AddFriendScreen() {
  return <AddArea />;
}

const styles = StyleSheet.create({
  hint: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
    paddingVertical: spacing.s1,
  },
  errorBlock: {
    gap: spacing.s2,
  },
  listRoot: {
    flex: 1,
  },
  listContent: {
    gap: spacing.s2,
    paddingBottom: spacing.s4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    minHeight: controls.friendRowMinHeight,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2,
  },
  rowAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowAvatarText: {
    fontSize: typography.sizes.bodyLarge,
    fontWeight: typography.weights.semibold,
  },
  rowName: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitle: {
    fontSize: typography.sizes.bodyLarge,
    fontWeight: typography.weights.semibold,
    lineHeight: typography.sizes.bodyLarge * typography.lineHeightRatio,
  },
  rowMeta: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  rowState: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
    textAlign: 'right',
  },
  moreBlock: {
    gap: spacing.s2,
    paddingTop: spacing.s2,
  },
  emptyDetail: {
    fontSize: typography.sizes.body,
    textAlign: 'center',
    padding: spacing.s5,
  },
});
