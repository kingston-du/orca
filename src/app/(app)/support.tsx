import { StyleSheet, Text, View } from "react-native";

export default function SupportRoute() {
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        Support
      </Text>
      <Text style={styles.body}>
        During founder-only development, contact the project owner through the
        existing development channel. A reviewed public support contact is
        required before external testing.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { color: "#52606D", fontSize: 16, lineHeight: 24 },
  container: { backgroundColor: "#F5FAFF", flex: 1, gap: 16, padding: 24 },
  title: { color: "#102A43", fontSize: 30, fontWeight: "900" },
});
