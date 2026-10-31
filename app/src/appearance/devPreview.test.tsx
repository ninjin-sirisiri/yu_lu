import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '../theme/provider';
import { DevPreviewPanel } from './DevPreviewPanel';
import {
  devPreviewAvailable,
  devStreakForStage,
  getDevPreview,
  normalizeDevPreview,
  setDevPreview,
} from './devPreview';

/**
 * Dev-only appearance preview: the store is display-only (nothing is written
 * to the server/SQLite), both halves are independent, and the panel applies
 * changes immediately.
 */

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, bottom: 34, left: 0, right: 0 },
};

async function renderPanel() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider
        deviceScheme="light"
        store={{ read: async () => null, write: async () => {} }}
      >
        <DevPreviewPanel />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

afterEach(() => {
  setDevPreview(null);
});

it('is available in the development build used by tests', () => {
  expect(devPreviewAvailable()).toBe(true);
});

it('clamps the preview to the appearance contract ranges', () => {
  expect(normalizeDevPreview({ streak: { currentStreak: -3, earnedDays: 120 }, growthDays: -1 }))
    .toEqual({ streak: { currentStreak: 0, earnedDays: 100 }, growthDays: 0 });
  expect(normalizeDevPreview({ streak: devStreakForStage(29), growthDays: 3.9 }))
    .toEqual({ streak: { currentStreak: 29, earnedDays: 29 }, growthDays: 3 });
});

it('changes the personal streak and conversation growth independently', async () => {
  await renderPanel();
  await fireEvent.press(screen.getByTestId('dev-preview-open'));

  await fireEvent.press(screen.getByTestId('dev-preview-streak-30'));
  expect(getDevPreview()).toEqual({
    streak: { currentStreak: 30, earnedDays: 30 },
    growthDays: null,
  });

  await fireEvent.press(screen.getByTestId('dev-preview-growth-7'));
  expect(getDevPreview()).toEqual({
    streak: { currentStreak: 30, earnedDays: 30 },
    growthDays: 7,
  });

  expect(screen.getByTestId('dev-preview-streak-copy')).toBeTruthy();
  expect(screen.getByTestId('dev-preview-growth-copy')).toBeTruthy();
});

it('keeps the earned stage while showing a reset streak', async () => {
  await renderPanel();
  await fireEvent.press(screen.getByTestId('dev-preview-open'));
  await fireEvent.press(screen.getByTestId('dev-preview-reset-streak'));

  expect(getDevPreview()?.streak).toEqual({ currentStreak: 0, earnedDays: 29 });
  expect(screen.getByText('獲得済み：7日段階')).toBeTruthy();
  expect(screen.getByText('次の30日段階まであと30日')).toBeTruthy();
});

it('restores the server values from the panel', async () => {
  await renderPanel();
  await fireEvent.press(screen.getByTestId('dev-preview-open'));
  await fireEvent.press(screen.getByTestId('dev-preview-streak-1'));
  expect(getDevPreview()).not.toBeNull();

  await fireEvent.press(screen.getByTestId('dev-preview-off'));
  expect(getDevPreview()).toBeNull();
});
