import { tokensFor, type ThemeScheme } from '../theme/tokens';
import {
  APPEARANCE_PRESETS,
  presetFor,
  stageForDays,
  stickersFor,
  type AppearancePresetId,
  type AppearancePatternId,
  type AppearanceScheme,
  type AppearanceStage,
  type AppearanceSticker,
  type AppearanceVibrancy,
} from './catalog';

export interface AppearanceIntensity {
  color: number;
  pattern: number;
  glow: number;
  extra: number;
  motion: number;
}

export interface AppearanceDecoration {
  /** null only when no pattern is shown (initial stage or vibrancy off). */
  patternId: AppearancePatternId | null;
  patternOpacity: number;
  staticStickers: readonly AppearanceSticker[];
  /** Flashy uses at most two slowly moving background layers. */
  animatedLayers: number;
  glowOpacity: number;
  extraOpacity: number;
  /** Motion strength exposed so callers can stop it (for example for the OS
   * reduced-motion setting, which is not part of this pure calculation). */
  motion: number;
}

export interface AppearanceContrast {
  textOnSurface: number;
  mutedOnSurface: number;
  borderOnSurface: number;
}

export interface AppearanceVisual {
  stage: AppearanceStage;
  presetId: AppearancePresetId;
  scheme: ThemeScheme;
  vibrancy: AppearanceVibrancy;
  intensity: AppearanceIntensity;
  background: string;
  secondary: string;
  /** Opaque surface used under normal text. Moving/translucent decoration is
   * never composited directly beneath body copy. */
  bodySurface: string;
  text: string;
  mutedText: string;
  border: string;
  accent: string;
  bubbleIn: string;
  bubbleOut: string;
  decoration: AppearanceDecoration;
  complete: boolean;
  monochrome: boolean;
  contrast: AppearanceContrast;
}

export interface CalculateAppearanceInput {
  subject: 'chat' | 'streak';
  days: number;
  presetId: AppearancePresetId;
  scheme: AppearanceScheme;
  vibrancy: AppearanceVibrancy;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface NeutralPalette {
  background: string;
  secondary: string;
  bodySurface: string;
  accent: string;
  pattern: string;
  patternSecondary: string;
  sticker: string;
  text: string;
  muted: string;
}

function parseHex(color: string): Rgb {
  const value = color.startsWith('#') ? color.slice(1) : color;
  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`Expected an opaque six-digit hex color, received ${color}`);
  }
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function channelHex(channel: number): string {
  return Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0');
}

function toHex({ r, g, b }: Rgb): string {
  return `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`;
}

/** Linear interpolate two opaque hex colours in sRGB. Endpoints are preserved
 * exactly so the approved 100-day anchors survive a full-strength blend. */
function mixHex(start: string, end: string, amount: number): string {
  if (!(amount > 0)) return start;
  if (amount >= 1) return end;
  const from = parseHex(start);
  const to = parseHex(end);
  return toHex({
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  });
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const { r, g, b } = parseHex(color);
  return linearChannel(r) * 0.2126 + linearChannel(g) * 0.7152 + linearChannel(b) * 0.0722;
}

/** WCAG 2 contrast ratio between two opaque hex colours. */
export function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const BLACK = '#000000';
const WHITE = '#ffffff';

function minimumContrast(color: string, surfaces: readonly string[]): number {
  return Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));
}

/** Return a colour that reaches `minimum` on every surface. The preferred
 * palette ink is used untouched when it already passes, otherwise it is mixed
 * toward black or white until it passes. All results stay opaque hex. */
function readableAcross(surfaces: readonly string[], preferred: string, minimum: number): string {
  if (minimumContrast(preferred, surfaces) >= minimum) return preferred;
  const black = minimumContrast(BLACK, surfaces);
  const white = minimumContrast(WHITE, surfaces);
  const endpoint = black >= white ? BLACK : WHITE;
  // One endpoint is guaranteed for the near-white/near-black scheme surfaces
  // used by the catalog. Fall back to the better endpoint if a caller supplies
  // an unusual mid-tone surface.
  if (Math.max(black, white) < minimum) return endpoint;
  let lower = 0;
  let upper = 1;
  for (let step = 0; step < 24; step += 1) {
    const middle = (lower + upper) / 2;
    if (minimumContrast(mixHex(preferred, endpoint, middle), surfaces) >= minimum) {
      upper = middle;
    } else {
      lower = middle;
    }
  }
  return mixHex(preferred, endpoint, upper);
}

function readableOn(surface: string, preferred: string, minimum: number): string {
  return readableAcross([surface], preferred, minimum);
}

/** Nudge a bubble surface away from its ink until the ink is readable. */
function readableSurface(surface: string, ink: string, minimum: number): string {
  if (contrastRatio(ink, surface) >= minimum) return surface;
  const endpoint = luminance(ink) >= 0.5 ? BLACK : WHITE;
  let lower = 0;
  let upper = 1;
  for (let step = 0; step < 24; step += 1) {
    const middle = (lower + upper) / 2;
    if (contrastRatio(ink, mixHex(surface, endpoint, middle)) >= minimum) {
      upper = middle;
    } else {
      lower = middle;
    }
  }
  return mixHex(surface, endpoint, upper);
}

function neutralPalette(scheme: ThemeScheme): NeutralPalette {
  const tokens = tokensFor(scheme);
  return {
    background: tokens.surface,
    secondary: tokens.soft,
    bodySurface: tokens.surface,
    accent: tokens.accent,
    pattern: tokens.muted,
    patternSecondary: tokens.line,
    sticker: tokens.muted,
    text: tokens.text,
    muted: tokens.muted,
  };
}

function intensityFor(stage: AppearanceStage): AppearanceIntensity {
  const x = stage / 100;
  return {
    color: x ** 0.72,
    pattern: x ** 1.15,
    glow: x ** 1.5,
    extra: x ** 1.7,
    motion: x ** 1.2,
  };
}

function emptyDecoration(): AppearanceDecoration {
  return {
    patternId: null,
    patternOpacity: 0,
    staticStickers: [],
    animatedLayers: 0,
    glowOpacity: 0,
    extraOpacity: 0,
    motion: 0,
  };
}

function decorationFor(
  presetId: AppearancePresetId,
  stage: AppearanceStage,
  vibrancy: AppearanceVibrancy,
  intensity: AppearanceIntensity,
): AppearanceDecoration {
  if (stage === 0 || vibrancy === 'off') return emptyDecoration();
  const subtle = vibrancy === 'subtle';
  const stickers = stickersFor(presetId, stage);
  return {
    patternId: presetFor(presetId).patternId,
    patternOpacity: intensity.pattern,
    staticStickers: subtle ? stickers.slice(0, 2) : stickers,
    animatedLayers: vibrancy === 'flashy' ? (stage >= 60 ? 2 : 1) : 0,
    glowOpacity: intensity.glow,
    extraOpacity: subtle ? intensity.extra * 0.35 : intensity.extra,
    motion: vibrancy === 'flashy' ? intensity.motion : 0,
  };
}

function monochromeVisual(
  input: CalculateAppearanceInput,
  stage: AppearanceStage,
  intensity: AppearanceIntensity,
): AppearanceVisual {
  const tokens = tokensFor(input.scheme);
  const bodySurface = tokens.surface;
  const text = tokens.text;
  const mutedText = tokens.muted;
  const border = readableOn(bodySurface, mutedText, 3);
  const accent = readableOn(bodySurface, tokens.accent, 3);
  return {
    stage,
    presetId: input.presetId,
    scheme: input.scheme,
    vibrancy: input.vibrancy,
    intensity,
    background: tokens.surface,
    secondary: tokens.soft,
    bodySurface,
    text,
    mutedText,
    border,
    accent,
    bubbleIn: bodySurface,
    bubbleOut: tokens.soft,
    decoration: emptyDecoration(),
    complete: stage === 100,
    monochrome: true,
    contrast: {
      textOnSurface: contrastRatio(text, bodySurface),
      mutedOnSurface: contrastRatio(mutedText, bodySurface),
      borderOnSurface: contrastRatio(border, bodySurface),
    },
  };
}

/**
 * Pure display calculation. Decoration, pattern and stickers come from the
 * resolved stage, preset, scheme and vibrancy only; the raw day count is used
 * solely by `stageForDays`.
 */
export function calculateAppearance(input: CalculateAppearanceInput): AppearanceVisual {
  const stage = stageForDays(input.days);
  const intensity = intensityFor(stage);
  const neutral = neutralPalette(input.scheme);

  if (stage === 0 || input.vibrancy === 'off') {
    return monochromeVisual(input, stage, intensity);
  }

  const end = APPEARANCE_PRESETS[input.presetId].palettes[input.scheme];
  const background = mixHex(neutral.background, end.background, intensity.color);
  const secondary = mixHex(neutral.secondary, end.secondary, intensity.color);
  const bodySurface = mixHex(neutral.bodySurface, end.bodySurface, intensity.color);
  const accentPreferred = mixHex(neutral.accent, end.accent, intensity.color);

  const text = readableAcross(
    [background, secondary, bodySurface],
    mixHex(neutral.text, end.accent, intensity.color),
    4.5,
  );
  const mutedText = readableAcross(
    [background, secondary, bodySurface],
    mixHex(text, bodySurface, 0.32),
    4.5,
  );
  const accent = readableOn(bodySurface, accentPreferred, 3);
  const border = readableOn(bodySurface, mixHex(accent, bodySurface, 0.45), 3);
  const bubbleOut = readableSurface(mixHex(secondary, background, 0.25), text, 4.5);

  return {
    stage,
    presetId: input.presetId,
    scheme: input.scheme,
    vibrancy: input.vibrancy,
    intensity,
    background,
    secondary,
    bodySurface,
    text,
    mutedText,
    border,
    accent,
    bubbleIn: bodySurface,
    bubbleOut,
    decoration: decorationFor(input.presetId, stage, input.vibrancy, intensity),
    complete: stage === 100,
    monochrome: false,
    contrast: {
      textOnSurface: contrastRatio(text, bodySurface),
      mutedOnSurface: contrastRatio(mutedText, bodySurface),
      borderOnSurface: contrastRatio(border, bodySurface),
    },
  };
}
