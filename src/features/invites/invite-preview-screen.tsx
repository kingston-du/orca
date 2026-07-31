import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { runFriendOperation } from "@/features/friends/friends-api";

import { resolveInvite } from "./invite-api";
import { clearInviteIntent, readInviteIntent } from "./invite-intent";
import { digestInviteToken } from "./invite-token";

type InvitePreviewScreenProps = {
  intentId: string;
  onDone: () => void;
};

export function InvitePreviewScreen({
  intentId,
  onDone,
}: InvitePreviewScreenProps) {
  const queryClient = useQueryClient();

  // The opaque intent is exchanged for the token here, hashed on-device, and
  // only the digest is sent. The raw token never leaves this module.
  const preview = useQuery({
    queryFn: async () => {
      const token = await readInviteIntent(intentId);
      if (!token) return null;
      return await resolveInvite(await digestInviteToken(token));
    },
    queryKey: ["invite-preview", intentId],
    retry: false,
  });

  const send = useMutation({
    mutationFn: (otherId: string) =>
      runFriendOperation("send_friend_request", otherId),
    onSuccess: async () => {
      await clearInviteIntent(intentId);
      await queryClient.invalidateQueries({ queryKey: ["friend-requests"] });
      await queryClient.invalidateQueries({ queryKey: ["friends"] });
      onDone();
    },
  });

  if (preview.isPending) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator accessibilityLabel="Opening invite" size="large" />
      </SafeAreaView>
    );
  }

  // Unknown, expired, revoked, blocked, and already-used intents are all the
  // same generic outcome.
  if (preview.isError || !preview.data) {
    return (
      <SafeAreaView style={styles.centered}>
        <Text accessibilityRole="header" style={styles.title}>
          This link isn’t available
        </Text>
        <Text style={styles.body}>
          It may have expired or been replaced. Ask for a new one.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void clearInviteIntent(intentId);
            onDone();
          }}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryLabel}>Done</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const inviter = preview.data;
  const isSelf = inviter.relationship_state === "self";
  const canSend = inviter.relationship_state === "none";

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.identity}>
          <View style={styles.avatarPlaceholder}>
            <Text style={styles.avatarText}>
              {Array.from(inviter.display_name.trim())[0]?.toUpperCase() ?? "?"}
            </Text>
          </View>
          <Text accessibilityRole="header" style={styles.title}>
            {inviter.display_name}
          </Text>
          <Text style={styles.body}>@{inviter.username}</Text>
          {inviter.mutual_friend_count > 0 ? (
            <Text style={styles.context}>
              {inviter.mutual_friend_count === 1
                ? "1 mutual friend"
                : `${inviter.mutual_friend_count} mutual friends`}
            </Text>
          ) : null}
        </View>

        <Text style={styles.body}>
          {invitationCopy(inviter.relationship_state)}
        </Text>

        {canSend ? (
          <Pressable
            accessibilityRole="button"
            disabled={send.isPending}
            onPress={() => send.mutate(inviter.id)}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryLabel}>Send friend request</Text>
          </Pressable>
        ) : null}

        {send.isError ? (
          <Text accessibilityLiveRegion="polite" style={styles.message}>
            That didn’t work. Try again in a moment.
          </Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void clearInviteIntent(intentId);
            onDone();
          }}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryLabel}>
            {isSelf ? "Done" : "Not now"}
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function invitationCopy(relationshipState: string) {
  if (relationshipState === "self") return "This is your own invite link.";
  if (relationshipState === "accepted") return "You’re already friends.";
  if (relationshipState === "outgoing")
    return "You’ve already sent a request. It’s waiting for a reply.";
  if (relationshipState === "incoming")
    return "They already sent you a request. Open Requests to accept it.";
  return "Sending a request lets them decide. Nothing is shared until you’re friends.";
}

const styles = StyleSheet.create({
  avatarPlaceholder: {
    alignItems: "center",
    backgroundColor: "#DCEEFB",
    borderRadius: 36,
    height: 72,
    justifyContent: "center",
    width: 72,
  },
  avatarText: { color: "#1769AA", fontSize: 28, fontWeight: "800" },
  body: { color: "#52606D", fontSize: 14, lineHeight: 20 },
  centered: {
    alignItems: "center",
    backgroundColor: "#F5FAFF",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  content: { gap: 20, padding: 20, paddingBottom: 48 },
  context: { color: "#1769AA", fontSize: 14, fontWeight: "700" },
  identity: { alignItems: "center", gap: 6 },
  message: { color: "#52606D", fontSize: 14 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 20,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  secondaryButton: {
    alignItems: "center",
    borderColor: "#BCCCDC",
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 20,
  },
  secondaryLabel: { color: "#102A43", fontSize: 15, fontWeight: "800" },
  title: { color: "#102A43", fontSize: 28, fontWeight: "900" },
});
