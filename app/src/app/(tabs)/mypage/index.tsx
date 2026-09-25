import { StyleSheet, Text, View } from 'react-native';

export default function MypageScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>マイページ</Text>
      <Text style={styles.placeholder}>マイページは準備中です</Text>
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
