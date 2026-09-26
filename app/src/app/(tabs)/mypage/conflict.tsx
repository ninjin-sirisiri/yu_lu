import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../../auth/provider';
import { defaultIsOnline } from '../../../discovery/searchController';
import { subscribeAppResume } from '../../../requests/friendsRepository';
import {
  buildConflictRows,
  conflictSelectionDefaults,
  CONFLICT_FIELD_LABELS,
  type ConflictChoice,
  type ConflictFieldKey,
  type ConflictSelection,
} from '../../../profiles/conflict';
import {
  createDeviceProfileEditor,
  type ProfileEditor,
  type ProfileEditorView,
} from '../../../profiles/editor';
import { useTheme } from '../../../theme/provider';
import { spacing, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';
import { StatusNotice, type StatusTone } from '../../../ui/StatusNotice';

// Task 17: 競合の確認・項目別解決.
//
// The record was captured when the server answered 409: what THIS device
// submitted against what is currently published. The screen compares the
// two sides field by field and lets the owner choose, per field, which
// value applies; saving enqueues ONE NEW operation on the latest
// base_version (the settled operation id is never reused).
//
// 自動上書きしない twice over:
// - the freshness gate in `resolveConflict` re-runs the comparison when
//   the published side moved while this screen was open (no enqueue);
// - a conflict that recurs at send time comes back as a fresh record and
//   this screen re-renders the comparison instead of writing anything.

type ScreenNotice = {
  tone: StatusTone;
  title: string;
  message?: string;
  testID: string;
};

function formatTheirs(field: ConflictFieldKey, value: string | null): string {
  if (field === 'avatar_path') return value !== null ? 'あり' : 'なし';
  return value === null || value === '' ? 'なし' : value;
}

function formatMine(
  field: ConflictFieldKey,
  value: string | null,
  intent: 'staged' | 'clear' | undefined,
): string {
  if (field === 'avatar_path') {
    if (intent === 'staged') return '選択した画像（未公開）';
    if (intent === 'clear') return '削除予定';
    return value !== null ? 'あり' : 'なし';
  }
  return value === null || value === '' ? 'なし' : value;
}

export default function ProfileConflictScreen() {
  const auth = useAuth();
  const router = useRouter();
  const { tokens } = useTheme();

  const editor = useMemo<ProfileEditor | null>(
    () =>
      auth.accountId !== null && auth.storage !== null
        ? createDeviceProfileEditor({ accountId: auth.accountId, storage: auth.storage })
        : null,
    [auth.accountId, auth.storage],
  );

  const [view, setView] = useState<ProfileEditorView | null>(null);
  const [selection, setSelection] = useState<ConflictSelection>({});
  const [loadError, setLoadError] = useState<'offline' | 'network' | null>(null);
  const [notice, setNotice] = useState<ScreenNotice | null>(null);
  const [resolved, setResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const recordKeyRef = useRef<string | null>(null);

  const reload = useCallback(async (): Promise<ProfileEditorView | null> => {
    if (editor === null) return null;
    try {
      let next = await editor.load();
      // Deliver a still-queued resolution once per entry (接続復帰で再試行).
      if (
        next.sendState !== null &&
        (next.sendState.state === 'pending' || next.sendState.state === 'sent_unknown')
      ) {
        const pump = await editor.pump();
        next = await editor.load();
        if (pump.publishedChanged && next.conflict === null) {
          setResolved(true);
          setNotice({
            tone: 'success',
            title: '送信が完了し、公開されました',
            testID: 'conflict-resolved',
          });
        }
      }
      setView(next);
      setLoadError(null);
      const record = next.conflict;
      const key =
        record !== null ? `${record.operationId}:${String(record.latestVersion)}` : null;
      if (key !== recordKeyRef.current) {
        // A NEW comparison (first load, a rebase, or a repeated conflict):
        // start from its defaults. An unchanged record keeps the owner's
        // in-progress choices.
        recordKeyRef.current = key;
        if (record !== null) {
          setSelection(
            conflictSelectionDefaults(record, next.draft, {
              stagedAvatar: next.stagedAvatar !== null,
            }),
          );
        }
      }
      return next;
    } catch {
      setLoadError(defaultIsOnline() ? 'network' : 'offline');
      return null;
    }
  }, [editor]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 接続復帰・アプリ復帰で再試行: a queued resolution gets its next attempt
  // when the app returns to the foreground.
  useEffect(() => subscribeAppResume(() => void reload()), [reload]);

  const choose = (field: ConflictFieldKey, choice: ConflictChoice): void => {
    setSelection((previous) => ({ ...previous, [field]: choice }));
  };

  const reCompare = async (): Promise<void> => {
    const next = await reload();
    if (next?.conflict !== null && next?.conflict !== undefined) {
      setNotice({
        tone: 'warning',
        title: '公開内容が更新されたため、もう一度比較しています',
        message: '自動では上書きしません。最新の内容を見直してから保存してください。',
        testID: 'conflict-refreshed',
      });
    }
  };

  const onResolve = async (): Promise<void> => {
    if (editor === null || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await editor.resolveConflict(selection);
      switch (result.status) {
        case 'invalid': {
          setNotice({
            tone: 'error',
            title: '入力内容を確認してください',
            message: '編集画面でエラーを直してからもう一度お試しください。',
            testID: 'conflict-invalid',
          });
          return;
        }
        case 'adopted': {
          setResolved(true);
          setNotice({
            tone: 'success',
            title: '公開内容をそのまま採用しました',
            message: '保存できる変更はありませんでした（何も上書きしていません）。',
            testID: 'conflict-adopted',
          });
          await reload();
          return;
        }
        case 'conflict': {
          // The published side moved while this screen was open: the
          // comparison was re-run above and NOTHING was enqueued.
          await reCompare();
          return;
        }
        case 'queued': {
          const pump = await editor.pump();
          await reload();
          if (pump.error !== null) {
            setNotice({
              tone: 'error',
              title: '送信を開始できませんでした',
              message: pump.error,
              testID: 'conflict-pump-error',
            });
            return;
          }
          if (pump.conflicted) {
            // A SECOND conflict at send time: never overwrite — compare again.
            await reCompare();
            return;
          }
          if (pump.publishedChanged) {
            setResolved(true);
            setNotice({
              tone: 'success',
              title: '選んだ内容を公開しました',
              testID: 'conflict-resolved',
            });
            await reload();
            return;
          }
          if (pump.imageUploadFailed) {
            setNotice({
              tone: 'warning',
              title: '画像を送信できませんでした',
              message: '公開内容は変更されていません。接続後に再試行できます。',
              testID: 'conflict-image-failed',
            });
            return;
          }
          setNotice({
            tone: 'info',
            title: '選んだ内容を送信待ちに追加しました',
            message: '接続が戻ると送信され、公開後にこの画面は完了になります。',
            testID: 'conflict-queued',
          });
          return;
        }
      }
    } catch (cause) {
      setNotice({
        tone: 'error',
        title: '保存できませんでした',
        message: cause instanceof Error ? cause.message : String(cause),
        testID: 'conflict-save-failed',
      });
    } finally {
      setBusy(false);
    }
  };

  if (editor === null) {
    return (
      <Screen scroll testID="profile-conflict-screen">
        <StatusNotice
          tone="error"
          title="保存領域を利用できません"
          testID="conflict-no-storage"
        />
      </Screen>
    );
  }

  if (view === null && loadError === null) {
    return (
      <Screen scroll testID="profile-conflict-screen">
        <Text style={[styles.state, { color: tokens.muted }]} testID="conflict-loading">
          読み込み中…
        </Text>
      </Screen>
    );
  }

  if (view === null) {
    return (
      <Screen scroll testID="profile-conflict-screen">
        <StatusNotice
          tone={loadError === 'offline' ? 'warning' : 'error'}
          title={
            loadError === 'offline'
              ? 'オフラインのため競合情報を取得できません'
              : '競合情報を読み込めませんでした'
          }
          testID="conflict-load-error"
        />
        <Button
          label="再試行"
          variant="secondary"
          testID="conflict-retry"
          onPress={() => void reload()}
        />
      </Screen>
    );
  }

  if (resolved) {
    return (
      <Screen scroll testID="profile-conflict-screen">
        <StatusNotice
          tone="success"
          title={notice?.title ?? '競合を解決しました'}
          message={notice?.message}
          testID="conflict-done"
        />
        <Button
          label="編集画面に戻る"
          testID="conflict-back"
          onPress={() => router.back()}
          style={styles.action}
        />
      </Screen>
    );
  }

  const conflict = view.conflict;
  if (conflict === null) {
    return (
      <Screen scroll testID="profile-conflict-screen">
        <StatusNotice
          tone="neutral"
          title="解決待ちの競合はありません"
          message="編集画面から保存し直すと、競合したときにここへ表示されます。"
          testID="conflict-empty"
        />
        <Button
          label="編集画面に戻る"
          testID="conflict-empty-back"
          onPress={() => router.back()}
          style={styles.action}
        />
      </Screen>
    );
  }

  const rows = buildConflictRows(conflict, view.draft, {
    stagedAvatar: view.stagedAvatar !== null,
  });

  return (
    <Screen scroll testID="profile-conflict-screen">
      <StatusNotice
        tone="warning"
        title="別の端末でプロフィールが更新されています"
        message="自動では上書きしません。項目ごとに比較して、適用する内容を選んでください。"
        testID="conflict-intro"
      />
      <Text style={[styles.context, { color: tokens.muted }]} testID="conflict-message" allowFontScaling>
        {conflict.message}
      </Text>

      {rows.map((row) => (
        <View
          key={row.field}
          style={[styles.row, { borderColor: tokens.line, backgroundColor: tokens.soft }]}
          testID={`conflict-row-${row.field}`}
        >
          <Text style={[styles.field, { color: tokens.text }]} allowFontScaling>
            {CONFLICT_FIELD_LABELS[row.field]}
          </Text>
          <Text style={[styles.value, { color: tokens.text }]} testID={`conflict-theirs-${row.field}`} allowFontScaling>
            {`公開内容: ${formatTheirs(row.field, row.theirs)}`}
          </Text>
          <Text style={[styles.value, { color: tokens.text }]} testID={`conflict-mine-${row.field}`} allowFontScaling>
            {`変更予定: ${formatMine(row.field, row.mine, row.mineIntent)}`}
          </Text>

          {row.differs ? (
            <View style={styles.choices}>
              <Button
                label="この変更を残す"
                variant={(selection[row.field] ?? row.defaultChoice) === 'mine' ? 'primary' : 'ghost'}
                selected={(selection[row.field] ?? row.defaultChoice) === 'mine'}
                testID={`conflict-${row.field}-mine`}
                onPress={() => choose(row.field, 'mine')}
                style={styles.choice}
              />
              <Button
                label="公開内容にする"
                variant={(selection[row.field] ?? row.defaultChoice) === 'theirs' ? 'primary' : 'ghost'}
                selected={(selection[row.field] ?? row.defaultChoice) === 'theirs'}
                testID={`conflict-${row.field}-theirs`}
                onPress={() => choose(row.field, 'theirs')}
                style={styles.choice}
              />
            </View>
          ) : (
            <Text style={[styles.same, { color: tokens.muted }]} testID={`conflict-same-${row.field}`} allowFontScaling>
              変更なし（公開内容と同じです）
            </Text>
          )}
        </View>
      ))}

      <Button
        label="選んだ内容で保存"
        testID="conflict-save"
        busy={busy}
        onPress={() => void onResolve()}
        style={styles.action}
        accessibilityHint="選んだ項目を最新の版で新しい操作として送信します"
      />
      <Button
        label="編集画面に戻る"
        variant="secondary"
        testID="conflict-cancel"
        onPress={() => router.back()}
        style={styles.action}
      />

      {notice !== null && !resolved && (
        <StatusNotice
          tone={notice.tone}
          title={notice.title}
          message={notice.message}
          testID={notice.testID}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  state: {
    fontSize: typography.sizes.bodyLarge,
    textAlign: 'center',
    paddingVertical: spacing.s5,
  },
  context: {
    fontSize: typography.sizes.caption,
  },
  row: {
    gap: spacing.s1,
    borderWidth: 1,
    borderRadius: 6,
    padding: spacing.s3,
  },
  field: {
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  value: {
    fontSize: typography.sizes.body,
    lineHeight: typography.sizes.body * typography.lineHeightRatio,
  },
  choices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.s2,
    paddingTop: spacing.s1,
  },
  choice: {
    flexGrow: 1,
    minWidth: 150,
  },
  same: {
    fontSize: typography.sizes.caption,
    paddingTop: spacing.s1,
  },
  action: {
    marginTop: spacing.s2,
  },
});
