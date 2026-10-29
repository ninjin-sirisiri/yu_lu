// Task 15: dynamic Expo config — wires the SAME validated invite domain
// into the SDK 58 link configuration that scripts/build-invite-web.mjs
// writes into the association files.
//
// Ownership: the domain additions only. Everything already in app.json is
// imported untouched (`ConfigContext.config` IS the static app.json), and
// no value is ever invented:
//
// - INVITE_ORIGIN set (valid) →
//     ios.associatedDomains: ['applinks:<host>']
//     android.intentFilters: [{ autoVerify, https, host, /invitation path }]
// - INVITE_ORIGIN absent      → no-op: config output is byte-identical in
//     shape to app.json's, plus one stderr warning naming the variable.
//     `npx expo config --type public` keeps working with zero external
//     inputs (that is the required state).
// - INVITE_ORIGIN present but malformed (or disagreeing with
//   EXPO_PUBLIC_INVITE_ORIGIN) → throw: fail loudly, never invent.
//
// Validation lives in scripts/invite-web-config.mjs so the app link
// config, the invite web build and the tests cannot drift apart.

import type { ConfigContext, ExpoConfig } from 'expo/config';

// The helper is plain ESM; Node >= 22.12 loads it synchronously via
// require(), and app.config.ts must stay synchronous (Expo rejects
// Promise exports).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveInviteOrigin } = require('../scripts/invite-web-config.mjs') as {
  resolveInviteOrigin: (env?: Record<string, string | undefined>) => string | null;
};

/** The invitation path every association/intent filter is scoped to. */
export const INVITE_PATH_PREFIX = '/invitation';

export default ({ config }: ConfigContext): Partial<ExpoConfig> => {
  let origin: string | null;
  try {
    origin = resolveInviteOrigin(process.env);
  } catch (cause) {
    // Invalid or conflicting values must never silently produce a build
    // with the wrong domain attached.
    throw new Error(
      `app.config.ts: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  if (origin === null) {
    // No-op, clearly: no external input → no domain additions, and the
    // public config still renders (verified by scripts/invite-web.test.mjs).
    process.stderr.write(
      'app.config.ts: INVITE_ORIGIN not set — skipping ios.associatedDomains ' +
        'and android.intentFilters (no domain was invented).\n',
    );
    return config;
  }

  const host = new URL(origin).host;

  const next: Partial<ExpoConfig> = {
    ...config,
    ios: {
      ...config.ios,
      // `applinks:<fully qualified domain>` entries.
      associatedDomains: [...(config.ios?.associatedDomains ?? []), `applinks:${host}`],
    },
    android: {
      ...config.android,
      intentFilters: [
        ...(config.android?.intentFilters ?? []),
        {
          autoVerify: true,
          action: 'VIEW',
          data: { scheme: 'https', host, pathPrefix: INVITE_PATH_PREFIX },
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
  };
  return next;
};
