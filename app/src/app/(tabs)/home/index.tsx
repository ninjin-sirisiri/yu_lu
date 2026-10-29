import { useRouter } from 'expo-router';
import { HomeDashboard } from '../../../daily/HomeDashboard';
import { conversationEntry } from '../../../navigation/conversationEntry';

export default function HomeScreen() {
  const router = useRouter();
  return <HomeDashboard onOpen={peerId => router.push(conversationEntry(peerId, 'home'))}
    onFriends={() => router.push('/friends/add')} onChat={() => router.push('/chat')} />;
}
