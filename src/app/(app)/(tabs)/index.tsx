import { StyleSheet, Text, View } from "react-native";

export default function HomeRoute() {
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        Home
      </Text>
      <Text style={styles.body}>
        Your friends’ recent Moments will appear here after publishing ships.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { color: "#52606D", fontSize: 17, lineHeight: 25, textAlign: "center" },
  container: {
    alignItems: "center",
    backgroundColor: "#F5FAFF",
    flex: 1,
    gap: 16,
    justifyContent: "center",
    padding: 28,
  },
  title: { color: "#102A43", fontSize: 34, fontWeight: "900" },
});
