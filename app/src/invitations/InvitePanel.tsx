// Task 14: 招待パネル — the INVITER side (友達追加画面の自分の招待QR・リンク共有).
//
// Ownership: turning the actor's own invitation (app-query
// `get_invitation_status` + app-command `get_or_create_invitation` /
// `reissue_invitation`) into a shareable link + QR:
//
// - **Reuse**: a valid link is displayed as-is (no new command on mount).
// - **Issue**: status `none` shows an explicit 発行 button; `expired` /
//   `invalidated` auto-issues a new one (期限切れ時に新規発行する).
// - **Reissue**: 手動再発行は確認して実行し、以前の招待を無効化する — an
//   inline confirmation block, a synchronous double-tap guard and a
//   sequence counter so a stale status response can never clobber the
//   freshly reissued link (再発行競合).
// - **Offline**: the last successful result is cached account-scoped
//   (storage/cache, with fetched_at); offline shows the cached link with
//   取得時点 and never claims current validity. 新規発行・再発行はオンライン
//   で行う — offline disables both with an explanation.
// - **QR**: the matrix comes from the URL (links.buildQrMatrix) and is
//   rendered as ONE react-native-svg Path (quiet zone included).
//
// All network/QR-origin failures surface as StatusNotice text; nothing
// here throws at the caller (復元不能でも登録を止めない).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Svg, { Path, Rect } from 'react-native-svg';

import { getInvitationStatus, type OwnInvitationStatus } from '../backend/queries';
import { useImportantConfirmation } from '../appearance/visibility';
import { defaultIsOnline } from '../discovery/searchController';
import { readCache, writeCache } from '../storage/cache';
import type { Storage } from '../storage/database';
import { randomId } from '../storage/database';
import { createCommandApi, type CommandApi, type CommandOutcome } from '../sync/api';
import { useTheme } from '../theme/provider';
import { radius, spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { StatusNotice } from '../ui/StatusNotice';
import { buildInvitationUrl, buildQrMatrix } from './links';

/** Account-scoped cache key for the actor's own invitation. */
export const INVITE_CACHE_KEY = 'invitation.mine';

export interface IssuedInvitation {
  token: string;
  expiresAt: string;
}

/** Thrown by issue/reissue helpers; `retryable` mirrors the queue's rules. */
export class InvitationCommandError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'InvitationCommandError';
    this.retryable = retryable;
  }
}

function parseIssued(outcome: CommandOutcome): IssuedInvitation {
  if (outcome.status !== 'ok') {
    throw new InvitationCommandError(
      outcome.message || '招待リンクを更新できませんでした。',
      outcome.status === 'transient' || outcome.status === 'unknown',
    );
  }
  const result = (outcome.data?.result ?? null) as
    | { invitation_token?: unknown; expires_at?: unknown }
    | null;
  if (
    result === null ||
    typeof result !== 'object' ||
    typeof result.invitation_token !== 'string' ||
    typeof result.expires_at !== 'string'
  ) {
    throw new InvitationCommandError('サーバーの応答を確認できませんでした。', true);
  }
  return { token: result.invitation_token, expiresAt: result.expires_at };
}

/** get_or_create_invitation: reuses a valid link, mints one otherwise. */
export async function issueInvitation(api: CommandApi, accountId: string): Promise<IssuedInvitation> {
  const outcome = await api.send({
    accountId,
    operationId: randomId(),
    kind: 'get_or_create_invitation',
    payload: {},
  });
  return parseIssued(outcome);
}

/** reissue_invitation: invalidates every live link and mints a new one. */
export async function reissueOwnInvitation(
  api: CommandApi,
  accountId: string,
): Promise<IssuedInvitation> {
  const outcome = await api.send({
    accountId,
    operationId: randomId(),
    kind: 'reissue_invitation',
    payload: {},
  });
  return parseIssued(outcome);
}

export interface InvitePanelProps {
  /** Account the invitation belongs to (from the auth context). */
  accountId: string | null;
  /** Account storage for the offline cache; null disables caching. */
  storage: Storage | null;
  /** Injected seams (tests); defaults use the real query/command boundary. */
  fetchStatus?: () => Promise<OwnInvitationStatus>;
  issue?: (accountId: string) => Promise<IssuedInvitation>;
  reissue?: (accountId: string) => Promise<IssuedInvitation>;
  buildUrl?: (token: string) => string;
  now?: () => number;
  testID?: string;
}

interface ReadyState {
  kind: 'ready';
  token: string;
  expiresAt: string;
  /** Local epoch of the data being shown. */
  fetchedAt: number;
  /** True when showing the cache (data may be stale — label 取得時点). */
  offline: boolean;
}

type PanelState =
  | { kind: 'loading' }
  | { kind: 'issue-needed' }
  | { kind: 'issuing' }
  | ReadyState
  | { kind: 'error'; message: string; retryable: boolean };

interface CachePayload {
  token: string;
  expiresAt: string;
}

export function InvitationPanel({
  accountId,
  storage,
  fetchStatus,
  issue,
  reissue,
  buildUrl,
  now,
  testID = 'invite-panel',
}: InvitePanelProps) {
  const { tokens } = useTheme();
  const styles = makeStyles(tokens);
  const doFetchStatus = fetchStatus ?? (() => getInvitationStatus());
  const doIssue = issue ?? ((id: string) => issueInvitation(createDefaultApi(), id));
  const doReissue = reissue ?? ((id: string) => reissueOwnInvitation(createDefaultApi(), id));
  const build = buildUrl ?? ((token: string) => buildInvitationUrl(token));
  const clock = now ?? (() => Date.now());

  const [state, setState] = useState<PanelState>({ kind: 'loading' });
  const [confirmReissue, setConfirmReissue] = useState(false);
  // Task 14: reissue invalidates a live link; block 演出 while it is open.
  useImportantConfirmation(confirmReissue);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Synchronous double-tap guard: written BEFORE the first await so two
  // taps in the same frame can never start two reissues (再発行競合).
  const busyRef = useRef(false);
  // Sequence counter: responses of an older fetch/reissue are discarded so
  // a stale status can never overwrite a freshly reissued link.
  const seqRef = useRef(0);

  // Local alias for the imported storage/cache write — NOT shadowing it
  // (a same-named local would recursively call itself instead of the cache).
  const persistCache = useCallback(
    (issued: IssuedInvitation, fetchedAt: number) => {
      if (storage === null || accountId === null) return;
      void writeCache(
        storage,
        accountId,
        INVITE_CACHE_KEY,
        { token: issued.token, expiresAt: issued.expiresAt } satisfies CachePayload,
        fetchedAt,
      ).catch(() => {
        // Cache is best-effort: a write failure must not break the panel.
      });
    },
    [storage, accountId],
  );

  const applyIssued = useCallback(
    (issued: IssuedInvitation, offline: boolean) => {
      const fetchedAt = clock();
      setState({ kind: 'ready', token: issued.token, expiresAt: issued.expiresAt, fetchedAt, offline });
      persistCache(issued, fetchedAt);
    },
    [clock, persistCache],
  );

  const readCached = useCallback(async (): Promise<ReadyState | null> => {
    if (storage === null || accountId === null) return null;
    try {
      const record = await readCache<CachePayload>(storage, accountId, INVITE_CACHE_KEY);
      if (record === null) return null;
      const payload = record.payload;
      if (typeof payload?.token !== 'string' || typeof payload.expiresAt !== 'string') return null;
      return {
        kind: 'ready',
        token: payload.token,
        expiresAt: payload.expiresAt,
        fetchedAt: record.fetchedAt,
        offline: true,
      };
    } catch {
      return null;
    }
  }, [storage, accountId]);

  const runIssue = useCallback(
    async (seq: number): Promise<void> => {
      if (busyRef.current || accountId === null) return;
      busyRef.current = true;
      setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'issuing' }));
      try {
        const issued = await doIssue(accountId);
        if (seqRef.current !== seq) return; // stale: a newer action won
        applyIssued(issued, false);
      } catch (cause) {
        if (seqRef.current !== seq) return;
        const cached = await readCached();
        if (cached !== null) {
          setState(cached);
        } else {
          setState({
            kind: 'error',
            message: cause instanceof Error ? cause.message : '招待リンクを発行できませんでした。',
            retryable: true,
          });
        }
      } finally {
        busyRef.current = false;
      }
    },
    [accountId, applyIssued, doIssue, readCached],
  );

  // Mount: show the cache instantly, then fetch the authoritative status.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const seq = ++seqRef.current;
      const cached = await readCached();
      if (!alive || seqRef.current !== seq) return;
      if (cached !== null) setState(cached); // instant offline-capable view
      try {
        const status = await doFetchStatus();
        if (!alive || seqRef.current !== seq) return; // stale vs reissue etc.
        if (status.status === 'valid' && status.invitationToken !== null) {
          applyIssued(
            { token: status.invitationToken, expiresAt: status.expiresAt },
            false,
          );
          return;
        }
        if (status.status === 'expired' || status.status === 'invalidated') {
          // 期限切れ時に新規発行する — mint a replacement automatically.
          await runIssue(seq);
          return;
        }
        // status === 'none': explicit user action, no surprise command.
        if (cached === null) setState({ kind: 'issue-needed' });
      } catch (cause) {
        if (!alive || seqRef.current !== seq) return;
        if (cached !== null) {
          // Offline (or network failure) with a cache: show 取得時点 data.
          setState(cached);
        } else {
          setState({
            kind: 'error',
            message: cause instanceof Error ? cause.message : '招待情報を読み込めませんでした。',
            retryable: defaultIsOnline(),
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
    // attempt gates the retry button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const runReissue = useCallback(async () => {
    if (busyRef.current || accountId === null || state.kind !== 'ready') return;
    const seq = ++seqRef.current;
    busyRef.current = true;
    setConfirmReissue(false);
    setCopied(false);
    try {
      const issued = await doReissue(accountId);
      if (seqRef.current !== seq) return;
      applyIssued(issued, false);
    } catch (cause) {
      if (seqRef.current !== seq) return;
      setState({
        kind: 'error',
        message: cause instanceof Error ? cause.message : '再発行できませんでした。',
        retryable: true,
      });
    } finally {
      busyRef.current = false;
    }
  }, [accountId, state.kind, applyIssued, doReissue]);

  const copyLink = useCallback(
    async (url: string) => {
      try {
        await Clipboard.setStringAsync(url);
        setCopied(true);
      } catch {
        setCopied(false);
      }
    },
    [],
  );

  const shareLink = useCallback(async (url: string) => {
    try {
      await Share.share({ message: url, url });
    } catch {
      // Share sheet unavailable: the copy button remains as fallback.
    }
  }, []);

  // URL/QR origin: fail CLEARLY when EXPO_PUBLIC_INVITE_ORIGIN is missing —
  // never a fabricated domain.
  const urlInfo = (() => {
    if (state.kind !== 'ready') return { url: null as string | null, error: null as string | null };
    try {
      return { url: build(state.token), error: null };
    } catch (cause) {
      return { url: null, error: cause instanceof Error ? cause.message : '招待URLを作成できません。' };
    }
  })();

  const qr = useMemo(() => {
    if (urlInfo.url === null) return null;
    try {
      return buildQrMatrix(urlInfo.url);
    } catch {
      return null; // QR generation failure degrades to link-only display.
    }
  }, [urlInfo.url]);

  return (
    <View style={styles.root} testID={testID}>
      {state.kind === 'loading' && (
        <Text style={[styles.hint, { color: tokens.muted }]} testID="invite-loading">
          招待リンクを読み込んでいます…
        </Text>
      )}

      {state.kind === 'issuing' && (
        <Text style={[styles.hint, { color: tokens.muted }]} testID="invite-issuing">
          招待リンクを作成しています…
        </Text>
      )}

      {state.kind === 'issue-needed' && (
        <View style={styles.block}>
          <Text style={[styles.hint, { color: tokens.muted }]} testID="invite-none">
            まだ招待リンクがありません。
          </Text>
          <Button
            label="招待リンクを発行"
            testID="invite-issue"
            onPress={() => void runIssue(++seqRef.current)}
          />
        </View>
      )}

      {state.kind === 'error' && (
        <View style={styles.block}>
          <StatusNotice
            tone="error"
            title="招待リンクを読み込めませんでした"
            message={state.message}
            testID="invite-error"
          />
          {state.retryable && (
            <Button
              label="再試行"
              variant="secondary"
              testID="invite-retry"
              onPress={() => setAttempt((value) => value + 1)}
            />
          )}
        </View>
      )}

      {state.kind === 'ready' && (
        <View style={styles.block}>
          {state.offline && (
            <StatusNotice
              tone="warning"
              title="オフラインのため取得時点の表示です"
              message={`${formatFetchedAt(state.fetchedAt)} に取得した招待です。現在の有効性は開いた側で確認されます。`}
              testID="invite-offline"
            />
          )}

          {urlInfo.error !== null ? (
            <StatusNotice
              tone="error"
              title="招待URLを作成できません"
              message={urlInfo.error}
              testID="invite-origin-error"
            />
          ) : (
            <>
              <Text style={[styles.url, { color: tokens.text }]} selectable testID="invite-url">
                {urlInfo.url}
              </Text>
              {qr !== null && (
                <View style={styles.qrBox}>
                  <Svg
                    testID="invite-qr"
                    width={168}
                    height={168}
                    viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
                  >
                    <Rect x={0} y={0} width={qr.size + 8} height={qr.size + 8} fill="#ffffff" />
                    <Path d={qrPath(qr.modules)} fill="#000000" />
                  </Svg>
                </View>
              )}
              <Text style={[styles.expiry, { color: tokens.muted }]} testID="invite-expiry">
                {`有効期限 ${formatFetchedAt(Date.parse(state.expiresAt))}`}
              </Text>
              {copied && (
                <Text style={[styles.hint, { color: tokens.accent }]} testID="invite-copied">
                  リンクをコピーしました
                </Text>
              )}
              <View style={styles.row}>
                <Button
                  label="リンクをコピー"
                  variant="secondary"
                  testID="invite-copy"
                  onPress={() => void (urlInfo.url !== null && copyLink(urlInfo.url))}
                />
                <Button
                  label="共有"
                  variant="secondary"
                  testID="invite-share"
                  onPress={() => void (urlInfo.url !== null && shareLink(urlInfo.url))}
                />
              </View>
            </>
          )}

          {!state.offline && !confirmReissue && (
            <Button
              label="招待リンクを再発行"
              variant="ghost"
              testID="invite-reissue"
              onPress={() => setConfirmReissue(true)}
            />
          )}

          {confirmReissue && (
            <View style={styles.confirm} testID="invite-reissue-confirm">
              <Text style={[styles.confirmText, { color: tokens.text }]}>
                再発行すると、いまの招待リンクは無効になります。よろしいですか？
              </Text>
              <View style={styles.row}>
                <Button
                  label="再発行する"
                  testID="invite-reissue-yes"
                  onPress={() => void runReissue()}
                />
                <Button
                  label="やめる"
                  variant="secondary"
                  testID="invite-reissue-no"
                  onPress={() => setConfirmReissue(false)}
                />
              </View>
            </View>
          )}

          {state.offline && (
            <Text style={[styles.hint, { color: tokens.muted }]} testID="invite-offline-hint">
              新規発行・再発行はオンラインで実行できます。
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

/** Default command port, built lazily so config errors surface per call. */
function createDefaultApi(): CommandApi {
  return createCommandApi();
}

/** Builds one SVG path data string from the dark modules (single element). */
export function qrPath(modules: boolean[][]): string {
  let d = '';
  for (let row = 0; row < modules.length; row += 1) {
    for (let col = 0; col < modules[row].length; col += 1) {
      if (modules[row][col]) d += `M${col} ${row}h1v1h-1z`;
    }
  }
  return d;
}

/** `MM/DD HH:MM` in local time (端末の現地時刻), or a dash for bad input. */
export function formatFetchedAt(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '—';
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const makeStyles = (tokens: { text: string; muted: string; accent: string; line: string; soft: string }) =>
  StyleSheet.create({
    root: {
      gap: spacing.s3,
      paddingVertical: spacing.s3,
    },
    block: {
      gap: spacing.s3,
    },
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.s2,
    },
    url: {
      fontSize: typography.sizes.small,
      lineHeight: typography.sizes.small * typography.lineHeightRatio,
      borderBottomWidth: 1,
      borderBottomColor: '#00000000',
    },
    qrBox: {
      alignSelf: 'flex-start',
      borderWidth: 1,
      borderColor: tokens.line,
      borderRadius: radius.sm,
      padding: spacing.s1,
      backgroundColor: '#ffffff',
    },
    expiry: {
      fontSize: typography.sizes.caption,
      lineHeight: typography.sizes.caption * typography.lineHeightRatio,
    },
    hint: {
      fontSize: typography.sizes.caption,
      lineHeight: typography.sizes.caption * typography.lineHeightRatio,
    },
    confirm: {
      gap: spacing.s2,
      borderWidth: 1,
      borderColor: tokens.line,
      borderRadius: radius.md,
      padding: spacing.s3,
      backgroundColor: tokens.soft,
    },
    confirmText: {
      fontSize: typography.sizes.small,
      lineHeight: typography.sizes.small * typography.lineHeightRatio,
    },
  });
