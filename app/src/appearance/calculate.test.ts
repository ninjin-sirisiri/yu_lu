import { darkTokens, lightTokens, tokensFor } from '../theme/tokens';
import {
  APPEARANCE_MILESTONES,
  APPEARANCE_PRESET_IDS,
  APPEARANCE_PRESETS,
  stageForDays,
  type AppearancePresetId,
} from './catalog';
import {
  calculateAppearance,
  contrastRatio,
  type AppearanceVisual,
} from './calculate';

const PRESETS = APPEARANCE_PRESET_IDS;
const SCHEMES = ['light', 'dark'] as const;
const VIBRANCIES = ['flashy', 'subtle', 'off'] as const;
const DAYS = [...Array.from({ length: 101 }, (_, day) => day), 101];
const STAGES = [0, ...APPEARANCE_MILESTONES] as const;
const OPAQUE_HEX = /^#[0-9a-f]{6}$/;
const TRANSITIONS = new Set(['0->1', '6->7', '29->30', '59->60', '99->100']);
const STAGE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [1, 6],
  [7, 29],
  [30, 59],
  [60, 99],
  [100, 101],
];

const cache = new Map<string, AppearanceVisual>();
function visual(
  days: number,
  presetId: AppearancePresetId,
  scheme: (typeof SCHEMES)[number],
  vibrancy: (typeof VIBRANCIES)[number],
): AppearanceVisual {
  const key = `${days}|${presetId}|${scheme}|${vibrancy}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const value = calculateAppearance({ subject: 'chat', days, presetId, scheme, vibrancy });
  cache.set(key, value);
  return value;
}

function eachCombination(run: (
  presetId: AppearancePresetId,
  scheme: (typeof SCHEMES)[number],
  vibrancy: (typeof VIBRANCIES)[number],
) => void): void {
  for (const presetId of PRESETS) {
    for (const scheme of SCHEMES) {
      for (const vibrancy of VIBRANCIES) {
        run(presetId, scheme, vibrancy);
      }
    }
  }
}

it('maps raw days to the shared milestone stages only', () => {
  expect(stageForDays(0)).toBe(0);
  expect(stageForDays(1)).toBe(1);
  expect(stageForDays(6)).toBe(1);
  expect(stageForDays(7)).toBe(7);
  expect(stageForDays(29)).toBe(7);
  expect(stageForDays(30)).toBe(30);
  expect(stageForDays(59)).toBe(30);
  expect(stageForDays(60)).toBe(60);
  expect(stageForDays(99)).toBe(60);
  expect(stageForDays(100)).toBe(100);
  expect(stageForDays(101)).toBe(100);
  expect(stageForDays(9999)).toBe(100);
  for (const invalid of [-1, -0.5, NaN, Infinity, -Infinity]) {
    expect(stageForDays(invalid)).toBe(0);
  }
});

it('changes a visual only at 0-1, 6-7, 29-30, 59-60 and 99-100', () => {
  eachCombination((presetId, scheme, vibrancy) => {
    for (let day = 0; day < 101; day += 1) {
      const before = visual(day, presetId, scheme, vibrancy);
      const after = visual(day + 1, presetId, scheme, vibrancy);
      if (TRANSITIONS.has(`${day}->${day + 1}`)) {
        expect(after).not.toEqual(before);
      } else {
        expect(after).toEqual(before);
      }
    }
  });
});

it('keeps decoration, pattern, stickers and palette intensities fixed inside a stage', () => {
  eachCombination((presetId, scheme, vibrancy) => {
    for (const [first, last] of STAGE_RANGES) {
      const expected = visual(first, presetId, scheme, vibrancy);
      for (let day = first + 1; day <= last; day += 1) {
        expect(visual(day, presetId, scheme, vibrancy)).toEqual(expected);
      }
    }
  });
});

it('uses the exact exponent formulas from the displayed stage, never raw days', () => {
  for (const stage of STAGES) {
    const x = stage / 100;
    for (const presetId of PRESETS) {
      for (const scheme of SCHEMES) {
        for (const vibrancy of VIBRANCIES) {
          const day = stage === 0 ? 0 : stage;
          const { intensity } = visual(day, presetId, scheme, vibrancy);
          expect(intensity.color).toBeCloseTo(x ** 0.72, 12);
          expect(intensity.pattern).toBeCloseTo(x ** 1.15, 12);
          expect(intensity.glow).toBeCloseTo(x ** 1.5, 12);
          expect(intensity.extra).toBeCloseTo(x ** 1.7, 12);
          expect(intensity.motion).toBeCloseTo(x ** 1.2, 12);
        }
      }
    }
  }
});

it('renders zero days as scheme monochrome with no decoration', () => {
  eachCombination((presetId, scheme, vibrancy) => {
    const zero = visual(0, presetId, scheme, vibrancy);
    const tokens = tokensFor(scheme);
    expect(zero.stage).toBe(0);
    expect(zero.complete).toBe(false);
    expect(zero.monochrome).toBe(true);
    expect(zero.intensity).toEqual({ color: 0, pattern: 0, glow: 0, extra: 0, motion: 0 });
    expect(zero.background).toBe(tokens.surface);
    expect(zero.secondary).toBe(tokens.soft);
    expect(zero.bodySurface).toBe(tokens.surface);
    expect(zero.decoration.patternId).toBeNull();
    expect(zero.decoration.patternOpacity).toBe(0);
    expect(zero.decoration.staticStickers).toEqual([]);
    expect(zero.decoration.animatedLayers).toBe(0);
    expect(zero.decoration.glowOpacity).toBe(0);
    expect(zero.decoration.extraOpacity).toBe(0);
    expect(zero.decoration.motion).toBe(0);
  });
});

it('does not make the first day look complete', () => {
  eachCombination((presetId, scheme, vibrancy) => {
    const first = visual(1, presetId, scheme, vibrancy);
    const complete = visual(100, presetId, scheme, vibrancy);
    expect(first.stage).toBe(1);
    expect(first.complete).toBe(false);
    expect(first.intensity.color).toBeLessThan(complete.intensity.color);
    if (vibrancy !== 'off') {
      expect(first.decoration).not.toEqual(complete.decoration);
      expect(first.bodySurface).not.toBe(complete.bodySurface);
    }
  });
});

it('keeps the complete 100-day look for 100 and every later day', () => {
  eachCombination((presetId, scheme, vibrancy) => {
    const hundred = visual(100, presetId, scheme, vibrancy);
    for (const day of [101, 1000]) {
      const later = visual(day, presetId, scheme, vibrancy);
      expect(later).toEqual(hundred);
      expect(later.complete).toBe(true);
      expect(later.stage).toBe(100);
    }
    expect(hundred.intensity).toEqual({ color: 1, pattern: 1, glow: 1, extra: 1, motion: 1 });
  });
});

it('returns the same value for the same resolved inputs', () => {
  for (const day of DAYS) {
    for (const presetId of PRESETS) {
      for (const scheme of SCHEMES) {
        for (const vibrancy of VIBRANCIES) {
          expect(calculateAppearance({ subject: 'chat', days: day, presetId, scheme, vibrancy }))
            .toEqual(calculateAppearance({ subject: 'streak', days: day, presetId, scheme, vibrancy }));
        }
      }
    }
  }
});

it('separates light and dark palettes at every stage', () => {
  for (const day of DAYS) {
    for (const presetId of PRESETS) {
      for (const vibrancy of VIBRANCIES) {
        const light = visual(day, presetId, 'light', vibrancy);
        const dark = visual(day, presetId, 'dark', vibrancy);
        expect(light.background).not.toBe(dark.background);
        expect(light.bodySurface).not.toBe(dark.bodySurface);
        expect(light.text).not.toBe(dark.text);
        expect(light.contrast).not.toEqual(dark.contrast);
      }
    }
  }
});

it('keeps pop, candy and soda at the same growth with only color and pattern changes', () => {
  for (const day of DAYS) {
    for (const scheme of SCHEMES) {
      for (const vibrancy of VIBRANCIES) {
        const pop = visual(day, 'b-pop', scheme, vibrancy);
        for (const presetId of ['b-candy', 'b-soda'] as const) {
          const other = visual(day, presetId, scheme, vibrancy);
          expect(other.stage).toBe(pop.stage);
          expect(other.intensity).toEqual(pop.intensity);
          expect(other.complete).toBe(pop.complete);
          expect(other.monochrome).toBe(pop.monochrome);
          expect(other.decoration.animatedLayers).toBe(pop.decoration.animatedLayers);
          expect(other.decoration.patternOpacity).toBe(pop.decoration.patternOpacity);
          expect(other.decoration.glowOpacity).toBe(pop.decoration.glowOpacity);
          expect(other.decoration.extraOpacity).toBe(pop.decoration.extraOpacity);
          expect(other.decoration.motion).toBe(pop.decoration.motion);
          expect(other.decoration.staticStickers).toHaveLength(pop.decoration.staticStickers.length);
          expect(other.decoration.staticStickers.map(({ id: _id, motif: _motif, ...geometry }) => geometry))
            .toEqual(pop.decoration.staticStickers.map(({ id: _id, motif: _motif, ...geometry }) => geometry));
          if (pop.stage > 0 && vibrancy !== 'off') {
            expect(other.decoration.patternId).not.toBe(pop.decoration.patternId);
            expect(other.background).not.toBe(pop.background);
          }
        }
      }
    }
  }
});

it('preserves the B 100-day anchor family for b-pop', () => {
  for (const vibrancy of ['flashy', 'subtle'] as const) {
    const light = calculateAppearance({ subject: 'chat', days: 100, presetId: 'b-pop', scheme: 'light', vibrancy });
    expect(light.background).toBe('#ffe784');
    expect(light.secondary).toBe('#fff4b6');
    expect(light.bodySurface).toBe('#fff5db');
    const dark = calculateAppearance({ subject: 'chat', days: 100, presetId: 'b-pop', scheme: 'dark', vibrancy });
    expect(dark.background).toBe('#201627');
    expect(dark.secondary).toBe('#2b1b32');
    expect(dark.bodySurface).toBe('#211925');
  }
  expect(APPEARANCE_PRESETS['b-pop'].palettes.light.background).toBe('#ffe784');
  expect(APPEARANCE_PRESETS['b-pop'].palettes.dark.bodySurface).toBe('#211925');
  expect(APPEARANCE_PRESETS['b-pop'].name).toBe('ポップ大騒ぎ');
  expect(APPEARANCE_PRESETS['b-candy'].name).toBe('キャンディ');
  expect(APPEARANCE_PRESETS['b-soda'].name).toBe('ソーダ');
});

it('keeps every text, muted text and meaningful line readable', () => {
  expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
  expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 12);
  for (const day of DAYS) {
    for (const presetId of PRESETS) {
      for (const scheme of SCHEMES) {
        for (const vibrancy of VIBRANCIES) {
          const value = visual(day, presetId, scheme, vibrancy);
          expect(value.contrast.textOnSurface).toBeCloseTo(contrastRatio(value.text, value.bodySurface), 12);
          expect(value.contrast.mutedOnSurface).toBeCloseTo(contrastRatio(value.mutedText, value.bodySurface), 12);
          expect(value.contrast.borderOnSurface).toBeCloseTo(contrastRatio(value.border, value.bodySurface), 12);
          expect(value.contrast.textOnSurface).toBeGreaterThanOrEqual(4.5);
          expect(value.contrast.mutedOnSurface).toBeGreaterThanOrEqual(4.5);
          expect(value.contrast.borderOnSurface).toBeGreaterThanOrEqual(3);
          expect(contrastRatio(value.accent, value.bodySurface)).toBeGreaterThanOrEqual(3);
          expect(contrastRatio(value.text, value.secondary)).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(value.text, value.bubbleIn)).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(value.text, value.bubbleOut)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  }
});

it('keeps every computed surface an opaque six-digit hex color', () => {
  const colorKeys = [
    'background', 'secondary', 'bodySurface', 'text', 'mutedText', 'border',
    'accent', 'bubbleIn', 'bubbleOut',
  ] as const;
  for (const day of DAYS) {
    for (const presetId of PRESETS) {
      for (const scheme of SCHEMES) {
        for (const vibrancy of VIBRANCIES) {
          const value = visual(day, presetId, scheme, vibrancy);
          for (const key of colorKeys) {
            expect(value[key]).toMatch(OPAQUE_HEX);
          }
          for (const sticker of value.decoration.staticStickers) {
            expect(sticker.id).toMatch(/^[a-z0-9-]+$/);
          }
        }
      }
    }
  }
});

it('stops motion in subtle and decoration in off without changing growth', () => {
  for (const day of DAYS) {
    for (const presetId of PRESETS) {
      for (const scheme of SCHEMES) {
        const flashy = visual(day, presetId, scheme, 'flashy');
        const subtle = visual(day, presetId, scheme, 'subtle');
        const off = visual(day, presetId, scheme, 'off');
        const tokens = tokensFor(scheme);

        expect(flashy.decoration.animatedLayers).toBeLessThanOrEqual(2);
        expect(flashy.decoration.motion).toBe(flashy.intensity.motion);
        expect(subtle.stage).toBe(flashy.stage);
        expect(subtle.intensity).toEqual(flashy.intensity);
        expect(subtle.bodySurface).toBe(flashy.bodySurface);
        expect(subtle.background).toBe(flashy.background);
        expect(subtle.secondary).toBe(flashy.secondary);
        expect(subtle.decoration.patternOpacity).toBe(flashy.decoration.patternOpacity);
        expect(subtle.decoration.motion).toBe(0);
        expect(subtle.decoration.animatedLayers).toBe(0);
        if (flashy.stage > 0) {
          expect(subtle.decoration.extraOpacity).toBeLessThan(flashy.decoration.extraOpacity);
          expect(subtle.decoration.staticStickers.length).toBeLessThanOrEqual(flashy.decoration.staticStickers.length);
        }

        expect(off.monochrome).toBe(true);
        expect(off.stage).toBe(flashy.stage);
        expect(off.intensity).toEqual(flashy.intensity);
        expect(off.background).toBe(tokens.surface);
        expect(off.secondary).toBe(tokens.soft);
        expect(off.bodySurface).toBe(tokens.surface);
        expect(off.text).toBe(tokens.text);
        expect(off.decoration.patternId).toBeNull();
        expect(off.decoration.patternOpacity).toBe(0);
        expect(off.decoration.staticStickers).toEqual([]);
        expect(off.decoration.animatedLayers).toBe(0);
        expect(off.decoration.glowOpacity).toBe(0);
        expect(off.decoration.extraOpacity).toBe(0);
        expect(off.decoration.motion).toBe(0);
      }
    }
  }
});

it('uses the standard light and dark tokens for the monochrome result', () => {
  for (const day of [0, 1, 100]) {
    const light = calculateAppearance({ subject: 'chat', days: day, presetId: 'b-candy', scheme: 'light', vibrancy: 'off' });
    const dark = calculateAppearance({ subject: 'chat', days: day, presetId: 'b-candy', scheme: 'dark', vibrancy: 'off' });
    expect(light.bodySurface).toBe(lightTokens.surface);
    expect(dark.bodySurface).toBe(darkTokens.surface);
  }
});

it('caps animated background layers at two and never animates zero days', () => {
  for (const presetId of PRESETS) {
    for (const scheme of SCHEMES) {
      expect(visual(0, presetId, scheme, 'flashy').decoration.animatedLayers).toBe(0);
      for (const day of [1, 29, 30, 100, 101]) {
        const value = visual(day, presetId, scheme, 'flashy');
        expect(value.decoration.animatedLayers).toBeGreaterThanOrEqual(0);
        expect(value.decoration.animatedLayers).toBeLessThanOrEqual(2);
      }
    }
  }
});
