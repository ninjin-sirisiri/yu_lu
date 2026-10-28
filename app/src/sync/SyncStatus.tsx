import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Storage } from '../storage/database';
import { listOperations, type OutboxRecord } from '../storage/outbox';
import { useTheme } from '../theme/provider';
import { radius, spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { StatusNotice } from '../ui/StatusNotice';
import type { QueueState } from './types';

// Task 13: the shared "共通送信状況" view — one row per STORED operation.
//
// Ownership: rendering a queue row's latest state, its content, its next
// attempt time and its 24-hour sending deadline, plus the two actions the
// spec allows from this screen:
//
// - 送信待ち取消 (cancel an operation the server has never started
//   receiving) → `onCancelUnsent`; the screen resolves it through
//   `queue.cancelUnsent`, whose guarded UPDATE settles the race with a
//   concurrent claim.
// - 24時間超過 / 個別失敗 の再送 (onRetryAsNew) → an inline confirmation
//   first, because the re-send must be a NEW operation with a NEW
//   operation id (新しい操作IDでの再送) and must NEVER silently swap the
//   stored payload's request_id: the confirmation shows the stored content
//   and the screen re-sends it verbatim via `queue.retryAsNew`.
//
// 結果確認中 (sent_unknown) deliberately has NO action: it was already
// written to the wire once and is confirmed by re-sending the SAME
// operation id — 24時間超過だけで未実行と断定しない, so the row never shows
// a deadline countdown or a "resend as new" button.

/** States that mean "this account still has unfinished send work". */
export const UNFINISHED_STATES: readonly string[] = [
  'pending',
  'sending',
  'sent_unknown',
  'relationship_stopped',
  'failed_permanent',
  'needs_confirmation',
];

export function isUnfinishedState(state: string): boolean {
  return UNFINISHED_STATES.includes(state);
}

/** Filters stored rows down to the ones the 未完了件数 counts. */
export function unfinishedOperations(rows: OutboxRecord[]): OutboxRecord[] {
  return rows.filter((row) => isUnfinishedState(row.state));
}

export function unfinishedCount(rows: OutboxRecord[]): number {
  return unfinishedOperations(rows).length;
}

/**
 * 未完了件数入口 for screens (マイページ, 申請). A missing account/storage is
 * 0 — never an error and never an invented number.
 */
export async function countUnfinishedOperations(
  storage: Storage | null,
  accountId: string | null,
): Promise<number> {
  if (storage === null || accountId === null || accountId === '') return 0;
  try {
    return unfinishedCount(await listOperations(storage, accountId));
  } catch {
    return 0;
  }
}

const KIND_LABELS: Record<string, string> = {
  send_message: 'メッセージの送信',
  request: '申請の送信',
  approve: '申請の承認',
  reject: '申請の拒否',
  cancel: '申請の取り消し',
  update_profile: 'プロフィールの更新',
  register: 'User IDの登録',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

const STATE_LABELS: Record<QueueState, string> = {
  pending: '送信待ち',
  sending: '送信中',
  sent_unknown: '結果確認中',
  relationship_stopped: '送信停止・結果未確認',
  succeeded: '完了',
  failed_permanent: '不成立',
  needs_confirmation: '確認が必要',
  cancelled: '取り消し済み',
  superseded: '置き換え済み',
};

export function queueStateLabel(state: string): string {
  return STATE_LABELS[state as QueueState] ?? state;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `MM/DD HH:MM` in the device's local time. */
export function formatSyncStamp(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/** The stored payload rendered as visible content (内容の確認). */
export function payloadSummary(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return '';
  const entries = Object.entries(payload as Record<string, unknown>)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 4);
  if (entries.length === 0) return '';
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(' / ');
}

export interface SyncStatusProps {
  /** Unfinished operations (the screen filters with {@link unfinishedOperations}). */
  operations: OutboxRecord[];
  /** 送信待ち取消 — the screen calls `queue.cancelUnsent`. */
  onCancelUnsent?: (operation: OutboxRecord) => void;
  /** 確認付き再送 — the screen calls `queue.retryAsNew` (fresh operation id). */
  onRetryAsNew?: (operation: OutboxRecord) => void;
  /** Operation ids with an in-flight action (buttons disabled). */
  busyIds?: ReadonlySet<string>;
  emptyText?: string;
  testID?: string;
}

export function SyncStatus({
  operations,
  onCancelUnsent,
  onRetryAsNew,
  busyIds,
  emptyText,
  testID = 'sync-status',
}: SyncStatusProps) {
  const { tokens } = useTheme();
  const [confirming, setConfirming] = useState<string | null>(null);

  const isBusy = (operationId: string): boolean => busyIds?.has(operationId) === true;

  const renderConfirm = (operation: OutboxRecord) => (
    <View
      style={[styles.confirm, { backgroundColor: tokens.soft, borderColor: tokens.line }]}
      testID="sync-retry-confirm"
    >
      <Text style={[styles.confirmTitle, { color: tokens.text }]} allowFontScaling>
        この内容のまま新しい操作として送り直します
      </Text>
      <Text style={[styles.content, { color: tokens.text }]} allowFontScaling>
        {payloadSummary(operation.payload)}
      </Text>
      <Text style={[styles.message, { color: tokens.muted }]} allowFontScaling>
        以前の操作は履歴に残り、request_id は変わりません。
      </Text>
      <View style={styles.confirmActions}>
        <Button
          label="送り直す"
          testID="sync-retry-yes"
          busy={isBusy(operation.operationId)}
          onPress={() => {
            // Only this button starts the new operation; dismissing the
            // confirmation leaves the stored operation untouched.
            setConfirming(null);
            onRetryAsNew?.(operation);
          }}
          style={styles.confirmButton}
        />
        <Button
          label="やめる"
          variant="secondary"
          testID="sync-retry-no"
          onPress={() => setConfirming(null)}
          style={styles.confirmButton}
        />
      </View>
    </View>
  );

  const renderRow = (operation: OutboxRecord) => {
    const { state } = operation;
    const cancellable = state === 'pending' || state === 'needs_confirmation';
    const retryable = state === 'needs_confirmation' || state === 'failed_permanent';
    const summary = payloadSummary(operation.payload);
    const attemptsLine =
      operation.attempts > 0 ? `送信試行 ${String(operation.attempts)}回` : null;

    return (
      <View
        key={operation.operationId}
        style={[styles.row, { borderColor: tokens.line, backgroundColor: tokens.soft }]}
        testID={`sync-row-${operation.operationId}`}
      >
        <View style={styles.headerRow}>
          <Text style={[styles.kind, { color: tokens.text }]} testID={`sync-kind-${operation.operationId}`} allowFontScaling>
            {kindLabel(operation.kind)}
          </Text>
          <Text
            style={[styles.state, { color: tokens.text, backgroundColor: tokens.accentSoft }]}
            testID={`sync-state-${operation.operationId}`}
            allowFontScaling
          >
            {queueStateLabel(state)}
          </Text>
        </View>

        {summary !== '' && (
          <Text style={[styles.content, { color: tokens.text }]} testID={`sync-content-${operation.operationId}`} allowFontScaling>
            {`内容: ${summary}`}
          </Text>
        )}

        {state === 'pending' && (
          <>
            {operation.nextAttemptAt !== null && (
              <Text style={[styles.meta, { color: tokens.muted }]} testID={`sync-next-${operation.operationId}`} allowFontScaling>
                {`次回の再試行 ${formatSyncStamp(operation.nextAttemptAt)}`}
              </Text>
            )}
            <Text style={[styles.meta, { color: tokens.muted }]} testID={`sync-deadline-${operation.operationId}`} allowFontScaling>
              {`送信待ち期限 ${formatSyncStamp(operation.expiresAt)}`}
            </Text>
            <Text style={[styles.message, { color: tokens.muted }]} allowFontScaling>
              24時間以内に送信されない場合、自動送信は停止して確認を求めます。
            </Text>
          </>
        )}

        {state === 'sending' && (
          <Text style={[styles.message, { color: tokens.muted }]} allowFontScaling>
            送信しています…
          </Text>
        )}

        {state === 'sent_unknown' && (
          <>
            <Text style={[styles.message, { color: tokens.muted }]} testID={`sync-unknown-${operation.operationId}`} allowFontScaling>
              送信済みです。結果を確認しているため、24時間が過ぎても未送信とは扱いません。
            </Text>
            {attemptsLine !== null && (
              <Text style={[styles.meta, { color: tokens.muted }]} allowFontScaling>
                {attemptsLine}
              </Text>
            )}
          </>
        )}

        {state === 'failed_permanent' && (
          <>
            <Text style={[styles.message, { color: tokens.danger }]} testID={`sync-reason-${operation.operationId}`} allowFontScaling>
              サーバーがこの操作を受け付けませんでした。内容を確認してください。
            </Text>
            {attemptsLine !== null && (
              <Text style={[styles.meta, { color: tokens.muted }]} allowFontScaling>
                {attemptsLine}
              </Text>
            )}
          </>
        )}

        {state === 'needs_confirmation' && (
          <>
            <Text style={[styles.message, { color: tokens.muted }]} testID={`sync-overdue-${operation.operationId}`} allowFontScaling>
              送信待ち期限（24時間）を過ぎたため自動では送信しません。内容と最新の状態を確認して、新しい操作として送り直してください。
            </Text>
            <Text style={[styles.meta, { color: tokens.muted }]} allowFontScaling>
              {`期限 ${formatSyncStamp(operation.expiresAt)}`}
            </Text>
            {attemptsLine !== null && (
              <Text style={[styles.meta, { color: tokens.muted }]} allowFontScaling>
                {attemptsLine}
              </Text>
            )}
          </>
        )}

        {(cancellable || retryable) && confirming !== operation.operationId && (
          <View style={styles.actions}>
            {cancellable && (
              <Button
                label="送信待ちを取り消す"
                variant="secondary"
                testID={`sync-cancel-${operation.operationId}`}
                disabled={isBusy(operation.operationId)}
                onPress={() => onCancelUnsent?.(operation)}
                style={styles.actionButton}
              />
            )}
            {retryable && (
              <Button
                label="内容を確認して送り直す"
                testID={`sync-retry-${operation.operationId}`}
                disabled={isBusy(operation.operationId)}
                onPress={() => setConfirming(operation.operationId)}
                style={styles.actionButton}
              />
            )}
          </View>
        )}

        {confirming === operation.operationId && renderConfirm(operation)}
      </View>
    );
  };

  return (
    <View style={styles.root} testID={testID}>
      {operations.length === 0 ? (
        <Text style={[styles.empty, { color: tokens.muted }]} testID={`${testID}-empty`} allowFontScaling>
          {emptyText ?? '未完了の送信はありません'}
        </Text>
      ) : (
        operations.map(renderRow)
      )}
    </View>
  );
}

/** Shared error block for the sync screen (再試行 supplied by the screen). */
export function SyncErrorNotice({
  error,
  testID = 'sync-error',
}: {
  error: 'offline' | 'network';
  testID?: string;
}) {
  if (error === 'offline') {
    return (
      <StatusNotice
        tone="warning"
        title="オフラインのため送信状況を取得できません"
        message="接続後に再読み込みしてください。"
        testID={testID}
      />
    );
  }
  return <StatusNotice tone="error" title="送信状況を読み込めませんでした" testID={testID} />;
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.s3,
    paddingBottom: spacing.s4,
  },
  empty: {
    fontSize: typography.sizes.bodyLarge,
    textAlign: 'center',
    paddingVertical: spacing.s5,
  },
  row: {
    gap: spacing.s1,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.s3,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.s2,
  },
  kind: {
    fontSize: typography.sizes.bodyLarge,
    fontWeight: typography.weights.semibold,
  },
  state: {
    fontSize: typography.sizes.caption,
    fontWeight: typography.weights.bold,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.s2,
    paddingVertical: spacing.s1,
    overflow: 'hidden',
  },
  content: {
    fontSize: typography.sizes.small,
    lineHeight: typography.sizes.small * typography.lineHeightRatio,
  },
  meta: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  message: {
    fontSize: typography.sizes.small,
    lineHeight: typography.sizes.small * typography.lineHeightRatio,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.s2,
    paddingTop: spacing.s1,
  },
  actionButton: {
    flexGrow: 1,
  },
  confirm: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.s3,
    gap: spacing.s2,
  },
  confirmTitle: {
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: spacing.s2,
  },
  confirmButton: {
    flex: 1,
  },
});
