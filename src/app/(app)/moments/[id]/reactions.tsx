import { useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { ReactionPeopleScreen } from "@/features/moments/reactions/reaction-people-screen";

// Like every Moment route, this one carries an opaque ID and refetches. A
// viewer who no longer holds the Moment gets an empty list rather than an
// error, because the server stops returning rows before it stops returning a
// response.
export default function MomentReactionsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  if (!id) {
    return (
      <View style={styles.centered}>
        <Text>Moment no longer available.</Text>
      </View>
    );
  }

  return <ReactionPeopleScreen momentId={id} />;
}

const styles = StyleSheet.create({
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
});
