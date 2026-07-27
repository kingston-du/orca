import { View, Text, StyleSheet } from "react-native";

export default function MemoriesScreen() {
  return (
    <View style={styles.container}>
      <Text>Memories</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
