import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { render } from '@testing-library/react-native';

import {
  APPEARANCE_ANIMATED_LAYER_TEST_ID,
  APPEARANCE_STATIC_LAYER_TEST_ID,
  AppearanceDecorations,
} from '../src/appearance/AppearanceDecorations';
import { AppearanceSurface } from '../src/appearance/AppearanceSurface';
import { ProtectedSurface } from '../src/appearance/ProtectedSurface';
import { APPEARANCE_PRESET_IDS, type AppearancePresetId } from '../src/appearance/contracts';
import type { AppearanceScheme, AppearanceVibrancy } from '../src/appearance/catalog';
import {
  calculateAppearance,
  contrastRatio,
  type AppearanceVisual,
} from '../src/appearance/calculate';
import { ThemeProvider } from '../src/theme/provider';
import { tokensFor } from '../src/theme/tokens';

jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

const STORAGE = { read: async () => null, write: async () => {} };
const STAGES = [0, 1, 7, 30, 60, 100] as const;
const SCHEMES: readonly AppearanceScheme[] = ['light', 'dark'];
const VIBRANCIES: readonly AppearanceVibrancy[] = ['flashy', 'subtle', 'off'];

function appearance(
  days: number,
  presetId: AppearancePresetId = 'b-pop',
  scheme: AppearanceScheme = 'light',
  vibrancy: AppearanceVibrancy = 'flashy',
): AppearanceVisual {
  return calculateAppearance({ subject: 'chat', days, presetId, scheme, vibrancy });
}

function stickerTestID(id: string): string {
  return `appearance-sticker-${id}`;
}

type Rendered = Awaited<ReturnType<typeof render>>;
const HIDDEN = { includeHiddenElements: true } as const;

function stickerSnapshot(view: Rendered) {
  return view.getAllByTestId(/^appearance-sticker-/, HIDDEN).map((node) => ({
    testID: node.props.testID as string,
    style: StyleSheet.flatten(node.props.style),
  }));
}

interface HostNode {
  type: string;
  props: Record<string, unknown>;
  children: HostTree[] | null;
}

type HostTree = HostNode | string | HostTree[] | null;

function collectHostNodes(node: HostTree): HostNode[] {
  if (node === null || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap((child) => collectHostNodes(child));
  return [node, ...collectHostNodes(node.children)];
}

function hostTree(view: Rendered): HostNode[] {
  return collectHostNodes(view.toJSON() as HostTree);
}

it('renders non-interactive decoration across every stage, preset, scheme and vibrancy', async () => {
  for (const days of STAGES) {
    for (const presetId of APPEARANCE_PRESET_IDS) {
      for (const scheme of SCHEMES) {
        for (const vibrancy of VIBRANCIES) {
          const visual = appearance(days, presetId, scheme, vibrancy);
          const view = await render(<AppearanceDecorations visual={visual} active />);
          const layer = view.queryByTestId(APPEARANCE_STATIC_LAYER_TEST_ID, HIDDEN);
          const animated = view.queryByTestId(APPEARANCE_ANIMATED_LAYER_TEST_ID, HIDDEN);
          const empty = visual.stage === 0 || visual.vibrancy === 'off';

          if (empty) {
            expect(layer).toBeNull();
            expect(animated).toBeNull();
          } else {
            expect(layer).not.toBeNull();
            expect(layer!.props.pointerEvents).toBe('none');
            expect(layer!.props.accessible).toBe(false);
            expect(layer!.props.accessibilityElementsHidden).toBe(true);
            expect(layer!.props.importantForAccessibility).toBe('no-hide-descendants');

            const layerStyle = StyleSheet.flatten(layer!.props.style);
            expect(layerStyle.position).toBe('absolute');
            expect(layerStyle.top).toBe(0);
            expect(layerStyle.right).toBe(0);
            expect(layerStyle.bottom).toBe(0);
            expect(layerStyle.left).toBe(0);

            expect(view.queryByTestId(`${APPEARANCE_STATIC_LAYER_TEST_ID}-pattern`, HIDDEN)).not.toBeNull();
            for (const sticker of visual.decoration.staticStickers) {
              expect(view.queryByTestId(stickerTestID(sticker.id), HIDDEN)).not.toBeNull();
            }
            expect(view.queryAllByTestId(/^appearance-sticker-/, HIDDEN)).toHaveLength(
              visual.decoration.staticStickers.length,
            );

            if (visual.vibrancy === 'flashy') {
              expect(animated).not.toBeNull();
              expect(animated!.props.pointerEvents).toBe('none');
              expect(animated!.props.accessible).toBe(false);
              expect(animated!.props.accessibilityElementsHidden).toBe(true);
              expect(animated!.props.importantForAccessibility).toBe('no-hide-descendants');
              expect(view.queryAllByTestId(/^appearance-animated-blob-/, HIDDEN)).toHaveLength(
                visual.decoration.animatedLayers,
              );
            } else {
              expect(animated).toBeNull();
            }
          }

          expect(hostTree(view).filter((node) => node.props.onLayout !== undefined)).toHaveLength(0);
          expect(
            hostTree(view).filter(
              (node) =>
                node.props.onPress !== undefined ||
                node.props.onStartShouldSetResponder !== undefined,
            ),
          ).toHaveLength(0);
          await view.unmount();
        }
      }
    }
  }
});

it('has no decoration at stage 0 or when vibrancy is off', async () => {
  for (const visual of [
    appearance(0, 'b-pop', 'light', 'flashy'),
    appearance(100, 'b-candy', 'dark', 'off'),
  ]) {
    const view = await render(<AppearanceDecorations visual={visual} active />);
    expect(view.toJSON()).toBeNull();
    expect(view.queryByTestId(APPEARANCE_STATIC_LAYER_TEST_ID, HIDDEN)).toBeNull();
    expect(view.queryByTestId(APPEARANCE_ANIMATED_LAYER_TEST_ID, HIDDEN)).toBeNull();
    await view.unmount();
  }
});

it('keeps subtle decoration static', async () => {
  const visual = appearance(60, 'b-candy', 'dark', 'subtle');
  const view = await render(<AppearanceDecorations visual={visual} active />);

  expect(view.queryByTestId(APPEARANCE_STATIC_LAYER_TEST_ID, HIDDEN)).not.toBeNull();
  expect(view.queryByTestId(`${APPEARANCE_STATIC_LAYER_TEST_ID}-pattern`, HIDDEN)).not.toBeNull();
  expect(view.queryAllByTestId(/^appearance-sticker-/, HIDDEN)).toHaveLength(
    visual.decoration.staticStickers.length,
  );
  expect(view.queryByTestId(APPEARANCE_ANIMATED_LAYER_TEST_ID, HIDDEN)).toBeNull();
  await view.unmount();
});

it('runs the animated background only while active and motion is allowed', async () => {
  const visual = appearance(100, 'b-pop', 'light', 'flashy');
  const view = await render(<AppearanceDecorations visual={visual} active={false} />);

  expect(view.queryByTestId(APPEARANCE_STATIC_LAYER_TEST_ID, HIDDEN)).not.toBeNull();
  expect(view.queryByTestId(APPEARANCE_ANIMATED_LAYER_TEST_ID, HIDDEN)).toBeNull();

  await view.rerender(<AppearanceDecorations visual={visual} active />);
  expect(view.queryByTestId(APPEARANCE_ANIMATED_LAYER_TEST_ID, HIDDEN)).not.toBeNull();
  expect(view.queryAllByTestId(/^appearance-animated-blob-/, HIDDEN)).toHaveLength(
    visual.decoration.animatedLayers,
  );

  await view.rerender(<AppearanceDecorations visual={visual} active reduceMotion />);
  expect(view.queryByTestId(APPEARANCE_STATIC_LAYER_TEST_ID, HIDDEN)).not.toBeNull();
  expect(view.queryByTestId(APPEARANCE_ANIMATED_LAYER_TEST_ID, HIDDEN)).toBeNull();

  await view.rerender(<AppearanceDecorations visual={visual} active reduceMotion={false} />);
  expect(view.queryByTestId(APPEARANCE_ANIMATED_LAYER_TEST_ID, HIDDEN)).not.toBeNull();
  await view.unmount();
});

it('keeps sticker ids and positions stable for the same stage', async () => {
  const visual = appearance(60, 'b-pop', 'light', 'flashy');
  const view = await render(<AppearanceDecorations visual={visual} active />);
  const first = stickerSnapshot(view);

  expect(first).toHaveLength(visual.decoration.staticStickers.length);
  expect(first.map((entry) => entry.testID)).toEqual(
    visual.decoration.staticStickers.map((sticker) => stickerTestID(sticker.id)),
  );

  await view.rerender(<AppearanceDecorations visual={visual} active />);
  expect(stickerSnapshot(view)).toEqual(first);

  // Days 60-99 all resolve to the same display stage, so decoration must not
  // be shuffled just because the raw day count advanced.
  await view.rerender(<AppearanceDecorations visual={appearance(75, 'b-pop', 'light', 'flashy')} active />);
  expect(stickerSnapshot(view)).toEqual(first);
  await view.unmount();
});

it('does not remount children when the appearance changes', async () => {
  let mounts = 0;

  function Child() {
    useEffect(() => {
      mounts += 1;
    }, []);
    return (
      <View testID="surface-child" style={{ height: 42 }}>
        <Text>本文</Text>
      </View>
    );
  }

  const view = await render(
    <AppearanceSurface visual={appearance(1)} testID="surface" active>
      <Child />
    </AppearanceSurface>,
  );

  expect(mounts).toBe(1);
  expect(view.getByTestId('surface-content')).not.toBeNull();
  expect(StyleSheet.flatten(view.getByTestId('surface-child').props.style).height).toBe(42);

  await view.rerender(
    <AppearanceSurface visual={appearance(100, 'b-soda', 'dark', 'flashy')} testID="surface" active>
      <Child />
    </AppearanceSurface>,
  );

  expect(mounts).toBe(1);
  expect(StyleSheet.flatten(view.getByTestId('surface-child').props.style).height).toBe(42);
  await view.unmount();
});

it('fills the surface without a decoration spacer and stops animation when inactive', async () => {
  const visual = appearance(100, 'b-pop', 'light', 'flashy');
  const view = await render(
    <AppearanceSurface visual={visual} testID="surface" active={false}>
      <View testID="surface-child" style={{ flex: 1 }} />
    </AppearanceSurface>,
  );

  const surfaceStyle = StyleSheet.flatten(view.getByTestId('surface').props.style);
  const contentStyle = StyleSheet.flatten(view.getByTestId('surface-content').props.style);
  const decorationStyle = StyleSheet.flatten(
    view.getByTestId('surface-decorations', HIDDEN).props.style,
  );

  expect(surfaceStyle.backgroundColor).toBe(visual.background);
  expect(contentStyle.flex).toBe(1);
  expect(decorationStyle.position).toBe('absolute');
  expect(decorationStyle.top).toBe(0);
  expect(view.queryByTestId(APPEARANCE_ANIMATED_LAYER_TEST_ID, HIDDEN)).toBeNull();
  expect(hostTree(view).filter((node) => node.props.onLayout !== undefined)).toHaveLength(0);
  await view.unmount();
});

it('renders an opaque token-protected surface with a 3:1 boundary and untouched child layout', async () => {
  for (const scheme of SCHEMES) {
    for (const tone of ['default', 'error'] as const) {
      const tokens = tokensFor(scheme);
      const view = await render(
        <ThemeProvider store={STORAGE} deviceScheme={scheme}>
          <ProtectedSurface testID="protected" tone={tone} accessibilityRole="alert">
            <View testID="protected-child" style={{ height: 48 }}>
              <Text testID="protected-text" style={{ color: tokens.text }}>
                送信できませんでした
              </Text>
            </View>
          </ProtectedSurface>
        </ThemeProvider>,
      );

      const surface = view.getByTestId('protected');
      const surfaceStyle = StyleSheet.flatten(surface.props.style);
      const boundary = tone === 'error' ? tokens.danger : tokens.muted;

      expect(surface.props.accessibilityRole).toBe('alert');
      expect(surfaceStyle.backgroundColor).toBe(tokens.surface);
      expect(surfaceStyle.backgroundColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(surfaceStyle.borderColor).toBe(boundary);
      expect(surfaceStyle.borderColor).not.toBe(tokens.line);
      expect(contrastRatio(boundary, tokens.surface)).toBeGreaterThanOrEqual(3);
      expect(surface.props.onLayout).toBeUndefined();
      expect(surfaceStyle.padding).toBeUndefined();
      expect(surfaceStyle.position).toBeUndefined();

      const childStyle = StyleSheet.flatten(view.getByTestId('protected-child').props.style);
      expect(childStyle.height).toBe(48);
      expect(StyleSheet.flatten(view.getByTestId('protected-text').props.style).color).toBe(
        tokens.text,
      );

      const absoluteDescendants = collectHostNodes(
        view.toJSON() as HostTree,
      ).filter((node) => StyleSheet.flatten(node.props.style as never)?.position === 'absolute');
      expect(absoluteDescendants).toHaveLength(0);

      await view.unmount();
    }
  }
});
