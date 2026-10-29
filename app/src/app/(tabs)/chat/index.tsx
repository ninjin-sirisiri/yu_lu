import { useIsFocused, useRouter } from 'expo-router';
import { ChatWorkspace } from '../../../messages/ChatWorkspace';
import { conversationEntry } from '../../../navigation/conversationEntry';

export default function ChatScreen() {
  const router = useRouter();
  const focused = useIsFocused();
  return <ChatWorkspace active={focused} onNew={() => router.push('/chat/new')}
    onOpen={peerId => router.push(conversationEntry(peerId, 'chat'))}
    onOpenSendStatus={() => router.push('/mypage/sync')} />;
}
