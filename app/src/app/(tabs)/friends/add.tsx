import { StyleSheet, Text, View } from 'react-native';

// Destination for the home-screen "友達を追加" entry. The actual
// search/invitation flow lands in later tasks, so this screen must never
// present an unimplemented operation as successful.
export default function AddFriendScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>友達追加</Text>
      <Text style={styles.placeholder}>友達追加は準備中です</Text>
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
});
