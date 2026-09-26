import { Redirect, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { RegistrationResult } from '../auth/provider';
import { useAuth } from '../auth/provider';
import {
  peekPostAuthInvitation,
  takePostAuthInvitation,
} from '../invitations/pending';
import { useTheme } from '../theme/provider';
import type { ThemeTokens } from '../theme/tokens';
import { deleteDraft, readDraft, saveDraft } from '../storage/drafts';

// Task 10: registration screen (opened only inside the 未登録ガード).
//
// Flow: input → 確認 (review what becomes permanent) → submit → home.
// - The draft is saved account-scoped on every change and restored on mount
//   (登録途中の入力はアカウント別に端末保存し、再起動で復元).
// - A server ID conflict (409) keeps the input, shows the shared message and
//   offers similar-ID candidates; candidates are editable suggestions, not
//   reservations — they still go through confirmation and the server's
//   uniqueness check like any other input (入力中のIDは予約しない).
// - A retryable failure keeps the input AND the same operation id on the
//   server side, so retry never double-registers.

export const REGISTRATION_DRAFT_KEY = 'registration';

type Step = 'input' | 'confirm';

export default function RegisterScreen() {
  const auth = useAuth();
  const router = useRouter();
  // Task 11: themed — the form stays readable in light and dark.
  const { tokens } = useTheme();
  const styles = makeStyles(tokens);
  const [step, setStep] = useState<Step>('input');
  const [userIdText, setUserIdText] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [candidates, setCandidates] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const restoredRef = useRef(false);

  const accountId = auth.accountId;
  const storage = auth.storage;
  // Restore the account-scoped draft exactly once per account.
  useEffect(() => {
    if (accountId === null || !storage || restoredRef.current) return;
    let alive = true;
    void (async () => {
      const draft = await readDraft<{ userIdText?: string; displayName?: string }>(
        storage,
        accountId,
        REGISTRATION_DRAFT_KEY,
      );
      if (!alive || restoredRef.current) return;
      restoredRef.current = true;
      if (draft?.body?.userIdText) setUserIdText(draft.body.userIdText);
      if (draft?.body?.displayName) setDisplayName(draft.body.displayName);
    })();
    return () => {
      alive = false;
    };
  }, [accountId, storage]);

  const persistDraft = (nextUserId: string, nextDisplayName: string): void => {
    if (accountId === null || !storage) return;
    void saveDraft(storage, accountId, REGISTRATION_DRAFT_KEY, {
      userIdText: nextUserId,
      displayName: nextDisplayName,
    }).catch(() => {
      // A storage failure must not lose the in-memory input.
    });
  };

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setMessage(null);
    setRetryable(false);
    const result: RegistrationResult = await auth.submitRegistration({
      userIdText,
      displayName,
    });
    setSubmitting(false);
    switch (result.status) {
      case 'registered': {
        if (accountId && storage) {
          await deleteDraft(storage, accountId, REGISTRATION_DRAFT_KEY).catch(() => {
            // Draft cleanup is best effort; the guard no longer reads it.
          });
        }
        // Task 14: 招待経則では登録後に招待先確認へ直接戻る — the target
        // recorded by the invitation route wins over /home, once.
        const invitationTarget = takePostAuthInvitation();
        router.replace(
          invitationTarget !== null ? `/invitation/${invitationTarget}` : '/home',
        );
        return;
      }
      case 'conflict':
        // Input is kept exactly as typed; candidates are editable
        // suggestions, never reservations.
        setCandidates(result.candidates);
        setMessage(result.message);
        setRetryable(false);
        setStep('input');
        return;
      case 'rejected':
        setCandidates([]);
        setMessage(result.message);
        setRetryable(false);
        return;
      case 'failed':
        setCandidates([]);
        setMessage(result.message);
        setRetryable(result.retryable);
        return;
    }
  };

  const chooseCandidate = (candidate: string): void => {
    setUserIdText(candidate);
    persistDraft(candidate, displayName);
    setCandidates([]);
    setMessage(null);
  };

  // Guards: 未登録ガード requires a session; a registered user has nothing
  // to do here. Declared after all hooks (rules of hooks).
  if (auth.status === 'ready' && accountId === null) {
    return <Redirect href="/login" />;
  }
  if (auth.status === 'ready' && auth.registration === 'registered') {
    // Peek only: reaching the invitation route clears the target itself.
    const invitation = peekPostAuthInvitation();
    return <Redirect href={invitation !== null ? `/invitation/${invitation}` : '/home'} />;
  }

  if (auth.status !== 'ready') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>登録</Text>
        <Text style={styles.hint}>読み込み中…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>登録</Text>

      {step === 'input' ? (
        <>
          <Text style={styles.label}>User ID</Text>
          <TextInput
            testID="register-user-id"
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            value={userIdText}
            onChangeText={(text) => {
              setUserIdText(text);
              persistDraft(text, displayName);
            }}
          />
          <Text style={styles.label}>表示名</Text>
          <TextInput
            testID="register-display-name"
            style={styles.input}
            value={displayName}
            onChangeText={(text) => {
              setDisplayName(text);
              persistDraft(userIdText, text);
            }}
          />
          <Text style={styles.hint}>
            User IDは2〜20文字の半角英数字とアンダースコア。確定後は変更できません。
          </Text>

          {message !== null && (
            <Text style={styles.error} testID="register-error">
              {message}
            </Text>
          )}

          {candidates.length > 0 && (
            <View style={styles.candidates} testID="register-candidates">
              <Text style={styles.hint}>使える候補:</Text>
              {candidates.map((candidate) => (
                <TouchableOpacity
                  key={candidate}
                  testID={`register-candidate-${candidate}`}
                  onPress={() => chooseCandidate(candidate)}
                >
                  <Text style={styles.candidate}>{candidate}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <TouchableOpacity
            testID="register-review"
            style={styles.button}
            disabled={submitting}
            onPress={() => setStep('confirm')}
          >
            <Text style={styles.buttonLabel}>確認画面へ</Text>
          </TouchableOpacity>

          {retryable && (
            <TouchableOpacity testID="register-retry" onPress={() => void submit()}>
              <Text style={styles.retry}>再試行</Text>
            </TouchableOpacity>
          )}
        </>
      ) : (
        <>
          <Text style={styles.label}>この内容で登録します</Text>
          <Text style={styles.review} testID="register-review-user-id">
            User ID: {userIdText}
          </Text>
          <Text style={styles.review} testID="register-review-display-name">
            表示名: {displayName}
          </Text>
          <Text style={styles.hint}>
            User IDは確定後に変更できません。表示名は登録後に変更できます。
          </Text>

          {message !== null && (
            <Text style={styles.error} testID="register-error">
              {message}
            </Text>
          )}

          <TouchableOpacity
            testID="register-submit"
            style={styles.button}
            disabled={submitting}
            onPress={() => void submit()}
          >
            <Text style={styles.buttonLabel}>登録する</Text>
          </TouchableOpacity>

          <TouchableOpacity testID="register-back" onPress={() => setStep('input')}>
            <Text style={styles.retry}>入力に戻る</Text>
          </TouchableOpacity>

          {retryable && (
            <TouchableOpacity testID="register-retry" onPress={() => void submit()}>
              <Text style={styles.retry}>再試行</Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

const makeStyles = (tokens: ThemeTokens) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: 16,
      backgroundColor: tokens.surface,
    },
    title: {
      fontSize: 20,
      fontWeight: '600',
      color: tokens.text,
    },
    label: {
      fontSize: 14,
      fontWeight: '600',
      alignSelf: 'flex-start',
      maxWidth: 320,
      color: tokens.text,
    },
    input: {
      width: '100%',
      maxWidth: 320,
      borderWidth: 1,
      borderColor: tokens.line,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: tokens.text,
      backgroundColor: tokens.surface,
    },
    hint: {
      fontSize: 12,
      color: tokens.muted,
      maxWidth: 320,
    },
    error: {
      fontSize: 14,
      color: tokens.danger,
      maxWidth: 320,
      textAlign: 'center',
    },
    candidates: {
      gap: 6,
      alignItems: 'center',
    },
    candidate: {
      fontSize: 16,
      fontWeight: '600',
      textDecorationLine: 'underline',
      color: tokens.text,
    },
    review: {
      fontSize: 16,
      maxWidth: 320,
      color: tokens.text,
    },
    button: {
      width: '100%',
      maxWidth: 320,
      borderWidth: 1,
      borderColor: tokens.line,
      borderRadius: 8,
      paddingVertical: 12,
      alignItems: 'center',
      marginTop: 8,
      backgroundColor: tokens.surface,
    },
    buttonLabel: {
      fontSize: 16,
      color: tokens.text,
    },
    retry: {
      fontSize: 16,
      fontWeight: '600',
      textDecorationLine: 'underline',
      color: tokens.text,
    },
  });
