import appConfig from '../app.json';
import packageJson from '../package.json';

// The app boots through index.ts -> 'expo-router/entry'. Mocking the entry
// lets this test verify the real startup wiring without registering a root
// component inside the Jest environment. The factory records each evaluation
// so the test can prove index.ts actually loads the router entry.
jest.mock('expo-router/entry', () => {
  const scope = globalThis as { __routerEntryLoads?: number };
  scope.__routerEntryLoads = (scope.__routerEntryLoads ?? 0) + 1;
  return {};
});

import '../index';

describe('scaffold: Expo Router startup wiring', () => {
  it('loads expo-router/entry from the package entry point', () => {
    const scope = globalThis as { __routerEntryLoads?: number };
    expect(scope.__routerEntryLoads).toBe(1);
  });

  it('keeps index.ts as main and jest-expo as the Jest preset', () => {
    expect(packageJson.main).toBe('index.ts');
    expect(packageJson.jest.preset).toBe('jest-expo');
  });

  it('provides the deep-link scheme and expo-router config plugin', () => {
    expect(appConfig.expo.scheme).toBeTruthy();
    expect(appConfig.expo.plugins).toContain('expo-router');
  });
});
