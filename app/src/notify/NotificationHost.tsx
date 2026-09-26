import { usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../auth/provider';
import { destinationRoute, type ExternalDestination } from '../navigation/externalEntry';
import { notifyFriendsChanged } from '../requests/friendsRepository';
import { useTheme } from '../theme/provider';
import { spacing, typography } from '../theme/tokens';
import {
  attachArrivalListener,
  attachResponseListener,
  blocksNotificationEntry,
  externalUrlOwnsLaunch,
  handleNotificationResponse,
  readInitialResponse,
  readInitialUrl,
  setupForegroundSuppression,
  subscribeNotificationArrived,
  type NotificationArrival,
} from './listener';

// Task 19: the notification host — one component in the ROOT layout that
// owns every receipt path and the foreground indication.
//
// Ownership:
// - **Foreground suppression** is installed once here (setupForegroundSuppression);
//   background presentation stays with the OS.
// - **One handling path**: while-running taps (response listener) and the
//   terminated cold start (getLastNotificationResponse, seeded once per
//   process) both land in the SAME queue and are drained through
//   `handleNotificationResponse` — so dedupe/verification/navigation behave
//   identically no matter when the user tapped.
// - **Entry gate**: a queued response is only drained when the user is
//   signed in AND registered AND the current pathname is not another entry
//   ('' , '/', /login, /register, /invitation*, /auth/*). Until then the
//   entry is PRESERVED in the queue (未登録なら入口を保持し、登録後に…).
// - **URL ownership**: when THIS launch was started by an invitation /
//   OAuth URL, the notification response is NOT seeded — the router handles
//   that URL and the response stays unseen for a later, URL-free launch
//   (通知・招待・OAuthの入口を混同しない).
// - **Foreground indication**: arrivals show a short in-app notice (the OS
//   banner/sound is suppressed) and refresh the lists via
//   notifyFriendsChanged — 受信件数はタブ側の subscribeFriendsChanged が更新.

const NOTICE_DURATION_MS = 5000;

export function NotificationHost() {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { tokens } = useTheme();

  const [arrival, setArrival] = useState<NotificationArrival | null>(null);
  const queueRef = useRef<unknown[]>([]);
  const [queueVersion, setQueueVersion] = useState(0);

  const enqueue = useCallback((response: unknown) => {
    if (response === null || response === undefined) return;
    queueRef.current.push(response);
    setQueueVersion((version) => version + 1);
  }, []);

  // (1) Mount once: install suppression, attach both listeners, seed the
  // cold-start response — unless an external URL owns this launch.
  useEffect(() => {
    setupForegroundSuppression();
    const detachArrival = attachArrivalListener();
    const detachResponse = attachResponseListener(enqueue);
    let alive = true;
    void (async () => {
      const url = await readInitialUrl();
      if (!alive) return;
      if (externalUrlOwnsLaunch(url)) return; // the URL entry owns this launch
      const initial = readInitialResponse();
      if (initial !== null && initial !== undefined) enqueue(initial);
    })();
    return () => {
      alive = false;
      detachArrival();
      detachResponse();
    };
  }, [enqueue]);

  // (2) Foreground arrival → short in-app notice + list refresh (the OS
  // banner/sound is suppressed by the handler installed above).
  useEffect(
    () =>
      subscribeNotificationArrived((next) => {
        setArrival(next);
        notifyFriendsChanged();
      }),
    [],
  );

  // (3) The notice is transient: dismissed by tap or after a few seconds.
  useEffect(() => {
    if (arrival === null) return;
    const timer = setTimeout(() => setArrival(null), NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [arrival]);

  // (4) Drain the queue only when the entry gate is open: signed in,
  // registered, and the current pathname is not another entry type.
  const gateOpen =
    auth.status === 'ready' &&
    auth.registration === 'registered' &&
    auth.accountId !== null &&
    !blocksNotificationEntry(pathname);

  const navigate = useCallback(
    (destination: ExternalDestination) => {
      const route = destinationRoute(destination);
      router.push({ pathname: route.pathname, params: route.params });
    },
    [router],
  );

  useEffect(() => {
    if (!gateOpen) return;
    if (queueRef.current.length === 0) return;
    // Take the whole queue so a re-run (e.g. the navigation we cause) can
    // never process the same response twice.
    const queue = queueRef.current;
    queueRef.current = [];
    void (async () => {
      for (const response of queue) {
        const outcome = await handleNotificationResponse(response, {
          storage: auth.storage,
          accountId: auth.accountId,
          registration: auth.registration,
          navigate,
        }).catch(() => 'rejected' as const);
        if (outcome === 'deferred') {
          // The auth gate closed mid-flight — keep the entry for later.
          queueRef.current.unshift(response);
          setQueueVersion((version) => version + 1);
          break;
        }
      }
    })();
  }, [gateOpen, queueVersion, auth.storage, auth.accountId, auth.registration, navigate]);

  if (arrival === null) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.overlay, { top: insets.top + spacing.s2 }]}
      testID="notify-in-app-overlay"
    >
      <Pressable
        testID="notify-in-app-notice"
        onPress={() => setArrival(null)}
        accessibilityRole="button"
        accessibilityLabel="通知を閉じる"
        style={[styles.notice, { backgroundColor: tokens.soft, borderColor: tokens.line }]}
      >
        <Text
          style={[styles.title, { color: tokens.text }]}
          numberOfLines={1}
          allowFontScaling
        >
          {arrival.title !== null && arrival.title !== '' ? arrival.title : '通知を受信しました'}
        </Text>
        {arrival.body !== null && arrival.body !== '' && (
          <Text style={[styles.body, { color: tokens.muted }]} numberOfLines={2} allowFontScaling>
            {arrival.body}
          </Text>
        )}
        <Text style={[styles.hint, { color: tokens.muted }]} allowFontScaling>
          タップして閉じる
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: spacing.s3,
  },
  notice: {
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.s3,
    gap: spacing.s1,
  },
  title: {
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  body: {
    fontSize: typography.sizes.small,
  },
  hint: {
    fontSize: typography.sizes.caption,
  },
});
