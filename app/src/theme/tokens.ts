import { Platform } from 'react-native';

/**
 * Semantic tokens extracted from the approved monochrome prototype
 * (承認済み試作A: docs/sdd/spikes/2026-09-14-friends-ui.html, variant `mono`).
 *
 * The spike's CSS custom properties are copied verbatim into two token sets —
 * one per scheme — and everything else (spacing, radius, focus ring, type
 * scale) is shared. The spike's `.blue` variant is NOT the approved baseline,
 * so no value from it appears here.
 *
 * Naming follows the spike's own vocabulary:
 * - `board*`  … the desktop comparison board around the phone (`:root`)
 * - the remaining keys … the in-phone screen (`.phone`)
 *
 * Font family: the spike specifies
 * `-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif`.
 * React Native renders with the platform system font on both platforms (SF on
 * iOS, Roboto + Noto CJK on Android), which is the same stack the spike
 * relies on for Japanese text, so no custom font is loaded — only sizes,
 * weights and the 1.5 line height are carried over as tokens.
 */

export type ThemeScheme = 'light' | 'dark';

export interface ThemeTokens {
  scheme: ThemeScheme;

  // --- board (spike `:root`) --------------------------------------------
  board: string;
  boardText: string;
  boardMuted: string;
  boardLine: string;
  boardControl: string;

  // --- phone screen (spike `.phone`) -------------------------------------
  surface: string;
  text: string;
  muted: string;
  line: string;
  soft: string;
  accent: string;
  onAccent: string;
  accentSoft: string;
  avatar: string;
  avatarInk: string;

  /**
   * Error ink. The only value not present in the spike: the app already uses
   * `#b00020` for errors (registration screen, Task 3), and dark mode needs a
   * light-on-dark counterpart to stay readable. Kept desaturated so the UI
   * remains effectively monochrome; error state is never signalled by this
   * colour alone (badge text + message carry it too).
   */
  danger: string;
}

export const lightTokens: ThemeTokens = {
  scheme: 'light',

  board: '#efefec',
  boardText: '#25272b',
  boardMuted: '#5d6168',
  boardLine: '#c6c8ca',
  boardControl: '#fff',

  surface: '#ffffff',
  text: '#272a2e',
  muted: '#62666d',
  line: '#e5e6e8',
  soft: '#f3f4f5',
  accent: '#30343a',
  onAccent: '#ffffff',
  accentSoft: '#e9ebee',
  avatar: '#e8e9e7',
  avatarInk: '#5c6260',

  danger: '#b00020',
};

export const darkTokens: ThemeTokens = {
  scheme: 'dark',

  board: '#15171a',
  boardText: '#f0f1f3',
  boardMuted: '#b1b5be',
  boardLine: '#515660',
  boardControl: '#272b31',

  surface: '#202225',
  text: '#f0f1f3',
  muted: '#b3b7c0',
  line: '#3c4047',
  soft: '#2b2e33',
  accent: '#e1e4e9',
  onAccent: '#262a30',
  accentSoft: '#383c43',
  avatar: '#383e3c',
  avatarInk: '#c5cfca',

  danger: '#ff9b93',
};

/** Tokens for a resolved scheme. */
export function tokensFor(scheme: ThemeScheme): ThemeTokens {
  return scheme === 'dark' ? darkTokens : lightTokens;
}

/** Spacing scale (spike `--s1` … `--s7`). */
export const spacing = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 24,
  s6: 32,
  s7: 48,
} as const;

/** Corner radii observed in the spike (inputs/tabs 8, rows 10, picker 12). */
export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
} as const;

/** Focus ring (`button:focus-visible` in the spike). */
export const focusRing = {
  color: '#5b88c3',
  width: 3,
  offset: 4,
} as const;

/** Type scale derived from the spike's font sizes (line-height 1.5). */
export const typography = {
  lineHeightRatio: 1.5,
  sizes: {
    tab: 10,
    caption: 12,
    small: 13,
    body: 14,
    control: 15,
    bodyLarge: 16,
    title: 20,
    heading: 22,
    h1: 30,
  },
  weights: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
} as const;

/** Control metrics (44pt touch target, 48pt actions, row heights). */
export const controls = {
  minTouchTarget: 44,
  buttonMinHeight: 48,
  actionMinHeight: 48,
  requestRowMinHeight: 56,
  friendRowMinHeight: 72,
} as const;

/**
 * Platform font family. `undefined` means "system default" — RN resolves the
 * same stack the spike specifies (SF/Hiragino on iOS, Roboto/Noto on
 * Android), so this is exported for explicitness rather than loaded.
 */
export const fontFamily = Platform.select({
  ios: undefined,
  android: undefined,
  default: undefined,
});
