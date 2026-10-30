import { APPEARANCE_PRESET_IDS, type AppearancePresetId } from './contracts';

export { APPEARANCE_PRESET_IDS } from './contracts';
export type { AppearancePresetId } from './contracts';

/**
 * Shared growth milestones for chat growth and personal streak appearance.
 * A display stage is the highest milestone the confirmed day count has
 * reached, or 0 when none has been reached. Stages are never interpolated
 * from raw days: 3 and 6 are both the 1-day stage.
 */
export const APPEARANCE_MILESTONES = [1, 7, 30, 60, 100] as const;
export type AppearanceMilestone = (typeof APPEARANCE_MILESTONES)[number];
export type AppearanceStage = 0 | AppearanceMilestone;
export const APPEARANCE_STAGES: readonly AppearanceStage[] = [0, ...APPEARANCE_MILESTONES];

export type AppearanceScheme = 'light' | 'dark';
export type AppearanceVibrancy = 'flashy' | 'subtle' | 'off';
export type AppearancePatternId = 'pop-dots' | 'candy-stripes' | 'soda-bubbles';
export type AppearanceStickerMotif = 'spark' | 'star' | 'dot' | 'heart' | 'swirl' | 'bubble' | 'ring';

/** 100-day anchor palette. Intermediate stages blend from the neutral
 * scheme surface toward these values; they never come from raw day counts. */
export interface AppearancePresetPalette {
  background: string;
  secondary: string;
  bodySurface: string;
  accent: string;
  pattern: string;
  patternSecondary: string;
  sticker: string;
}

export interface AppearancePreset {
  readonly id: AppearancePresetId;
  /** Japanese display name shown in the preset picker. */
  readonly name: string;
  readonly patternId: AppearancePatternId;
  readonly palettes: Readonly<Record<AppearanceScheme, AppearancePresetPalette>>;
}

export interface AppearanceSticker {
  readonly id: string;
  readonly motif: AppearanceStickerMotif;
  /** Normalised position in the decorated surface (0..1). */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly rotation: number;
}

/**
 * Catalog v1. All three presets are B's flashy growth variants: same growth
 * amount, same stage intensity, different colours and patterns. b-pop is the
 * standard personal frame and keeps the approved B 100-day anchors exactly.
 */
export const APPEARANCE_PRESETS: Readonly<Record<AppearancePresetId, AppearancePreset>> = {
  'b-pop': {
    id: 'b-pop',
    name: 'ポップ大騒ぎ',
    patternId: 'pop-dots',
    palettes: {
      light: {
        background: '#ffe784',
        secondary: '#fff4b6',
        bodySurface: '#fff5db',
        accent: '#2c1638',
        pattern: '#c2255c',
        patternSecondary: '#6b36b7',
        sticker: '#ffdb4d',
      },
      dark: {
        background: '#201627',
        secondary: '#2b1b32',
        bodySurface: '#211925',
        accent: '#fff4b6',
        pattern: '#ffe672',
        patternSecondary: '#ff91cf',
        sticker: '#c45aa4',
      },
    },
  },
  'b-candy': {
    id: 'b-candy',
    name: 'キャンディ',
    patternId: 'candy-stripes',
    palettes: {
      light: {
        background: '#ffd6e9',
        secondary: '#ffe9f3',
        bodySurface: '#fff3f8',
        accent: '#6b1f45',
        pattern: '#d63384',
        patternSecondary: '#8a4fbf',
        sticker: '#ffb3d8',
      },
      dark: {
        background: '#2a1220',
        secondary: '#3a1a2c',
        bodySurface: '#24111c',
        accent: '#ffd6e9',
        pattern: '#ff9ecb',
        patternSecondary: '#c9a0ff',
        sticker: '#ffb3d8',
      },
    },
  },
  'b-soda': {
    id: 'b-soda',
    name: 'ソーダ',
    patternId: 'soda-bubbles',
    palettes: {
      light: {
        background: '#d4f1ff',
        secondary: '#e8f9ff',
        bodySurface: '#f1fbff',
        accent: '#123a52',
        pattern: '#1f8fae',
        patternSecondary: '#2fb98a',
        sticker: '#8edcff',
      },
      dark: {
        background: '#0d1c26',
        secondary: '#142b37',
        bodySurface: '#101f29',
        accent: '#d4f1ff',
        pattern: '#79dcff',
        patternSecondary: '#8fffd0',
        sticker: '#8edcff',
      },
    },
  },
};

export const APPEARANCE_PRESET_LIST: readonly AppearancePreset[] =
  APPEARANCE_PRESET_IDS.map((id) => APPEARANCE_PRESETS[id]);

/** Highest milestone reached by a confirmed day count. Non-finite and
 * negative values are the initial monochrome stage; 100 and above are the
 * complete stage. */
export function stageForDays(days: number): AppearanceStage {
  if (!Number.isFinite(days) || days < 1) return 0;
  if (days >= 100) return 100;
  let stage: AppearanceStage = 0;
  for (const milestone of APPEARANCE_MILESTONES) {
    if (days >= milestone) stage = milestone;
  }
  return stage;
}

export function presetFor(presetId: AppearancePresetId): AppearancePreset {
  return APPEARANCE_PRESETS[presetId];
}

/** Fixed positions shared by every preset so presets change colour/pattern,
 * not growth or decoration amount. The list for a stage never depends on the
 * current day or on randomness. */
const STICKER_LAYOUT = [
  { x: 0.14, y: 0.18, size: 26, rotation: -12 },
  { x: 0.82, y: 0.12, size: 20, rotation: 18 },
  { x: 0.89, y: 0.62, size: 30, rotation: -8 },
  { x: 0.08, y: 0.78, size: 22, rotation: 24 },
  { x: 0.58, y: 0.88, size: 18, rotation: -20 },
] as const;

const STICKER_COUNT: Readonly<Record<AppearanceStage, number>> = {
  0: 0,
  1: 1,
  7: 2,
  30: 3,
  60: 4,
  100: 5,
};

const STICKER_MOTIFS: Readonly<Record<AppearancePresetId, readonly AppearanceStickerMotif[]>> = {
  'b-pop': ['spark', 'star', 'dot', 'spark', 'star'],
  'b-candy': ['heart', 'swirl', 'dot', 'heart', 'swirl'],
  'b-soda': ['bubble', 'ring', 'spark', 'bubble', 'ring'],
};

/** Deterministic static stickers for one preset and display stage. */
export function stickersFor(presetId: AppearancePresetId, stage: AppearanceStage): readonly AppearanceSticker[] {
  const count = STICKER_COUNT[stage];
  const motifs = STICKER_MOTIFS[presetId];
  return Array.from({ length: count }, (_, index) => ({
    id: `${presetId}-${stage}-${index}`,
    motif: motifs[index % motifs.length],
    ...STICKER_LAYOUT[index],
  }));
}
