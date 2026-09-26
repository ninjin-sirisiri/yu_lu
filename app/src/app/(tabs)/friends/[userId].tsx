import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { QueryError, getProfile, type ProfileDetail } from '../../../backend/queries';
import { RELATIONSHIP_LABELS, defaultIsOnline } from '../../../discovery/searchController';
import { useTheme } from '../../../theme/provider';
import { radius, spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';
import { StatusNotice } from '../../../ui/StatusNotice';

// Task 12: 確認プロフィール.
//
// The route param is the INTERNAL user uuid (Task 5 ruling) — get_profile
// keys on it — while the rendered profile keeps the visible User ID
// (userIdText) the person registered. One panel serves the [userId] route,
// the friends list detail pane and the search-candidate confirmation pane.
//
// The four failure look-alikes stay distinct: 初回読込 (loading),
// 通信失敗 (retryable), オフライン (no connection) and ブロック等による消失
// (the server answers 404 "Target user not found." for hidden profiles).
// Streak is hidden until friendship — the server omits the key for
// non-friends AND this panel refuses to render one for them regardless.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProfileViewKind = 'loading' | 'ready' | 'offline' | 'network' | 'gone';

export interface ProfilePanelProps {
  /** Internal user uuid (route param / DTO `userId`). */
  userId: string;
  /** Shows 一覧に戻る when provided (adaptive detail panes). */
  onBack?: () => void;
  testID?: string;
}

export function ProfilePanel({ userId, onBack, testID = 'profile-panel' }: ProfilePanelProps) {
  const { tokens } = useTheme();
  const [kind, setKind] = useState<ProfileViewKind>('loading');
  const [profile, setProfile] = useState<ProfileDetail | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    if (!UUID_RE.test(userId)) {
      setKind('gone');
      setProfile(null);
      return;
    }
    if (!defaultIsOnline()) {
      setKind('offline');
      setProfile(null);
      return;
    }
    setKind('loading');
    getProfile(userId)
      .then((detail) => {
        if (!alive) return;
        setProfile(detail);
        setKind('ready');
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setProfile(null);
        if (error instanceof QueryError && error.status === 404) {
          // Hidden by the server: block either direction or no longer
          // public. This is NOT a network failure.
          setKind('gone');
          return;
        }
        setKind(defaultIsOnline() ? 'network' : 'offline');
      });
    return () => {
      alive = false;
    };
  }, [userId, attempt]);

  if (kind === 'loading') {
    return (
      <View style={styles.root} testID={testID}>
        <Text style={[styles.state, { color: tokens.muted }]} testID="profile-loading">
          読み込み中…
        </Text>
      </View>
    );
  }

  if (kind === 'offline') {
    return (
      <View style={styles.root} testID={testID}>
        <StatusNotice
          tone="warning"
          title="オフラインのためプロフィールを取得できません"
          message="接続後に再試行してください。"
          testID="profile-offline"
        />
        <Button
          label="再試行"
          variant="secondary"
          testID="profile-retry"
          onPress={() => setAttempt((value) => value + 1)}
        />
      </View>
    );
  }

  if (kind === 'network') {
    return (
      <View style={styles.root} testID={testID}>
        <StatusNotice
          tone="error"
          title="プロフィールを読み込めませんでした"
          testID="profile-network"
        />
        <Button
          label="再試行"
          variant="secondary"
          testID="profile-retry"
          onPress={() => setAttempt((value) => value + 1)}
        />
      </View>
    );
  }

  if (kind === 'gone' || profile === null) {
    return (
      <View style={styles.root} testID={testID}>
        <StatusNotice
          tone="warning"
          title="この相手は表示できなくなりました"
          message="ブロックされるなどして、公開プロフィールを取得できませんでした。"
          testID="profile-gone"
        />
      </View>
    );
  }

  // Streak only for friendships (and yourself) — server + client gate.
  const showStreak =
    (profile.relationship === 'friend' || profile.relationship === 'self') &&
    typeof profile.streak === 'number';

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.headerRow}>
        <View
          style={[styles.avatar, { backgroundColor: tokens.avatar }]}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          <Text style={[styles.avatarText, { color: tokens.avatarInk }]} allowFontScaling>
            {profile.displayName.slice(0, 1)}
          </Text>
        </View>
        <View style={styles.identity}>
          <Text
            style={[styles.name, { color: tokens.text }]}
            testID="profile-name"
            allowFontScaling
          >
            {profile.displayName}
          </Text>
          <Text style={[styles.userId, { color: tokens.muted }]} testID="profile-userid" allowFontScaling>
            {profile.userIdText}
          </Text>
        </View>
      </View>

      <View style={[styles.badge, { backgroundColor: tokens.accentSoft }]}>
        <Text
          style={[styles.badgeText, { color: tokens.accent }]}
          testID="profile-relationship"
          allowFontScaling
        >
          {RELATIONSHIP_LABELS[profile.relationship]}
        </Text>
      </View>

      {showStreak && (
        <Text
          style={[styles.streak, { color: tokens.text }]}
          testID="profile-streak"
          accessibilityLabel={`${String(profile.streak)}日継続`}
          allowFontScaling
        >
          {`${String(profile.streak)} 日 継続`}
        </Text>
      )}

      {profile.introduction !== null && profile.introduction !== '' && (
        <View style={[styles.introduction, { borderColor: tokens.line, backgroundColor: tokens.soft }]}>
          <Text style={[styles.introductionText, { color: tokens.text }]} testID="profile-introduction" allowFontScaling>
            {profile.introduction}
          </Text>
        </View>
      )}

      {onBack !== undefined && (
        <Button label="一覧に戻る" variant="secondary" testID="profile-back" onPress={onBack} />
      )}
    </View>
  );
}

export default function ProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const id = Array.isArray(userId) ? (userId[0] ?? '') : (userId ?? '');
  return (
    <Screen testID="profile-screen">
      <ProfilePanel userId={id} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.s4,
    paddingVertical: spacing.s4,
  },
  state: {
    fontSize: typography.sizes.bodyLarge,
    textAlign: 'center',
    paddingVertical: spacing.s5,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s4,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: typography.sizes.title,
    fontWeight: typography.weights.semibold,
  },
  identity: {
    flex: 1,
    gap: spacing.s1,
  },
  name: {
    fontSize: typography.sizes.title,
    fontWeight: typography.weights.semibold,
    lineHeight: typography.sizes.title * typography.lineHeightRatio,
  },
  userId: {
    fontSize: typography.sizes.small,
    lineHeight: typography.sizes.small * typography.lineHeightRatio,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s1,
  },
  badgeText: {
    fontSize: typography.sizes.caption,
    fontWeight: typography.weights.semibold,
  },
  streak: {
    fontSize: typography.sizes.bodyLarge,
    fontVariant: ['tabular-nums'],
  },
  introduction: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.s3,
  },
  introductionText: {
    fontSize: typography.sizes.body,
    lineHeight: typography.sizes.body * typography.lineHeightRatio,
  },
});
