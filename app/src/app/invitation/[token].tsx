// Task 14: `/invitation/<token>` — the invitee's confirmation route.
//
// Ownership: everything the person who OPENED an invitation sees and the
// bookkeeping that must survive the auth boundary:
//
// - **Validate first**: a malformed token never reaches the network — it
//   shows 復元不能・不正リンク時の案内 (re-open the original link / find the
//   user by User ID).
// - **Save before login**: the pending invitation is stored as soon as the
//   route mounts (pre-login bucket when signed out) so OAuth復帰で招待情報を
//   失わない. It is also the row `markOnboardingSeenIfInvited` reads.
// - **Return after auth**: while the login/register CTA is showing, the
//   post-auth return target is set (see pending.ts) so「招待経則では登録後に
//   招待先確認へ直接戻る」; reaching a registered state clears it.
// - **Resolve** via app-query `resolve_invitation` (server is the only
//   authority on validity): valid → confirmation card + 申請; invalidated →
//   失効表示; expired → 期限切れ表示; 404 → 招待が見つかりません;
//   network failure → the cached resolution with 取得時点 (取得済み招待は
//   現在の有効性を保証しない) or an explain-and-retry state.
// - **案内済み記録**: a successful resolve marks the guide seen (idempotent
//   server-side) and caches the resolution for offline relaunch.
// - **申請**: the confirm screen is where「本人が申請を押す」happens — the
//   Task-4 `request` command with `invitation_token` goes through the same
//   queue as other sends (offline-capable 送信待ち).

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../auth/provider';
import {
  QueryError,
  resolveInvitation,
  type InvitationResolution,
} from '../../backend/queries';
import { defaultIsOnline } from '../../discovery/searchController';
import { randomId, type Storage } from '../../storage/database';
import { getOperation } from '../../storage/outbox';
import { createCommandApi } from '../../sync/api';
import { createSyncQueue } from '../../sync/queue';
import { createSyncWorker } from '../../sync/worker';
import { useTheme } from '../../theme/provider';
import { radius, spacing, typography } from '../../theme/tokens';
import { Button } from '../../ui/Button';
import { Screen } from '../../ui/Screen';
import { StatusNotice } from '../../ui/StatusNotice';
import { buildInvitationUrl, INVITATION_TOKEN_RE } from '../../invitations/links';
import {
  clearPostAuthInvitation,
  loadPendingInvitation,
  recordInvitationResolution,
  savePendingInvitation,
  setPostAuthInvitation,
} from '../../invitations/pending';

type Phase =
  | 'invalid' // token format wrong: never touches the network
  | 'auth-loading'
  | 'auth-error'
  | 'need-login' // signed out: save + offer login
  | 'need-register' // signed in, unregistered: save + offer registration
  | 'resolving'
  | 'resolved' // server answered (see resolution.status)
  | 'not-found' // server 404: unknown / blocked / unconfirmed inviter
  | 'cached' // offline, showing the last successful resolve with 取得時点
  | 'network-error'; // offline/network failure with nothing cached

type ApplyState = 'idle' | 'sending' | 'sent' | 'queued' | 'failed';

export default function InvitationRoute() {
  const params = useLocalSearchParams<{ token: string }>();
  const rawToken = params.token;
  const token = Array.isArray(rawToken) ? (rawToken[0] ?? '') : (rawToken ?? '');
  const auth = useAuth();
  const router = useRouter();
  const { tokens } = useTheme();
  const styles = makeStyles(tokens);

  const valid = INVITATION_TOKEN_RE.test(token);
  const [phase, setPhase] = useState<Phase>(valid ? 'auth-loading' : 'invalid');
  const [resolution, setResolution] = useState<InvitationResolution | null>(null);
  const [cached, setCached] = useState<{
    inviter: { displayName: string; userIdText: string };
    fetchedAt: number;
  } | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const applyBusyRef = useRef(false);
  // markOnboardingSeenIfInvited identity is stable per storage; a ref keeps
  // the resolve effect from re-running when unrelated context fields change.
  const markRef = useRef(auth.markOnboardingSeenIfInvited);
  markRef.current = auth.markOnboardingSeenIfInvited;

  const accountId = auth.accountId;
  const storage = auth.storage;

  // The shareable URL is best-effort here (this screen shows the token's
  // content, not a link to share); a missing EXPO_PUBLIC_INVITE_ORIGIN
  // must not block the confirmation flow — InvitePanel fails clearly for
  // the sharing side.
  const url = (() => {
    try {
      return buildInvitationUrl(token);
    } catch {
      return '';
    }
  })();

  // Save the pending invitation in ITS bucket as soon as storage exists —
  // signed out goes to the pre-login bucket (store before login, attach
  // after OAuth). Re-runs when the account appears; same token keeps the
  // existing row (first invitation / paste-vs-route metadata wins).
  // The promise is kept so the resolve effect below can await it: marking
  // the guide seen depends on this row existing (案内済み記録).
  const saveRef = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!valid || storage === null) return;
    saveRef.current = savePendingInvitation(storage, {
      accountId,
      payload: { token, url, source: 'route' },
    }).catch(() => {
      // A storage failure must never block the confirmation screen.
    });
  }, [valid, storage, accountId, token, url]);

  // Phase decision + resolve. Registered users get the server resolution;
  // everyone else gets a CTA plus the post-auth return target.
  useEffect(() => {
    if (!valid) {
      setPhase('invalid');
      return;
    }
    if (auth.status === 'loading') {
      setPhase('auth-loading');
      return;
    }
    if (auth.status === 'error') {
      setPhase('auth-error');
      return;
    }
    if (accountId === null) {
      // Signed out: registration state is irrelevant (the provider keeps it
      // at 'loading' until an account exists) — offer login and remember
      // the return target.
      setPhase('need-login');
      setPostAuthInvitation(token);
      return;
    }
    if (auth.registration === 'loading') {
      setPhase('auth-loading');
      return;
    }
    if (auth.registration !== 'registered') {
      setPhase('need-register');
      setPostAuthInvitation(token);
      return;
    }
    // Registered: the return target has served its purpose.
    clearPostAuthInvitation();

    let alive = true;
    setPhase('resolving');
    setResolution(null);
    setCached(null);
    void (async () => {
      try {
        // Make sure the pending row (the same-bucket save above) landed
        // before resolving: the resolution cache and 案内済み記録 read it.
        await saveRef.current;
        const result = await resolveInvitation(token);
        if (!alive) return;
        setResolution(result);
        setPhase('resolved');
        if (storage !== null && result.status === 'valid') {
          // Cache the confirmation for offline relaunch (取得時点 display).
          await recordInvitationResolution(storage, accountId, {
            token,
            status: result.status,
            expiresAt: result.expiresAt,
            inviter: {
              displayName: result.inviter.displayName,
              userIdText: result.inviter.userIdText,
            },
            fetchedAt: Date.now(),
          }).catch(() => {
            // Cache is best-effort; the confirmation above already rendered.
          });
        }
        // 招待先確認へ到達した場合も案内済み (idempotent server-side).
        await markRef.current().catch(() => {
          // Guide marking must never block the confirmation.
        });
      } catch (cause) {
        if (!alive) return;
        if (cause instanceof QueryError && cause.status === 404) {
          setPhase('not-found');
          return;
        }
        // Network/offline: fall back to the cached resolution so a relaunch
        // still shows WHO it was, labelled with 取得時点.
        let row = null;
        if (storage !== null) {
          row = await loadPendingInvitation(storage, accountId).catch(() => null);
        }
        if (!alive) return;
        const resolutionCache = row !== null && row.token === token ? row.resolution ?? null : null;
        if (resolutionCache !== null && resolutionCache.status === 'valid') {
          setCached({
            inviter: resolutionCache.inviter,
            fetchedAt: resolutionCache.fetchedAt,
          });
          setPhase('cached');
        } else {
          setPhase('network-error');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [
    valid,
    token,
    auth.status,
    auth.registration,
    accountId,
    storage,
    attempt,
  ]);

  // 申請 (本人が申請を押す): Task-4 `request` with the invitation token,
  // through the queue — the same offline-capable path as other sends.
  const bindings = useMemo(() => {
    if (accountId === null || storage === null) return null;
    try {
      const queue = createSyncQueue({
        store: storage,
        clock: { now: () => Date.now() },
        random: Math.random,
      });
      const api = createCommandApi();
      const worker = createSyncWorker({ queue, api, accountId });
      return { queue, worker };
    } catch {
      // No client/config: apply stays unavailable with an explained state.
      return null;
    }
  }, [accountId, storage]);

  const apply = useCallback(async () => {
    if (bindings === null || resolution === null || applyBusyRef.current) return;
    if (resolution.status !== 'valid') return;
    applyBusyRef.current = true; // synchronous double-tap guard
    setApplyState('sending');
    setApplyMessage(null);
    try {
      const { operation } = await bindings.queue.enqueue({
        accountId: accountId as string,
        kind: 'request',
        payload: {
          target_user_id: resolution.inviter.userId,
          invitation_token: token,
        },
      });
      try {
        await bindings.worker.runUntilIdle();
      } catch {
        // A failed attempt stays 送信待ち in the queue; nothing to undo.
      }
      const row =
        storage !== null
          ? await getOperation(storage, accountId as string, operation.operationId).catch(() => null)
          : null;
      if (row !== null && row.state === 'succeeded') {
        setApplyState('sent');
      } else {
        setApplyState('queued');
      }
    } catch (cause) {
      setApplyState('failed');
      setApplyMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      applyBusyRef.current = false;
    }
  }, [bindings, resolution, accountId, storage, token]);

  const toFriends = useCallback(() => router.replace('/friends/add'), [router]);

  return (
    <Screen title="招待" testID="invitation-screen">
      {phase === 'auth-loading' && (
        <Text style={styles.state} testID="invitation-loading">
          読み込み中…
        </Text>
      )}

      {phase === 'invalid' && (
        <View style={styles.block}>
          <StatusNotice
            tone="error"
            title="招待リンクを読み取れませんでした"
            message="元の招待リンクを開き直してください。うまくいかない場合は、User IDで相手を探せます。"
            testID="invitation-invalid"
          />
          {auth.registration === 'registered' && (
            <Button label="User IDで検索する" variant="secondary" testID="invitation-invalid-search" onPress={toFriends} />
          )}
        </View>
      )}

      {phase === 'auth-error' && (
        <View style={styles.block}>
          <StatusNotice
            tone="error"
            title="ログイン状態を確認できません"
            message={auth.error ?? '通信に失敗しました。'}
            testID="invitation-auth-error"
          />
          <Button label="再試行" variant="secondary" testID="invitation-auth-retry" onPress={() => void auth.refresh()} />
        </View>
      )}

      {phase === 'need-login' && (
        <View style={styles.block}>
          <StatusNotice
            tone="info"
            title="招待を確認するにはログインが必要です"
            message="招待はこの端末に保存してあります。ログインすると相手を確認できます。"
            testID="invitation-need-login"
          />
          <Button label="ログインして続ける" testID="invitation-login" onPress={() => router.push('/login')} />
        </View>
      )}

      {phase === 'need-register' && (
        <View style={styles.block}>
          <StatusNotice
            tone="info"
            title="招待を確認するには登録が必要です"
            message="User IDを確定すると、招待した相手を確認できます。招待は端末に保存済みです。"
            testID="invitation-need-register"
          />
          <Button label="登録して続ける" testID="invitation-register" onPress={() => router.push('/register')} />
        </View>
      )}

      {phase === 'resolving' && (
        <Text style={styles.state} testID="invitation-resolving">
          招待を確認しています…
        </Text>
      )}

      {phase === 'not-found' && (
        <View style={styles.block}>
          <StatusNotice
            tone="warning"
            title="この招待は見つかりませんでした"
            message="招待が新しいものに変わっているか、無効になっています。元のリンクを開き直すか、User IDで相手を探してください。"
            testID="invitation-not-found"
          />
          <Button label="User IDで検索する" variant="secondary" testID="invitation-notfound-search" onPress={toFriends} />
        </View>
      )}

      {phase === 'network-error' && (
        <View style={styles.block}>
          <StatusNotice
            tone={defaultIsOnline() ? 'error' : 'warning'}
            title={defaultIsOnline() ? '招待を確認できませんでした' : 'オフラインのため招待を確認できません'}
            message="接続が戻ったら再試行してください。招待は端末に保存してあります。"
            testID="invitation-network-error"
          />
          <Button label="再試行" variant="secondary" testID="invitation-retry" onPress={() => setAttempt((value) => value + 1)} />
        </View>
      )}

      {phase === 'cached' && cached !== null && (
        <View style={styles.block}>
          <StatusNotice
            tone="warning"
            title="オフラインのため、前回取得した内容を表示しています"
            message="現在の有効性は未確認です。接続後に再試行してください。"
            testID="invitation-cached"
          />
          <InviterCard inviter={cached.inviter} />
          <Text style={styles.meta} testID="invitation-cached-at">{`取得時点 ${formatStamp(cached.fetchedAt)}`}</Text>
          <Button label="再試行" variant="secondary" testID="invitation-cached-retry" onPress={() => setAttempt((value) => value + 1)} />
        </View>
      )}

      {phase === 'resolved' && resolution !== null && (
        <View style={styles.block}>
          <InviterCard inviter={resolution.inviter} />

          {resolution.status === 'valid' && (
            <>
              <Text style={styles.meta} testID="invitation-expires">{`有効期限 ${formatStamp(Date.parse(resolution.expiresAt))}`}</Text>
              <Text style={styles.hint} testID="invitation-apply-hint">
                招待で相手を確認しました。友達になるには申請を送ります。
              </Text>
              <Button
                label={applyState === 'sending' ? '送信中…' : '友達申請をする'}
                testID="invitation-apply"
                busy={applyState === 'sending'}
                disabled={applyState === 'sending' || bindings === null}
                onPress={() => void apply()}
              />
              {bindings === null && (
                <Text style={styles.meta} testID="invitation-apply-unavailable">
                  保存領域が利用できないため申請を送信できません。
                </Text>
              )}
              {applyState === 'sent' && (
                <StatusNotice
                  tone="info"
                  title="申請を送信しました"
                  message="相手の承認をお待ちください。状況は「申請」画面で確認できます。"
                  testID="invitation-apply-sent"
                />
              )}
              {applyState === 'queued' && (
                <StatusNotice
                  tone="info"
                  title="申請を送信待ちに追加しました"
                  message="接続が戻ると自動で送信されます。状況は「送信状況」で確認できます。"
                  testID="invitation-apply-queued"
                />
              )}
              {applyState === 'failed' && (
                <StatusNotice
                  tone="error"
                  title="申請を送信できませんでした"
                  message={applyMessage ?? 'サーバーがこの申請を受け付けませんでした。'}
                  testID="invitation-apply-failed"
                />
              )}
            </>
          )}

          {resolution.status === 'invalidated' && (
            <StatusNotice
              tone="warning"
              title="この招待は無効になりました"
              message="再発行などで新しい招待が発行されています。相手に新しい招待をもらってください。"
              testID="invitation-invalidated"
            />
          )}

          {resolution.status === 'expired' && (
            <StatusNotice
              tone="warning"
              title="この招待は期限切れです"
              message="招待の有効期間(7日間)を過ぎています。相手に新しい招待をもらってください。"
              testID="invitation-expired"
            />
          )}

          {(resolution.status === 'invalidated' || resolution.status === 'expired') && (
            <Button label="User IDで検索する" variant="secondary" testID="invitation-dead-search" onPress={toFriends} />
          )}
        </View>
      )}
    </Screen>
  );
}

function InviterCard({ inviter }: { inviter: { displayName: string; userIdText: string } }) {
  const { tokens } = useTheme();
  const styles = makeStyles(tokens);
  return (
    <View style={styles.card} testID="invitation-inviter">
      <View style={styles.avatar}>
        <Text style={styles.avatarText} allowFontScaling>
          {inviter.displayName.slice(0, 1)}
        </Text>
      </View>
      <View style={styles.identity}>
        <Text style={styles.name} testID="invitation-inviter-name" allowFontScaling>
          {inviter.displayName}
        </Text>
        <Text style={styles.userId} testID="invitation-inviter-userid" allowFontScaling>
          {inviter.userIdText}
        </Text>
      </View>
    </View>
  );
}

/** `MM/DD HH:MM` in local time (端末の現地時刻); a dash for bad input. */
export function formatStamp(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '—';
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const makeStyles = (tokens: {
  text: string;
  muted: string;
  line: string;
  soft: string;
  avatar: string;
  avatarInk: string;
}) =>
  StyleSheet.create({
    block: {
      gap: spacing.s3,
    },
    state: {
      fontSize: typography.sizes.bodyLarge,
      textAlign: 'center',
      paddingVertical: spacing.s5,
      color: tokens.muted,
    },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.s3,
      borderWidth: 1,
      borderColor: tokens.line,
      borderRadius: radius.md,
      padding: spacing.s3,
      backgroundColor: tokens.soft,
    },
    avatar: {
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tokens.avatar,
    },
    avatarText: {
      fontSize: typography.sizes.title,
      fontWeight: typography.weights.semibold,
      color: tokens.avatarInk,
    },
    identity: {
      flex: 1,
      gap: spacing.s1,
    },
    name: {
      fontSize: typography.sizes.bodyLarge,
      fontWeight: typography.weights.semibold,
      color: tokens.text,
      lineHeight: typography.sizes.bodyLarge * typography.lineHeightRatio,
    },
    userId: {
      fontSize: typography.sizes.small,
      color: tokens.muted,
      lineHeight: typography.sizes.small * typography.lineHeightRatio,
    },
    meta: {
      fontSize: typography.sizes.small,
      color: tokens.muted,
    },
    hint: {
      fontSize: typography.sizes.caption,
      color: tokens.muted,
      lineHeight: typography.sizes.caption * typography.lineHeightRatio,
    },
  });
