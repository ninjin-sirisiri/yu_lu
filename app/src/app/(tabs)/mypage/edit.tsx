import { useIsFocused, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../../auth/provider';
import { profileImageUrl } from '../../../backend/profile';
import { defaultIsOnline } from '../../../discovery/searchController';
import { AvatarPicker } from '../../../media/AvatarPicker';
import { subscribeAppResume } from '../../../requests/friendsRepository';
import {
  createDeviceProfileEditor,
  type ProfileEditor,
  type ProfileEditorView,
} from '../../../profiles/editor';
import { useTheme } from '../../../theme/provider';
import { spacing, radius, typography } from '../../../theme/tokens';
import { Button } from '../../../ui/Button';
import { Field } from '../../../ui/Field';
import { Screen } from '../../../ui/Screen';
import { StatusNotice, type StatusTone } from '../../../ui/StatusNotice';
import { queueStateLabel } from '../../../sync/SyncStatus';
import {
  DISPLAY_NAME_MAX_LENGTH,
  INTRODUCTION_MAX_LENGTH,
  visualLength,
} from '../../../profiles/validation';

// Task 17: プロフィール編集.
//
// The screen keeps the input values in local state (IME-safe, updated
// synchronously on every keystroke) while the headless editor owns the
// durable draft — every keystroke is mirrored into the account-scoped
// draft row, so back / tab / external-link navigation and a relaunch all
// restore exactly what was typed.
//
// 公開中 (published) and 変更予定 (pending) are rendered as two distinct
// blocks; 保存 only ENQUEUES (the queue worker publishes), the send state
// is shown next to the pending block, and cancelling the reservation never
// touches the draft. Validation errors appear NEXT TO their field before
// any save, counted with the shared visual rules the server applies.

type ScreenNotice = {
  tone: StatusTone;
  title: string;
  message?: string;
  testID: string;
};

type LoadError = 'offline' | 'network';

const CANCELLABLE_STATES = ['pending', 'needs_confirmation'];

function avatarSummary(path: string | null): string {
  return path !== null ? '設定済み' : '未設定';
}

export default function ProfileEditScreen() {
  const auth = useAuth();
  const router = useRouter();
  const { tokens } = useTheme();
  const focused = useIsFocused();

  const editor = useMemo<ProfileEditor | null>(
    () =>
      auth.accountId !== null && auth.storage !== null
        ? createDeviceProfileEditor({ accountId: auth.accountId, storage: auth.storage })
        : null,
    [auth.accountId, auth.storage],
  );

  const [view, setView] = useState<ProfileEditorView | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [introduction, setIntroduction] = useState('');
  const [publishedUri, setPublishedUri] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [notice, setNotice] = useState<ScreenNotice | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    if (editor === null) return;
    try {
      let next = await editor.load();
      // Foreground delivery: a still-queued profile save gets one send
      // attempt on every (re)entry to this screen — 接続復帰・アプリ復帰で
      // 再試行. The queue's own backoff keeps rapid re-entry harmless.
      if (
        next.sendState !== null &&
        (next.sendState.state === 'pending' || next.sendState.state === 'sent_unknown')
      ) {
        await editor.pump();
        next = await editor.load();
      }
      setView(next);
      setLoadError(null);
    } catch {
      setLoadError(defaultIsOnline() ? 'network' : 'offline');
    }
  }, [editor]);

  // Reload when the screen gains focus (returning from another tab /
  // screen, an external link, or the conflict screen).
  useEffect(() => {
    if (focused) void reload();
  }, [focused, reload]);

  // 接続復帰・アプリ復帰で再試行: re-entering the foreground re-reads the
  // state and gives a still-queued save its next send attempt.
  useEffect(() => subscribeAppResume(() => void reload()), [reload]);

  // Keep the inputs in sync with the durable draft after every load.
  useEffect(() => {
    if (view === null) return;
    setDisplayName(view.draft.displayName);
    setIntroduction(view.draft.introduction);
  }, [view]);

  // Signed preview of the PUBLISHED image (the private bucket only ever
  // hands out short-lived URLs; a failure simply shows "no preview").
  const avatarPath = view?.published.avatarPath ?? null;
  useEffect(() => {
    let alive = true;
    if (avatarPath === null) {
      setPublishedUri(null);
      return;
    }
    profileImageUrl(avatarPath)
      .then((url) => {
        if (alive) setPublishedUri(url);
      })
      .catch(() => {
        if (alive) setPublishedUri(null);
      });
    return () => {
      alive = false;
    };
  }, [avatarPath]);

  const onDisplayNameChange = (value: string): void => {
    setDisplayName(value);
    if (editor === null || view === null) return;
    // The editor's draft updates synchronously; persistence follows.
    void editor.setDisplayName(value).catch(() => undefined);
    setView(editor.view());
  };

  const onIntroductionChange = (value: string): void => {
    setIntroduction(value);
    if (editor === null || view === null) return;
    void editor.setIntroduction(value).catch(() => undefined);
    setView(editor.view());
  };

  const onAvatarChange = (): void => {
    if (editor === null) return;
    void editor
      .refreshLocal()
      .then((next) => {
        setView(next);
        setDisplayName(next.draft.displayName);
        setIntroduction(next.draft.introduction);
      })
      .catch(() => undefined);
  };

  const setClearAvatar = (value: boolean): void => {
    if (editor === null) return;
    void editor.setClearAvatar(value).catch(() => undefined);
    setView(editor.view());
  };

  const afterPump = (pump: Awaited<ReturnType<ProfileEditor['pump']>>): void => {
    if (pump.error !== null) {
      setNotice({
        tone: 'error',
        title: '送信を開始できませんでした',
        message: pump.error,
        testID: 'edit-pump-error',
      });
      return;
    }
    if (pump.conflicted) {
      // The conflict record is already persisted; the conflict screen
      // loads it and compares field by field.
      router.push('/mypage/conflict');
      return;
    }
    if (pump.imageUploadFailed) {
      setNotice({
        tone: 'warning',
        title: '画像を送信できませんでした',
        message:
          '公開内容は変更されていません。変更予定は残っているので、接続後に再試行できます。',
        testID: 'edit-image-failed',
      });
      return;
    }
    if (pump.publishedChanged) {
      setNotice({
        tone: 'success',
        title: 'プロフィールを公開しました',
        message: '公開中の内容が更新されました。',
        testID: 'edit-published-ok',
      });
      return;
    }
    setNotice({
      tone: 'info',
      title: '変更予定を送信待ちに追加しました',
      message: '接続が戻ると自動で送信されます。状況は「送信状況」で確認できます。',
      testID: 'edit-queued',
    });
  };

  const onSave = async (): Promise<void> => {
    if (editor === null || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const saved = await editor.save();
      if (saved.status === 'invalid') {
        setNotice({
          tone: 'error',
          title: '入力内容を確認してください',
          message: 'エラーは各項目の近くに表示されています。保存はまだ送信されていません。',
          testID: 'edit-invalid',
        });
        return;
      }
      if (saved.status === 'unchanged') {
        setNotice({
          tone: 'info',
          title: '変更はありません',
          message: '公開中の内容と同じため、送信はしていません。',
          testID: 'edit-unchanged',
        });
        return;
      }
      const pump = await editor.pump();
      await reload();
      afterPump(pump);
    } catch (cause) {
      setNotice({
        tone: 'error',
        title: '保存できませんでした',
        message: cause instanceof Error ? cause.message : String(cause),
        testID: 'edit-save-failed',
      });
    } finally {
      setBusy(false);
    }
  };

  const onCancelSend = async (): Promise<void> => {
    if (editor === null || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const cancelled = await editor.cancelPendingSends();
      await reload();
      setNotice(
        cancelled > 0
          ? {
              tone: 'info',
              title: '送信待ちを取り消しました',
              message: '下書きは残っています。破棄する場合は内容を消してください。',
              testID: 'edit-cancelled',
            }
          : {
              tone: 'info',
              title: '取り消せる送信はありません',
              testID: 'edit-cancel-nothing',
            },
      );
    } finally {
      setBusy(false);
    }
  };

  if (editor === null) {
    return (
      <Screen scroll testID="profile-edit-screen">
        <StatusNotice
          tone="error"
          title="保存領域を利用できません"
          message="もう一度起動するか、ログインし直してください。"
          testID="edit-no-storage"
        />
      </Screen>
    );
  }

  if (view === null && loadError === null) {
    return (
      <Screen scroll testID="profile-edit-screen">
        <Text style={[styles.state, { color: tokens.muted }]} testID="edit-loading">
          読み込み中…
        </Text>
      </Screen>
    );
  }

  if (view === null) {
    return (
      <Screen scroll testID="profile-edit-screen">
        <StatusNotice
          tone={loadError === 'offline' ? 'warning' : 'error'}
          title={
            loadError === 'offline'
              ? 'オフラインのためプロフィールを取得できません'
              : 'プロフィールを読み込めませんでした'
          }
          message={loadError === 'offline' ? '接続後に再試行してください。' : undefined}
          testID="edit-load-error"
        />
        <Button
          label="再試行"
          variant="secondary"
          testID="edit-retry"
          onPress={() => void reload()}
        />
      </Screen>
    );
  }

  const { published, errors, changes, sendState, conflict } = view;
  const cancellable =
    sendState !== null && CANCELLABLE_STATES.includes(sendState.state);

  return (
    <Screen scroll testID="profile-edit-screen">
      <Field
        label="User ID"
        testID="edit-user-id"
        value={view.userIdText ?? ''}
        onChangeText={() => undefined}
        editable={false}
        autoCapitalize="none"
        autoCorrect={false}
        hint="確定後のUser IDは変更できません。"
        accessibilityHint="変更できない項目です"
      />

      <View style={[styles.section, { borderColor: tokens.line, backgroundColor: tokens.soft }]} testID="edit-published">
        <Text style={[styles.sectionTitle, { color: tokens.text }]} allowFontScaling>
          公開中の内容
        </Text>
        <Text style={[styles.body, { color: tokens.text }]} testID="edit-published-name" allowFontScaling>
          {`表示名: ${published.displayName}`}
        </Text>
        <Text style={[styles.body, { color: tokens.text }]} testID="edit-published-introduction" allowFontScaling>
          {`自己紹介: ${
            published.introduction !== null && published.introduction !== ''
              ? published.introduction
              : 'なし'
          }`}
        </Text>
        <Text style={[styles.body, { color: tokens.text }]} testID="edit-published-avatar" allowFontScaling>
          {`画像: ${avatarSummary(published.avatarPath)}`}
        </Text>
      </View>

      <Field
        label="表示名"
        testID="edit-display-name"
        value={displayName}
        onChangeText={onDisplayNameChange}
        error={errors.displayName}
        hint={`${String(visualLength(displayName))} / ${String(DISPLAY_NAME_MAX_LENGTH)}`}
        accessibilityHint="1〜15文字。前後の空白は保存時に除かれます"
      />
      <Field
        label="自己紹介"
        testID="edit-introduction"
        value={introduction}
        onChangeText={onIntroductionChange}
        error={errors.introduction}
        hint={`${String(visualLength(introduction))} / ${String(INTRODUCTION_MAX_LENGTH)}`}
        multiline
        accessibilityHint="任意、200文字まで。改行できます"
      />

      {editor !== null && auth.storage !== null && (
        <AvatarPicker
          accountId={auth.accountId ?? ''}
          db={auth.storage}
          publishedUri={publishedUri}
          onChange={onAvatarChange}
        />
      )}

      {published.avatarPath !== null && view.stagedAvatar === null && (
        view.draft.clearAvatar === true ? (
          <View style={styles.clearRow}>
            <Text style={[styles.body, { color: tokens.text }]} testID="edit-avatar-clear-pending">
              画像を削除する予定です（保存すると公開内容から削除されます）
            </Text>
            <Button
              label="削除を取り消す"
              variant="ghost"
              testID="edit-avatar-clear-cancel"
              onPress={() => setClearAvatar(false)}
            />
          </View>
        ) : (
          <Button
            label="公開中の画像を削除"
            variant="ghost"
            testID="edit-avatar-clear"
            accessibilityHint="保存するとプロフィール画像を公開内容から削除します"
            onPress={() => setClearAvatar(true)}
          />
        )
      )}

      <View
        style={[styles.section, { borderColor: tokens.accent, backgroundColor: tokens.accentSoft }]}
        testID="edit-pending"
      >
        <Text style={[styles.sectionTitle, { color: tokens.text }]} allowFontScaling>
          変更予定（まだ公開されていません）
        </Text>
        {changes.hasChanges ? (
          <>
            {changes.displayName !== undefined && (
              <Text style={[styles.body, { color: tokens.text }]} testID="edit-pending-name" allowFontScaling>
                {`表示名: ${changes.displayName}`}
              </Text>
            )}
            {changes.introduction !== undefined && (
              <Text style={[styles.body, { color: tokens.text }]} testID="edit-pending-introduction" allowFontScaling>
                {`自己紹介: ${changes.introduction === '' ? '（削除）' : changes.introduction}`}
              </Text>
            )}
            {changes.avatar.kind === 'staged' && (
              <Text style={[styles.body, { color: tokens.text }]} testID="edit-pending-avatar" allowFontScaling>
                画像: 選択した画像（未公開）
              </Text>
            )}
            {changes.avatar.kind === 'clear' && (
              <Text style={[styles.body, { color: tokens.text }]} testID="edit-pending-avatar" allowFontScaling>
                画像: 削除予定
              </Text>
            )}
            <Text style={[styles.meta, { color: tokens.muted }]} testID="edit-send-state" allowFontScaling>
              {sendState !== null
                ? `送信状況: ${queueStateLabel(sendState.state)}`
                : '送信状況: まだ送信していません（保存で送信待ちになります）'}
            </Text>
          </>
        ) : (
          <Text style={[styles.body, { color: tokens.muted }]} testID="edit-no-changes">
            変更はありません
          </Text>
        )}
      </View>

      {conflict !== null && (
        <StatusNotice
          tone="warning"
          title="別の端末でプロフィールが更新されています"
          message="自動では上書きしません。項目ごとに比較して、適用する内容を選んでください。"
          testID="edit-conflict-notice"
        />
      )}
      {conflict !== null && (
        <Button
          label="競合を確認する"
          testID="edit-open-conflict"
          onPress={() => router.push('/mypage/conflict')}
        />
      )}

      <Button
        label="保存"
        testID="edit-save"
        busy={busy}
        onPress={() => void onSave()}
        accessibilityHint="変更内容を送信待ちに追加します。公開はサーバー確認後に行われます"
      />
      {cancellable && (
        <Button
          label="送信待ちを取り消す"
          variant="secondary"
          testID="edit-cancel-send"
          busy={busy}
          onPress={() => void onCancelSend()}
          accessibilityHint="送信待ちの操作を取り消します。下書きは残ります"
        />
      )}

      {notice !== null && (
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
  section: {
    gap: spacing.s1,
    borderWidth: 1,
    borderRadius: radius.md,
    borderColor: 'transparent',
    padding: spacing.s3,
    marginVertical: spacing.s1,
  },
  sectionTitle: {
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
    marginBottom: spacing.s1,
  },
  body: {
    fontSize: typography.sizes.body,
    lineHeight: typography.sizes.body * typography.lineHeightRatio,
  },
  meta: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
  clearRow: {
    gap: spacing.s2,
    alignItems: 'flex-start',
  },
});
