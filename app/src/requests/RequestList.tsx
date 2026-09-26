import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { RequestEntry, RequestStatus } from '../backend/queries';
import { useTheme } from '../theme/provider';
import { controls, radius, spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { rejectionDisplay } from './inbox';

// Task 13: the shared request list for the incoming / outgoing / ended views.
//
// Ownership: everything VISIBLE per row — the neutral status wording, the
// timestamps, the per-row actions and the inline confirmation blocks for
// 拒否 / 取消. The component takes data + callbacks only: it never talks
// to the network, the queue or the repository, so tests (and the two
// screens) can drive it with plain fixtures.
//
// Masking rules it mirrors (never re-derives):
// - the sender's `rejected` arrives as `ended` and renders with the SAME
//   neutral text the spec shows after a rejection (今回は成立しませんでした);
//   no reason field exists anywhere in the DTO, so none can leak here.
// - `ended` / `expired` / `cancelled` rows keep their end timestamp (終了
//   7日間表示) and offer an immediate re-request (表示期間は再申請の待機
//   期間ではない).
// - only `pending` rows carry actions: the recipient gets 承認 / 拒否, the
//   sender gets 取消し (受信一覧に承認・拒否を置き、プロフィールも開ける —
//   the row header opens the profile).
//
// The confirmation is a local, interruptible state: dismissing it changes
// nothing else, and actions carry a `busy` flag so a double-tap cannot
// start the same operation twice (the screen keeps a synchronous ref guard
// as the second line of defence).

export type RequestTab = 'incoming' | 'outgoing';

export type RequestActionKind = 'approve' | 'reject' | 'cancel' | 'reRequest';

/** A queued request send the server has not confirmed yet (送信待ち). */
export interface QueuedRequestRow {
  operationId: string;
  /** Target's profile snapshot — the payload only carries the uuid. */
  counterpart: RequestEntry['counterpart'];
  /** Queue state of that operation (never a terminal failure — those drop). */
  state: 'pending' | 'sending' | 'sent_unknown' | 'needs_confirmation' | 'succeeded';
}

const QUEUED_STATE_LABELS: Record<QueuedRequestRow['state'], string> = {
  pending: '送信待ち',
  sending: '送信中',
  sent_unknown: '結果確認中',
  needs_confirmation: '確認が必要',
  succeeded: 'サーバー受付済み',
};

/** Visible wording per server status; masking lives server-side (Task 4). */
export function requestStatusLabel(status: RequestStatus): string {
  switch (status) {
    case 'pending':
      return '受付中';
    case 'approved':
      return '成立';
    case 'rejected':
    case 'ended':
      // Neutral for the sender, and no reason exists to show anyway.
      return rejectionDisplay();
    case 'cancelled':
      return '取消済み';
    case 'expired':
      return '期限切れ';
    default:
      return '';
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `MM/DD HH:MM` in the device's local time (現地時刻, no Intl dependency). */
export function formatRequestStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function requestStampLine(entry: RequestEntry): string {
  if (entry.status === 'pending') return `期限 ${formatRequestStamp(entry.expiresAt)}`;
  if (entry.endedAt !== null) return `終了 ${formatRequestStamp(entry.endedAt)}`;
  return `申請 ${formatRequestStamp(entry.createdAt)}`;
}

export interface RequestListProps {
  direction: RequestTab;
  /** Server rows for this direction (pending first, then the 7-day history). */
  entries: RequestEntry[];
  /** Queued not-yet-confirmed sends (outgoing only); shown as 送信待ち rows. */
  queued?: QueuedRequestRow[];
  /** `${action}:${id}` keys with an in-flight command (buttons disabled). */
  busyKeys?: ReadonlySet<string>;
  /** One callback for every per-row action; the screen owns the wiring. */
  onAction?: (action: RequestActionKind, entry: RequestEntry) => void;
  /** Opens the counterpart's profile (受信一覧からプロフィールも開ける). */
  onOpenProfile?: (entry: RequestEntry) => void;
  /**
   * Task 19: the request a notification entry pointed at (通知から開くと
   * 対象が分かる位置を表示する) — that row gets a visible marker. Only one
   * row can match (request ids are unique), so the marker testID is stable.
   */
  focusRequestId?: string | null;
  emptyText?: string;
  testID?: string;
}

interface ConfirmState {
  requestId: string;
  action: 'reject' | 'cancel';
}

export function RequestList({
  direction,
  entries,
  queued = [],
  busyKeys,
  onAction,
  onOpenProfile,
  focusRequestId = null,
  emptyText,
  testID = 'request-list',
}: RequestListProps) {
  const { tokens } = useTheme();
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const isBusy = (key: string): boolean => busyKeys?.has(key) === true;

  const fire = (action: RequestActionKind, entry: RequestEntry): void => {
    onAction?.(action, entry);
  };

  const renderConfirm = (entry: RequestEntry, state: 'reject' | 'cancel') => (
    <View
      style={[styles.confirm, { backgroundColor: tokens.soft, borderColor: tokens.line }]}
      testID="request-confirm"
    >
      <Text style={[styles.confirmText, { color: tokens.text }]} allowFontScaling>
        {state === 'reject' ? '本当に拒否しますか？' : '本当に取り消しますか？'}
      </Text>
      <Text style={[styles.confirmHint, { color: tokens.muted }]} allowFontScaling>
        {state === 'reject'
          ? 'この申請は終了し、相手には「今回は成立しませんでした」と表示されます。'
          : '取り消すと相手には終了として表示されます。'}
      </Text>
      <View style={styles.confirmActions}>
        <Button
          label={state === 'reject' ? '拒否する' : '取り消す'}
          variant="primary"
          testID="request-confirm-yes"
          busy={isBusy(`${state}:${entry.requestId}`)}
          onPress={() => {
            // The confirmation itself is the interruptible step: only this
            // button starts the command.
            setConfirm(null);
            fire(state, entry);
          }}
          style={styles.confirmButton}
        />
        <Button
          label="やめる"
          variant="secondary"
          testID="request-confirm-no"
          onPress={() => setConfirm(null)}
          style={styles.confirmButton}
        />
      </View>
    </View>
  );

  const renderRow = (entry: RequestEntry) => {
    const confirmingThis = confirm !== null && confirm.requestId === entry.requestId;
    const focused = focusRequestId !== null && focusRequestId === entry.requestId;
    const canDecide = direction === 'incoming' && entry.status === 'pending';
    const canCancel = direction === 'outgoing' && entry.status === 'pending';
    // While this target already has an open queued send, the re-request
    // button would only invite a duplicate tap — the 送信待ち row shows it.
    const queuedForTarget = queued.some(
      (row) => row.counterpart.userId === entry.counterpart.userId,
    );
    const canReRequest =
      direction === 'outgoing' &&
      !queuedForTarget &&
      (entry.status === 'ended' || entry.status === 'expired' || entry.status === 'cancelled');

    return (
      <View
        key={entry.requestId}
        style={[
          styles.rowBlock,
          focused && [styles.rowBlockFocused, { borderLeftColor: tokens.accent }],
        ]}
        testID={`request-row-${entry.requestId}`}
      >
        {focused && (
          <Text
            style={[styles.focusBadge, { color: tokens.accent }]}
            testID="request-focus-badge"
            allowFontScaling
          >
            通知から開いた申請
          </Text>
        )}
        <View style={[styles.row, { borderColor: tokens.line, backgroundColor: tokens.soft }]}>
          <Pressable
            testID={`request-profile-${entry.requestId}`}
            accessibilityRole="button"
            accessibilityLabel={`${entry.counterpart.displayName} ${entry.counterpart.userIdText} のプロフィールを表示`}
            onPress={() => onOpenProfile?.(entry)}
            style={styles.identity}
          >
            <View style={[styles.avatar, { backgroundColor: tokens.avatar }]}>
              <Text style={[styles.avatarText, { color: tokens.avatarInk }]} allowFontScaling>
                {entry.counterpart.displayName.slice(0, 1)}
              </Text>
            </View>
            <View style={styles.nameBlock}>
              <Text style={[styles.name, { color: tokens.text }]} allowFontScaling>
                {entry.counterpart.displayName}
              </Text>
              <Text style={[styles.userId, { color: tokens.muted }]} allowFontScaling>
                {entry.counterpart.userIdText}
              </Text>
            </View>
          </Pressable>
          <View style={styles.statusBlock}>
            <Text
              style={[styles.status, { color: tokens.text }]}
              testID={`request-status-${entry.requestId}`}
              allowFontScaling
            >
              {requestStatusLabel(entry.status)}
            </Text>
            <Text style={[styles.stamp, { color: tokens.muted }]} allowFontScaling>
              {requestStampLine(entry)}
            </Text>
          </View>
        </View>

        {(canDecide || canCancel || canReRequest) && !confirmingThis && (
          <View style={styles.actions}>
            {canDecide && (
              <>
                <Button
                  label="承認"
                  testID={`request-approve-${entry.requestId}`}
                  disabled={isBusy(`approve:${entry.requestId}`)}
                  onPress={() => fire('approve', entry)}
                  style={styles.actionButton}
                />
                <Button
                  label="拒否"
                  variant="secondary"
                  testID={`request-reject-${entry.requestId}`}
                  disabled={isBusy(`reject:${entry.requestId}`)}
                  onPress={() => setConfirm({ requestId: entry.requestId, action: 'reject' })}
                  style={styles.actionButton}
                />
              </>
            )}
            {canCancel && (
              <Button
                label="取り消し"
                variant="secondary"
                testID={`request-cancel-${entry.requestId}`}
                disabled={isBusy(`cancel:${entry.requestId}`)}
                onPress={() => setConfirm({ requestId: entry.requestId, action: 'cancel' })}
                style={styles.actionButton}
              />
            )}
            {canReRequest && (
              <Button
                label="もう一度申請"
                testID={`request-rerequest-${entry.requestId}`}
                disabled={isBusy(`reRequest:${entry.requestId}`)}
                onPress={() => fire('reRequest', entry)}
                style={styles.actionButton}
              />
            )}
          </View>
        )}

        {confirmingThis && confirm !== null && renderConfirm(entry, confirm.action)}
      </View>
    );
  };

  const showEmpty = entries.length === 0 && (queued?.length ?? 0) === 0;

  return (
    <View style={styles.root} testID={testID}>
      {showEmpty && (
        <Text
          style={[styles.empty, { color: tokens.muted }]}
          testID="request-empty"
          allowFontScaling
        >
          {emptyText ??
            (direction === 'incoming' ? '受信した申請はありません' : '送信した申請はありません')}
        </Text>
      )}

      {direction === 'outgoing' &&
        queued.map((row) => (
          <View
            key={row.operationId}
            style={[styles.rowBlock, styles.queuedBlock]}
            testID={`request-queued-${row.operationId}`}
          >
            <View style={[styles.row, { borderColor: tokens.line, backgroundColor: tokens.soft }]}>
              <View style={styles.identity}>
                <View style={[styles.avatar, { backgroundColor: tokens.avatar }]}>
                  <Text style={[styles.avatarText, { color: tokens.avatarInk }]} allowFontScaling>
                    {row.counterpart.displayName.slice(0, 1)}
                  </Text>
                </View>
                <View style={styles.nameBlock}>
                  <Text style={[styles.name, { color: tokens.text }]} allowFontScaling>
                    {row.counterpart.displayName}
                  </Text>
                  <Text style={[styles.userId, { color: tokens.muted }]} allowFontScaling>
                    {row.counterpart.userIdText}
                  </Text>
                </View>
              </View>
              <View style={styles.statusBlock}>
                <Text
                  style={[styles.status, { color: tokens.text }]}
                  testID={`request-queued-state-${row.operationId}`}
                  allowFontScaling
                >
                  {QUEUED_STATE_LABELS[row.state]}
                </Text>
              </View>
            </View>
          </View>
        ))}

      {entries.map(renderRow)}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.s2,
    paddingBottom: spacing.s4,
  },
  empty: {
    fontSize: typography.sizes.bodyLarge,
    textAlign: 'center',
    paddingVertical: spacing.s5,
  },
  rowBlock: {
    gap: spacing.s2,
  },
  rowBlockFocused: {
    borderLeftWidth: 3,
    paddingLeft: spacing.s2,
    borderRadius: 4,
  },
  focusBadge: {
    fontSize: typography.sizes.caption,
    fontWeight: typography.weights.semibold,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  queuedBlock: {
    opacity: 0.95,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    minHeight: controls.friendRowMinHeight,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2,
  },
  identity: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: typography.sizes.bodyLarge,
    fontWeight: typography.weights.semibold,
  },
  nameBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  name: {
    fontSize: typography.sizes.bodyLarge,
    fontWeight: typography.weights.semibold,
    lineHeight: typography.sizes.bodyLarge * typography.lineHeightRatio,
  },
  userId: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  statusBlock: {
    alignItems: 'flex-end',
    gap: 2,
  },
  status: {
    fontSize: typography.sizes.small,
    fontWeight: typography.weights.semibold,
    textAlign: 'right',
  },
  stamp: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
    textAlign: 'right',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.s2,
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
  confirmText: {
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  confirmHint: {
    fontSize: typography.sizes.small,
    lineHeight: typography.sizes.small * typography.lineHeightRatio,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: spacing.s2,
  },
  confirmButton: {
    flex: 1,
  },
});
