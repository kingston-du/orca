import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useCircleHub } from "./circle-queries";

type CircleHubScreenProps = {
  userId: string | undefined;
  onCreateCircle: () => void;
  onJoinCircle: () => void;
  onOpenCircle: (circleId: string) => void;
};

export function CircleHubScreen({
  userId,
  onCreateCircle,
  onJoinCircle,
  onOpenCircle,
}: CircleHubScreenProps) {
  const circlesQuery = useCircleHub(userId);

  if (circlesQuery.isPending) {
    return <LoadingCircles />;
  }

  if (circlesQuery.isError || !circlesQuery.data) {
    return <CircleHubError onRetry={() => void circlesQuery.refetch()} />;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>YOUR FRIENDS</Text>
        <Text style={styles.title}>Home</Text>
        <Text style={styles.subtitle}>
          Pick a Circle for the photos and moments you share together.
        </Text>

        <View
          accessibilityLabel="Everyone, all your Circles"
          style={styles.everyoneRow}
        >
          <View style={styles.everyoneBadge}>
            <Text style={styles.everyoneBadgeLabel}>∞</Text>
          </View>
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle}>Everyone</Text>
            <Text style={styles.rowSubtitle}>
              Your combined feed arrives with posting
            </Text>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Your Circles</Text>
          <Text style={styles.sectionCount}>{circlesQuery.data.length}</Text>
        </View>

        {circlesQuery.data.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>
              Your shared history starts here.
            </Text>
            <Text style={styles.emptyBody}>
              Create a Circle for your group, or join one with a private invite
              code.
            </Text>
          </View>
        ) : (
          <View style={styles.circleList}>
            {circlesQuery.data.map((circle) => (
              <Pressable
                accessibilityLabel={`Open ${circle.name}`}
                accessibilityRole="button"
                key={circle.id}
                onPress={() => onOpenCircle(circle.id)}
                style={({ pressed }) => [
                  styles.circleRow,
                  pressed && styles.rowPressed,
                ]}
              >
                <View style={styles.circleInitial}>
                  <Text style={styles.circleInitialLabel}>
                    {circle.name.slice(0, 1).toUpperCase()}
                  </Text>
                </View>
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {circle.name}
                </Text>
                <Text accessibilityElementsHidden style={styles.chevron}>
                  ›
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={onCreateCircle}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonLabel}>Create Circle</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onJoinCircle}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonLabel}>Join with code</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function LoadingCircles() {
  return (
    <View
      accessibilityLabel="Loading Circles"
      accessibilityRole="progressbar"
      style={styles.centered}
    >
      <ActivityIndicator size="large" />
    </View>
  );
}

function CircleHubError({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.centered}>
      <Text style={styles.errorTitle}>We couldn’t load your Circles</Text>
      <Text style={styles.errorBody}>Check your connection and try again.</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={styles.primaryButton}
      >
        <Text style={styles.primaryButtonLabel}>Try again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { gap: 12, marginTop: 12 },
  centered: {
    alignItems: "center",
    backgroundColor: "#F5FAFF",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  chevron: { color: "#7B8794", fontSize: 28, lineHeight: 30 },
  circleInitial: {
    alignItems: "center",
    backgroundColor: "#D9EFFF",
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  circleInitialLabel: { color: "#1268B3", fontSize: 16, fontWeight: "800" },
  circleList: { gap: 10 },
  circleRow: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#D9E2EC",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 64,
    paddingHorizontal: 16,
  },
  content: { gap: 16, padding: 24 },
  emptyBody: { color: "#52606D", fontSize: 15, lineHeight: 22 },
  emptyCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#D9E2EC",
    borderRadius: 16,
    borderStyle: "dashed",
    borderWidth: 1,
    gap: 8,
    padding: 20,
  },
  emptyTitle: { color: "#102A43", fontSize: 17, fontWeight: "800" },
  errorBody: {
    color: "#52606D",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
  errorTitle: {
    color: "#102A43",
    fontSize: 24,
    fontWeight: "800",
    textAlign: "center",
  },
  everyoneBadge: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  everyoneBadgeLabel: { color: "#FFFFFF", fontSize: 22, fontWeight: "800" },
  everyoneRow: {
    alignItems: "center",
    backgroundColor: "#E6F4FE",
    borderColor: "#A9D6F5",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 76,
    paddingHorizontal: 16,
  },
  eyebrow: {
    color: "#1268B3",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.1,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 18,
  },
  primaryButtonLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  rowCopy: { flex: 1, gap: 2 },
  rowPressed: { opacity: 0.75 },
  rowSubtitle: { color: "#52606D", fontSize: 14 },
  rowTitle: { color: "#102A43", flex: 1, fontSize: 17, fontWeight: "800" },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  sectionCount: { color: "#7B8794", fontSize: 14, fontWeight: "700" },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  sectionTitle: { color: "#102A43", fontSize: 19, fontWeight: "800" },
  secondaryButton: {
    alignItems: "center",
    borderColor: "#208AEF",
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 18,
  },
  secondaryButtonLabel: { color: "#1268B3", fontSize: 16, fontWeight: "800" },
  subtitle: { color: "#52606D", fontSize: 16, lineHeight: 24 },
  title: { color: "#102A43", fontSize: 34, fontWeight: "800" },
});
