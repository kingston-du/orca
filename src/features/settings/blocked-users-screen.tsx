import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { InlineAlert } from "@/components/inline-alert";
import { ListRow } from "@/components/list-row";
import { ScreenHeader } from "@/components/screen-header";
import { color, spacing, typeScale } from "@/constants/design";
import {
  listBlockedProfiles,
  unblockUser,
} from "@/features/friends/friends-api";

const blockedKey = ["blocked-profiles"] as const;

export function BlockedUsersScreen({
  onBack,
  onReport,
}: {
  onBack: () => void;
  onReport: (profileId: string, displayName: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const blocked = useQuery({
    queryFn: listBlockedProfiles,
    queryKey: blockedKey,
  });

  // Unblocking carries the observed generation, so a block that was already
  // lifted and re-established elsewhere fails instead of silently clearing the
  // newer one.
  const unblock = useMutation({
    mutationFn: (input: { generationId: string; profileId: string }) =>
      unblockUser(input.profileId, input.generationId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: blockedKey });
      await queryClient.invalidateQueries({ queryKey: ["profile-summary"] });
    },
  });

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScreenHeader onBack={onBack} title="Blocked Users" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.body}>
          Unblocking does not make you friends again. It may restore access to
          history you shared before the block.
        </Text>

        {blocked.isPending ? (
          <ActivityIndicator accessibilityLabel="Loading blocked users" />
        ) : null}

        {blocked.isError ? (
          <InlineAlert
            action={
              <AppButton
                label="Try again"
                onPress={() => void blocked.refetch()}
                variant="secondary"
              />
            }
            message="Couldn’t load your blocks."
            tone="critical"
          />
        ) : null}

        {blocked.data?.length === 0 ? (
          <Text style={styles.body}>You haven’t blocked anyone.</Text>
        ) : null}

        {unblock.isError ? (
          <InlineAlert message="That block changed. Refresh and try again." />
        ) : null}

        {blocked.data?.map((entry) => (
          <ListRow
            key={entry.id}
            subtitle={entry.username ? `@${entry.username}` : "Still blocked"}
            title={entry.display_name ?? "Account unavailable"}
            trailing={
              <View style={styles.actions}>
                {/* The safety path from the block list: someone who blocked
                 * first and wants a review afterwards has nowhere else to
                 * start. */}
                <AppButton
                  accessibilityLabel={`Report ${entry.display_name ?? "this account"}`}
                  label="Report"
                  onPress={() => onReport(entry.id, entry.display_name)}
                  variant="danger"
                />
                <AppButton
                  accessibilityLabel={`Unblock ${entry.display_name ?? "this account"}`}
                  disabled={unblock.isPending}
                  label="Unblock"
                  onPress={() =>
                    unblock.mutate({
                      generationId: entry.generation_id,
                      profileId: entry.id,
                    })
                  }
                />
              </View>
            }
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: spacing.sm },
  body: { ...typeScale.cardBody, color: color.textSecondary },
  content: { gap: spacing.lg, padding: spacing.xl, paddingBottom: 48 },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
});
