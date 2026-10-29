import React from 'react';
import { Redirect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { Text } from 'react-native';
import { useAuth } from '../../auth/provider';
import { ConversationPanel } from '../../messages/ConversationPanel';
import { conversationFallback, parseConversationEntry } from '../../navigation/conversationEntry';
import { Screen } from '../../ui/Screen';

export default function ConversationRoute() {
  const auth = useAuth();
  const params = useLocalSearchParams();
  const router = useRouter();
  const focused = useIsFocused();
  if (auth.status === 'loading') return <Screen title="会話"><Text>読み込み中…</Text></Screen>;
  if (auth.status === 'error') return <Redirect href="/" />;
  if (!auth.accountId) return <Redirect href="/login" />;
  if (auth.registration !== 'registered') return <Redirect href="/register" />;
  const entry = parseConversationEntry(params);
  if (!entry || entry.peerId === auth.accountId) return <Redirect href="/chat" />;
  return <ConversationPanel key={`${auth.accountId}:${entry.peerId}`} peerId={entry.peerId} active={focused}
    onOpenSendStatus={() => router.push('/mypage/sync')} onBack={() => {
    if (router.canGoBack()) router.back();
    else router.replace(conversationFallback(entry.peerId, entry.origin));
  }} />;
}
