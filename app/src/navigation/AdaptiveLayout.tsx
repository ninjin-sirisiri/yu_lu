import React, { createContext, useContext, useMemo, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Link, usePathname } from 'expo-router';

import { useTheme } from '../theme/provider';
import { useAppearanceScope } from '../appearance/provider';
import { useScreenInsets } from '../ui/Screen';
import { radius, spacing, typography } from '../theme/tokens';
import { useChatUnreadBadge } from '../messages/unreadBadge';

/**
 * Adaptive layout (Global Constraints).
 *
 * - logical width ≥ 900 → left vertical navigation + list/detail two-pane
 * - narrower, or text scaling that no longer fits → bottom 4 tabs + single
 *   column
 *
 * The two-pane arrangement is built from plain views (a common list/detail
 * layout), NOT from `expo-router/unstable-split-view`: that API is iOS-only
 * alpha in SDK 57 and must not be used inside tabs.
 *
 * The width/font-scale decision and the shared selection state are lifted
 * into context, so flipping the mode re-renders the same state — the selected
 * peer and the composer draft survive the switch (どちらの状態でも同じ
 * 選択・下書きを描画する).
 */

export type LayoutMode = 'split' | 'single';

/** Logical width (inclusive) at which the two-pane layout engages. */
export const SPLIT_MIN_LOGICAL_WIDTH = 900;

/**
 * Text scaling above this factor makes the two panes too narrow to read, so
 * the layout falls back to the bottom tabs + single column even on a wide
 * screen (文字拡大で収まらない場合は1列へ戻す).
 */
export const SPLIT_MAX_FONT_SCALE = 1.3;

export function resolveLayoutMode(width: number, fontScale: number): LayoutMode {
  if (width < SPLIT_MIN_LOGICAL_WIDTH) return 'single';
  if (fontScale > SPLIT_MAX_FONT_SCALE) return 'single';
  return 'split';
}

/** Test/emergency override for window metrics. */
export interface LayoutMetricsInput {
  width?: number;
  fontScale?: number;
}

export interface LayoutMetrics {
  width: number;
  fontScale: number;
  mode: LayoutMode;
}

/** Current window metrics (logical pixels) + resolved mode. */
export function useLayoutMetrics(override?: LayoutMetricsInput): LayoutMetrics {
  const dimensions = useWindowDimensions();
  const width = override?.width ?? dimensions.width;
  const fontScale = override?.fontScale ?? dimensions.fontScale;
  return useMemo(
    () => ({ width, fontScale, mode: resolveLayoutMode(width, fontScale) }),
    [width, fontScale],
  );
}

// ---------------------------------------------------------------------------
// Shared selection + draft state (lifted above the mode switch)
// ---------------------------------------------------------------------------

export interface AdaptiveLayoutState {
  /** Currently selected peer for the detail pane; null = list only. */
  selectedPeerId: string | null;
  selectPeer: (peerId: string | null) => void;
  /** Composer/input draft kept across the split/single switch. */
  draft: string;
  setDraft: (text: string) => void;
}

const AdaptiveLayoutContext = createContext<AdaptiveLayoutState | null>(null);

export function useAdaptiveLayoutState(): AdaptiveLayoutState {
  const value = useContext(AdaptiveLayoutContext);
  if (value === null) {
    throw new Error('useAdaptiveLayoutState must be used inside <AdaptiveLayoutProvider>.');
  }
  return value;
}

export interface AdaptiveLayoutProviderProps {
  children: React.ReactNode;
  initialSelectedPeerId?: string | null;
  initialDraft?: string;
}

/**
 * Owns the selection + draft. Mount it ONCE above the adaptive layout (per
 * tab/area) so switching between split and single never remounts it.
 */
export function AdaptiveLayoutProvider({
  children,
  initialSelectedPeerId = null,
  initialDraft = '',
}: AdaptiveLayoutProviderProps) {
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(initialSelectedPeerId);
  const [draft, setDraft] = useState(initialDraft);

  const value = useMemo<AdaptiveLayoutState>(
    () => ({
      selectedPeerId,
      selectPeer: setSelectedPeerId,
      draft,
      setDraft,
    }),
    [selectedPeerId, draft],
  );

  return (
    <AdaptiveLayoutContext.Provider value={value}>{children}</AdaptiveLayoutContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// AdaptiveLayout: same state, two renderings
// ---------------------------------------------------------------------------

export interface AdaptiveLayoutProps {
  /** List pane content (peers, results…). */
  list: React.ReactNode;
  /** Detail pane content; receives nothing — read the shared state itself. */
  detail: React.ReactNode;
  /** Shown in the detail slot in split mode when nothing is selected. */
  emptyDetail?: React.ReactNode;
  /** Optional left rail rendered only in split mode (e.g. {@link LeftNav}). */
  nav?: React.ReactNode;
  /** Width of the list pane in split mode. */
  listPaneWidth?: number;
  metrics?: LayoutMetricsInput;
  testID?: string;
}

export function AdaptiveLayout({
  list,
  detail,
  emptyDetail = null,
  nav = null,
  listPaneWidth = 340,
  metrics,
  testID = 'adaptive-layout',
}: AdaptiveLayoutProps) {
  const { tokens } = useTheme();
  const scope = useAppearanceScope();
  const { mode } = useLayoutMetrics(metrics);
  const { selectedPeerId } = useAdaptiveLayoutState();
  // The authenticated frame already owns the visual; panes keep the same
  // opaque body surface so token text stays readable. No decoration is
  // painted here and no layout/measurement changes.
  const paneSurface = scope?.visual?.bodySurface ?? tokens.surface;
  const paneLine = scope?.visual?.border ?? tokens.line;

  if (mode === 'split') {
    return (
      <View
        style={[styles.row, { backgroundColor: paneSurface }]}
        testID={testID}
        accessibilityLabel="一覧と詳細の2列表示"
      >
        {nav}
        <View
          style={[
            styles.listPane,
            { width: listPaneWidth, borderColor: paneLine, backgroundColor: paneSurface },
          ]}
          testID={`${testID}-list`}
        >
          {list}
        </View>
        <View
          style={[styles.detailPane, { backgroundColor: paneSurface }]}
          testID={`${testID}-detail`}
        >
          {selectedPeerId === null ? emptyDetail : detail}
        </View>
      </View>
    );
  }

  // Single column: one pane at a time; the shared selection decides which.
  return (
    <View
      style={[styles.column, { backgroundColor: paneSurface }]}
      testID={testID}
      accessibilityLabel="1列表示"
    >
      {selectedPeerId === null ? (
        <View style={styles.flex} testID={`${testID}-list`}>
          {list}
        </View>
      ) : (
        <View style={styles.flex} testID={`${testID}-detail`}>
          {detail}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Left vertical navigation (split mode)
// ---------------------------------------------------------------------------

export interface NavItem {
  href: string;
  label: string;
  testID: string;
}

/** The fixed four: ホーム / チャット / 友達 / マイページ. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/home', label: 'ホーム', testID: 'leftnav-home' },
  { href: '/chat', label: 'チャット', testID: 'leftnav-chat' },
  { href: '/friends', label: '友達', testID: 'leftnav-friends' },
  { href: '/mypage', label: 'マイページ', testID: 'leftnav-mypage' },
];

export interface LeftNavProps {
  metrics?: LayoutMetricsInput;
  testID?: string;
}

/**
 * Left vertical navigation shown instead of the bottom tab bar when the
 * window is wide. Same four destinations, same routes — only the container
 * differs, so the switch never changes which screen is open.
 */
export function LeftNav({ metrics, testID = 'left-nav' }: LeftNavProps) {
  const unread = useChatUnreadBadge();
  const { tokens } = useTheme();
  const scope = useAppearanceScope();
  const visual = scope?.role === 'personal' ? scope.visual : null;
  const navBackground = visual?.secondary ?? tokens.board;
  const navLine = visual?.border ?? tokens.boardLine;
  // The rail is part of the authenticated personal frame. These inks are
  // guaranteed readable on the visual secondary surface; without a scope the
  // approved board tokens are unchanged.
  const navInk = visual?.text ?? tokens.boardText;
  const navMuted = visual?.mutedText ?? tokens.boardMuted;
  const activeBackground = visual?.bodySurface ?? tokens.accentSoft;
  const activeBorder = visual?.accent ?? tokens.accent;
  const insets = useScreenInsets();
  const pathname = usePathname();
  const { mode } = useLayoutMetrics(metrics);
  // Defensive: the rail belongs to the wide layout only.
  if (mode === 'single') return null;

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="メインナビゲーション"
      style={[
        styles.nav,
        { backgroundColor: navBackground, borderRightColor: navLine, paddingTop: insets.top + spacing.s4 },
      ]}
      testID={testID}
    >
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href as never}
            testID={item.testID}
            accessible
            accessibilityRole="tab"
            accessibilityLabel={item.href === '/chat' ? unread.label : item.label}
            accessibilityState={{ selected: active }}
            style={[
              styles.navItem,
              {
                backgroundColor: active ? activeBackground : 'transparent',
                borderColor: active ? activeBorder : 'transparent',
              },
            ]}
          >
            <Text
              style={[
                styles.navLabel,
                { color: active ? navInk : navMuted },
                active && styles.navLabelActive,
              ]}
              allowFontScaling
            >
              {/* Shape marker so the active item is not colour-only. */}
              {active ? '▸ ' : '  '}
              {item.label}
              {item.href === '/chat' && unread.badge !== undefined ? ` (${unread.badge})` : ''}
            </Text>
          </Link>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: 'row',
  },
  column: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  listPane: {
    borderRightWidth: StyleSheet.hairlineWidth,
    flexGrow: 0,
    flexShrink: 1,
  },
  detailPane: {
    flex: 1,
  },
  nav: {
    width: 200,
    borderRightWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.s2,
    paddingBottom: spacing.s4,
    gap: spacing.s1,
  },
  navItem: {
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.s3,
  },
  navLabel: {
    fontSize: typography.sizes.body,
    lineHeight: typography.sizes.body * typography.lineHeightRatio,
  },
  navLabelActive: {
    fontWeight: typography.weights.bold,
  },
});
