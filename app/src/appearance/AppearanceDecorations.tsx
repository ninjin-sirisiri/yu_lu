import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, G, Path } from 'react-native-svg';

import type { AppearanceVisual } from './calculate';
import type { AppearancePatternId, AppearanceSticker, AppearanceStickerMotif } from './catalog';

/**
 * Task 11: static and persistent decoration layer.
 *
 * Pure geometry/colour decisions live in `calculate.ts`; this file only paints
 * the already-computed values. The static SVG pattern and deterministic
 * stickers are plain React elements with stable keys. Reanimated is used for
 * at most two background blobs, and only on a foreground flashy surface where
 * motion is allowed. No React state is updated per frame.
 *
 * The whole tree is absolute-fill and explicitly hidden from assistive
 * technology. It never measures, pads or reserves layout space, so a 100-day
 * appearance cannot take body area from the content above it.
 */

export const APPEARANCE_STATIC_LAYER_TEST_ID = 'appearance-static-layer';
export const APPEARANCE_ANIMATED_LAYER_TEST_ID = 'appearance-animated-layer';
export const APPEARANCE_PATTERN_TEST_ID_SUFFIX = '-pattern';
export const APPEARANCE_STICKER_TEST_ID_PREFIX = 'appearance-sticker-';
export const APPEARANCE_ANIMATED_BLOB_TEST_ID_PREFIX = 'appearance-animated-blob-';

export function appearanceStickerTestID(id: string): string {
  return `${APPEARANCE_STICKER_TEST_ID_PREFIX}${id}`;
}

export interface AppearanceDecorationsProps {
  visual: AppearanceVisual;
  /** True while the surface is foreground/visible. Offscreen surfaces stay
   * static so no decoration keeps animating in the background. */
  active: boolean;
  /** OS reduced-motion setting. Independent of the stored vibrancy setting. */
  reduceMotion?: boolean;
  /** Overrides the static layer test id; useful for several surfaces. */
  testID?: string;
}

interface Dot {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

const POP_DOTS: readonly Dot[] = [
  { cx: 7, cy: 9, r: 1.5 },
  { cx: 24, cy: 5, r: 1.1 },
  { cx: 43, cy: 13, r: 1.8 },
  { cx: 65, cy: 6, r: 1.2 },
  { cx: 84, cy: 12, r: 1.6 },
  { cx: 96, cy: 3, r: 1.1 },
  { cx: 14, cy: 32, r: 1.2 },
  { cx: 34, cy: 27, r: 1.6 },
  { cx: 56, cy: 35, r: 1.1 },
  { cx: 75, cy: 30, r: 1.9 },
  { cx: 93, cy: 38, r: 1.3 },
  { cx: 4, cy: 56, r: 1.7 },
  { cx: 24, cy: 50, r: 1.2 },
  { cx: 47, cy: 60, r: 1.4 },
  { cx: 68, cy: 54, r: 1.1 },
  { cx: 87, cy: 63, r: 1.8 },
  { cx: 13, cy: 79, r: 1.3 },
  { cx: 37, cy: 84, r: 1.7 },
  { cx: 58, cy: 76, r: 1.2 },
  { cx: 79, cy: 88, r: 1.5 },
  { cx: 96, cy: 80, r: 1.1 },
];

const SODA_BUBBLES: readonly Dot[] = [
  { cx: 9, cy: 14, r: 2.4 },
  { cx: 28, cy: 7, r: 1.4 },
  { cx: 48, cy: 18, r: 3.1 },
  { cx: 71, cy: 9, r: 1.8 },
  { cx: 91, cy: 20, r: 2.5 },
  { cx: 17, cy: 38, r: 1.7 },
  { cx: 39, cy: 31, r: 2.2 },
  { cx: 61, cy: 42, r: 1.3 },
  { cx: 83, cy: 34, r: 2.9 },
  { cx: 5, cy: 62, r: 2.1 },
  { cx: 26, cy: 56, r: 1.5 },
  { cx: 52, cy: 66, r: 2.7 },
  { cx: 74, cy: 58, r: 1.9 },
  { cx: 95, cy: 70, r: 1.4 },
  { cx: 14, cy: 86, r: 2.3 },
  { cx: 35, cy: 79, r: 1.6 },
  { cx: 59, cy: 90, r: 2.8 },
  { cx: 81, cy: 83, r: 1.5 },
];

const CANDY_STRIPES: readonly number[] = Array.from(
  { length: 12 },
  (_, index) => -60 + index * 16,
);

interface StaticPatternProps {
  patternId: AppearancePatternId;
  opacity: number;
  color: string;
  secondary: string;
  testID: string;
}

function StaticPattern({ patternId, opacity, color, secondary, testID }: StaticPatternProps) {
  const safeOpacity = Math.max(0, Math.min(1, opacity));

  return (
    <View
      testID={testID}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      accessible={false}
    >
      <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
        {patternId === 'pop-dots' ? (
          <G opacity={safeOpacity}>
            {POP_DOTS.map((dot, index) => (
              <Circle
                key={`${dot.cx}-${dot.cy}`}
                cx={dot.cx}
                cy={dot.cy}
                r={dot.r}
                fill={index % 4 === 0 ? secondary : color}
              />
            ))}
          </G>
        ) : null}

        {patternId === 'candy-stripes' ? (
          <G opacity={safeOpacity}>
            {CANDY_STRIPES.map((offset, index) => (
              <Path
                key={offset}
                d={`M ${offset} 112 L ${offset + 112} 0`}
                stroke={index % 3 === 0 ? secondary : color}
                strokeWidth={5}
                strokeLinecap="round"
                fill="none"
              />
            ))}
          </G>
        ) : null}

        {patternId === 'soda-bubbles' ? (
          <G opacity={safeOpacity}>
            {SODA_BUBBLES.map((bubble, index) => (
              <Circle
                key={`${bubble.cx}-${bubble.cy}`}
                cx={bubble.cx}
                cy={bubble.cy}
                r={bubble.r}
                fill={index % 3 === 0 ? secondary : color}
              />
            ))}
          </G>
        ) : null}
      </Svg>
    </View>
  );
}

function StickerGlyph({ motif, color }: { motif: AppearanceStickerMotif; color: string }) {
  switch (motif) {
    case 'spark':
      return <Path d="M12 1.8 L14.7 9.3 L22.2 12 L14.7 14.7 L12 22.2 L9.3 14.7 L1.8 12 L9.3 9.3 Z" fill={color} />;
    case 'star':
      return (
        <Path
          d="M12 1.9 L14.9 8.4 L21.9 9.2 L16.7 13.9 L18.1 20.8 L12 17.3 L5.9 20.8 L7.3 13.9 L2.1 9.2 L9.1 8.4 Z"
          fill={color}
        />
      );
    case 'dot':
      return <Circle cx={12} cy={12} r={7.4} fill={color} />;
    case 'heart':
      return (
        <Path
          d="M12 21.2 C9.2 18.7 3.2 14.6 3.2 9.2 C3.2 5.7 5.8 3.2 9 3.2 C10.6 3.2 12 4.1 12 4.1 C12 4.1 13.4 3.2 15 3.2 C18.2 3.2 20.8 5.7 20.8 9.2 C20.8 14.6 14.8 18.7 12 21.2 Z"
          fill={color}
        />
      );
    case 'swirl':
      return (
        <Path
          d="M12 3.2 C6.2 3.2 3.4 8.1 5.6 11.8 C7.5 15 11.6 15.1 13.5 12.7 C15 10.8 14 8 11.6 7.6 C9.7 7.3 8.2 8.6 8.2 10.1"
          stroke={color}
          strokeWidth={2.4}
          strokeLinecap="round"
          fill="none"
        />
      );
    case 'bubble':
      return (
        <G>
          <Circle cx={12} cy={12} r={7.4} fill={color} opacity={0.75} />
          <Circle cx={10} cy={10} r={2.2} fill="#ffffff" opacity={0.55} />
        </G>
      );
    case 'ring':
      return <Circle cx={12} cy={12} r={7.2} stroke={color} strokeWidth={3} fill="none" />;
    default:
      return null;
  }
}

function StaticStickers({
  stickers,
  color,
  extraOpacity,
}: {
  stickers: readonly AppearanceSticker[];
  color: string;
  extraOpacity: number;
}) {
  const opacity = 0.55 + Math.max(0, Math.min(1, extraOpacity)) * 0.45;

  return (
    <>
      {stickers.map((sticker) => (
        <Svg
          key={sticker.id}
          testID={appearanceStickerTestID(sticker.id)}
          width={sticker.size}
          height={sticker.size}
          viewBox="0 0 24 24"
          style={{
            position: 'absolute',
            left: `${sticker.x * 100}%`,
            top: `${sticker.y * 100}%`,
            width: sticker.size,
            height: sticker.size,
            marginLeft: -sticker.size / 2,
            marginTop: -sticker.size / 2,
            opacity,
            transform: [{ rotate: `${sticker.rotation}deg` }],
          }}
          accessible={false}
        >
          <StickerGlyph motif={sticker.motif} color={color} />
        </Svg>
      ))}
    </>
  );
}

interface BlobLayout {
  readonly size: number;
  readonly left: `${number}%`;
  readonly top: `${number}%`;
  readonly travelX: number;
  readonly travelY: number;
  readonly scaleDelta: number;
  readonly baseOpacity: number;
  readonly tone: 'accent' | 'secondary';
}

const BLOB_LAYOUTS: readonly BlobLayout[] = [
  {
    size: 300,
    left: '-24%',
    top: '6%',
    travelX: 26,
    travelY: -18,
    scaleDelta: 0.08,
    baseOpacity: 0.12,
    tone: 'accent',
  },
  {
    size: 220,
    left: '34%',
    top: '52%',
    travelX: -20,
    travelY: 22,
    scaleDelta: -0.06,
    baseOpacity: 0.1,
    tone: 'secondary',
  },
];

function AnimatedBlob({
  index,
  drift,
  motion,
  accent,
  secondary,
}: {
  index: number;
  drift: SharedValue<number>;
  motion: number;
  accent: string;
  secondary: string;
}) {
  const layout = BLOB_LAYOUTS[index % BLOB_LAYOUTS.length];
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: drift.value * layout.travelX },
      { translateY: drift.value * layout.travelY },
      { scale: 1 + drift.value * layout.scaleDelta },
    ],
  }));
  const strength = Math.max(0, Math.min(1, motion));

  return (
    <Animated.View
      testID={`${APPEARANCE_ANIMATED_BLOB_TEST_ID_PREFIX}${index}`}
      pointerEvents="none"
      accessible={false}
      style={[
        {
          position: 'absolute',
          left: layout.left,
          top: layout.top,
          width: layout.size,
          height: layout.size,
          borderRadius: layout.size / 2,
          backgroundColor: layout.tone === 'accent' ? accent : secondary,
          opacity: layout.baseOpacity * (0.35 + strength * 0.65),
        },
        animatedStyle,
      ]}
    />
  );
}

function AnimatedBackgroundLayers({
  count,
  motion,
  accent,
  secondary,
}: {
  count: number;
  motion: number;
  accent: string;
  secondary: string;
}) {
  const drift = useSharedValue(0);
  // Slower for weaker motion; always a long, non-flashing drift.
  const duration = 16000 + Math.round((1 - Math.max(0, Math.min(1, motion))) * 6000);

  useEffect(() => {
    drift.value = 0;
    drift.value = withRepeat(
      withTiming(1, { duration, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(drift);
      drift.value = 0;
    };
  }, [drift, duration]);

  return (
    <View
      testID={APPEARANCE_ANIMATED_LAYER_TEST_ID}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: count }, (_, index) => (
        <AnimatedBlob
          key={index}
          index={index}
          drift={drift}
          motion={motion}
          accent={accent}
          secondary={secondary}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
  },
});

export function AppearanceDecorations({
  visual,
  active,
  reduceMotion = false,
  testID,
}: AppearanceDecorationsProps) {
  const decoration = visual.decoration;
  const hasStatic = decoration.patternId !== null || decoration.staticStickers.length > 0;

  if (
    visual.stage === 0 ||
    visual.vibrancy === 'off' ||
    (!hasStatic && decoration.animatedLayers === 0)
  ) {
    return null;
  }

  const layerTestID = testID ?? APPEARANCE_STATIC_LAYER_TEST_ID;
  const animated =
    active &&
    !reduceMotion &&
    decoration.animatedLayers > 0 &&
    decoration.motion > 0;

  return (
    <View
      testID={layerTestID}
      style={styles.layer}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {animated ? (
        <AnimatedBackgroundLayers
          count={decoration.animatedLayers}
          motion={decoration.motion}
          accent={visual.accent}
          secondary={visual.secondary}
        />
      ) : null}

      {decoration.patternId !== null ? (
        <StaticPattern
          patternId={decoration.patternId}
          opacity={decoration.patternOpacity}
          color={visual.accent}
          secondary={visual.border}
          testID={`${layerTestID}${APPEARANCE_PATTERN_TEST_ID_SUFFIX}`}
        />
      ) : null}

      <StaticStickers
        stickers={decoration.staticStickers}
        color={visual.accent}
        extraOpacity={decoration.extraOpacity}
      />
    </View>
  );
}
