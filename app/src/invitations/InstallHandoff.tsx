// Task 14: install-time invitation hand-off (インストール引き継ぎ).
//
// Ownership: the two OS-provided hand-off channels, each used exactly the
// way the platform allows:
//
// - **Android**: `Application.getInstallReferrerAsync()` — the value "may
//   not be a complete, absolute URL" (SDK 57 docs), so parsing goes
//   through links.parseInstallReferrer which accepts query strings, bare
//   parameters and full URLs, and reads ONLY the allowed `invitation`
//   parameter. Read errors (no Play Store, service unavailable, …) are
//   swallowed into a neutral state — an install without an invitation is
//   the normal case and must never block login/registration.
// - **iOS**: `ClipboardPasteButton` (UIPasteControl) — an EXPLICIT user
//   action, the approved exception to 「追加操作なしの自動復元」. There is
//   NO automatic clipboard read anywhere in this component (no
//   getStringAsync at launch), the OS label is never customized, and a
//   nearby hint explains that this is where a copied invitation gets
//   pasted.
//
// Invalid pasted content explains itself and never blocks registration
// (復元不能・不正な貼り付け内容でも登録を止めない).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';

import { useTheme } from '../theme/provider';
import { spacing, typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { StatusNotice } from '../ui/StatusNotice';
import { parseInstallReferrer, parsePastedInvitation } from './links';

export interface InstallHandoffProps {
  /** Receives a parsed token; parent navigates to /invitation/<token>. */
  onInvitation?: (token: string) => void;
  /**
   * Platform selector (tests inject 'android'/'ios'; defaults to the real
   * platform). iOS renders the paste control, Android reads the referrer.
   */
  platform?: 'ios' | 'android';
  /** Injected referrer reader (tests); defaults to the Android API. */
  getInstallReferrer?: () => Promise<string>;
  /** Injected paste availability (tests); defaults to the Clipboard const. */
  pasteAvailable?: boolean;
  testID?: string;
}

type Notice =
  | { kind: 'found'; token: string; source: 'referrer' | 'paste' }
  | { kind: 'invalid'; source: 'referrer' | 'paste' }
  | null;

export function InstallHandoff({
  onInvitation,
  platform,
  getInstallReferrer,
  pasteAvailable,
  testID = 'install-handoff',
}: InstallHandoffProps) {
  const { tokens } = useTheme();
  const [notice, setNotice] = useState<Notice>(null);
  const androidReadRef = useRef(false);

  const effectivePlatform = platform ?? (Platform.OS === 'android' ? 'android' : 'ios');
  const canPaste = pasteAvailable ?? Clipboard.isPasteButtonAvailable === true;
  const readReferrer = getInstallReferrer ?? (() => Application.getInstallReferrerAsync());

  // Android: read the install referrer ONCE per mount. Any failure (no
  // Play Store, service disconnected, …) degrades to "no invitation" —
  // installation without an invitation must proceed normally.
  useEffect(() => {
    if (effectivePlatform !== 'android') return;
    if (androidReadRef.current) return;
    androidReadRef.current = true;
    void (async () => {
      try {
        const referrer = await readReferrer();
        const parsed = parseInstallReferrer(referrer);
        if (parsed.kind === 'token') {
          setNotice({ kind: 'found', token: parsed.token, source: 'referrer' });
        } else if (parsed.kind === 'invalid') {
          setNotice({ kind: 'invalid', source: 'referrer' });
        }
        // 'none': a plain install — no UI at all.
      } catch {
        // Referrer unavailable: normal for non-Play installs; never block.
      }
    })();
  }, [effectivePlatform, readReferrer]);

  const handlePaste = useCallback((payload: { type?: string; text?: string }) => {
    if (payload.type !== 'text' || typeof payload.text !== 'string') {
      setNotice({ kind: 'invalid', source: 'paste' });
      return;
    }
    const parsed = parsePastedInvitation(payload.text);
    if (parsed.kind === 'token') {
      setNotice({ kind: 'found', token: parsed.token, source: 'paste' });
    } else {
      // 'invalid' and empty 'none' alike: the user pressed paste, so an
      // explanation is expected feedback.
      setNotice({ kind: 'invalid', source: 'paste' });
    }
  }, []);

  const openInvitation = useCallback(
    (token: string) => {
      onInvitation?.(token);
    },
    [onInvitation],
  );

  if (effectivePlatform === 'ios' && !canPaste) {
    // iOS < 16 without the paste control: no UI (the link can simply be
    // reopened). Render nothing rather than a dead hint.
    return null;
  }

  return (
    <View style={styles.root} testID={testID}>
      {effectivePlatform === 'ios' && (
        <View style={styles.pasteBlock}>
          <Text style={[styles.hint, { color: tokens.muted }]} testID="install-paste-hint">
            招待リンクをコピーしてある場合、下のボタンで貼り付けて招待を確認できます。
          </Text>
          <Clipboard.ClipboardPasteButton
            testID="install-paste-button"
            style={styles.pasteButton}
            acceptedContentTypes={['plain-text']}
            onPress={handlePaste}
          />
        </View>
      )}

      {notice?.kind === 'found' && (
        <View style={styles.foundBlock}>
          <StatusNotice
            tone="info"
            title={notice.source === 'referrer' ? '招待情報が見つかりました' : '招待リンクを読み取りました'}
            message="招待を確認すると相手を確認できます。"
            testID="install-found"
          />
          <Button
            label="招待を確認"
            testID="install-open"
            onPress={() => openInvitation(notice.token)}
          />
        </View>
      )}

      {notice?.kind === 'invalid' && (
        <StatusNotice
          tone="warning"
          title={notice.source === 'paste' ? '招待リンクとして読み取れませんでした' : '招待情報を読み取れませんでした'}
          message="元の招待リンクを開き直すか、User IDで検索してください。ログイン・登録はそのまま進められます。"
          testID="install-invalid"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.s3,
    paddingVertical: spacing.s3,
  },
  pasteBlock: {
    gap: spacing.s2,
  },
  pasteButton: {
    height: 44,
    alignSelf: 'flex-start',
  },
  foundBlock: {
    gap: spacing.s2,
  },
  hint: {
    fontSize: typography.sizes.caption,
    lineHeight: typography.sizes.caption * typography.lineHeightRatio,
  },
});
