import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>ホーム</Text>
      <Text style={styles.placeholder}>準備中</Text>
      <Link href="/friends/add" style={styles.entry}>
        友達を追加
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  placeholder: {
    fontSize: 16,
  },
  entry: {
    fontSize: 16,
    marginTop: 8,
  },
});
