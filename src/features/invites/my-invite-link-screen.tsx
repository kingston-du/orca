import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  createInviteLink,
  getInviteStatus,
  revokeInviteLink,
  rotateInviteLink,
} from "./invite-api";
import { readInviteToken, saveInviteToken } from "./invite-storage";
import {
  createInviteToken,
  digestInviteToken,
  inviteLinkFor,
} from "./invite-token";

const statusKey = ["invite-status"] as const;

type MyInviteLinkScreenProps = {
  environmentUrl: string;
  userId: string;
};

export function MyInviteLinkScreen({
  environmentUrl,
  userId,
}: MyInviteLinkScreenProps) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryFn: getInviteStatus, queryKey: statusKey });
  const [localToken, setLocalToken] = useState<string | null>(null);
  const [isReadingLocal, setIsReadingLocal] = useState(true);

  useEffect(() => {
    let active = true;
    void readInviteToken(userId, environmentUrl)
      .then((token) => {
        if (active) setLocalToken(token);
      })
      .finally(() => {
        if (active) setIsReadingLocal(false);
      });
    return () => {
      active = false;
    };
  }, [environmentUrl, userId]);

  // The raw token is written locally BEFORE registration. If the response is
  // lost, the device retries with the same digest and the server treats it as
  // idempotent rather than issuing a second link.
  const issue = useMutation({
    mutationFn: async (rotate: boolean) => {
      const token = createInviteToken();
      await saveInviteToken(userId, environmentUrl, token);
      const digest = await digestInviteToken(token);
      const result = rotate
        ? await rotateInviteLink(digest)
        : await createInviteLink(digest);
      setLocalToken(token);
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: statusKey }),
  });

  const revoke = useMutation({
    mutationFn: revokeInviteLink,
    onSuccess: async () => {
      setLocalToken(null);
      await queryClient.invalidateQueries({ queryKey: statusKey });
    },
  });

  const busy = issue.isPending || revoke.isPending;
  // The server knows a link exists, but only this device can rebuild the URL.
  const canShare = Boolean(status.data && localToken);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          My Invite Link
        </Text>
        <Text style={styles.body}>
          Anyone with this link can see your name and send you a friend request.
          It never adds a friend on its own.
        </Text>

        {status.isPending || isReadingLocal ? (
          <ActivityIndicator accessibilityLabel="Loading your invite link" />
        ) : null}

        {status.isError ? (
          <View style={styles.retryRow}>
            <Text style={styles.message}>Couldn’t load your link.</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void status.refetch()}
            >
              <Text style={styles.link}>Try again</Text>
            </Pressable>
          </View>
        ) : null}

        {!status.isPending && !isReadingLocal && !status.data ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => issue.mutate(false)}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryLabel}>Create link</Text>
          </Pressable>
        ) : null}

        {status.data ? (
          <View style={styles.card}>
            <Text style={styles.label}>Link ID</Text>
            <Text style={styles.value}>{status.data.fingerprint}</Text>
            <Text style={styles.label}>Expires</Text>
            <Text style={styles.value}>
              {new Date(status.data.expires_at).toLocaleDateString()}
            </Text>
          </View>
        ) : null}

        {status.data && !localToken && !isReadingLocal ? (
          <Text accessibilityLiveRegion="polite" style={styles.message}>
            This link can’t be recovered on this device. Rotate it to get a new
            one you can share.
          </Text>
        ) : null}

        {canShare && localToken ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() =>
              void Share.share({
                message: inviteLinkFor(localToken, Linking.createURL("invite")),
              })
            }
            style={styles.primaryButton}
          >
            <Text style={styles.primaryLabel}>Share link</Text>
          </Pressable>
        ) : null}

        {status.data ? (
          <View style={styles.actions}>
            <Pressable
              accessibilityHint="Replaces your link so the old one stops working"
              accessibilityRole="button"
              disabled={busy}
              onPress={() => issue.mutate(true)}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryLabel}>Rotate</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => revoke.mutate()}
              style={styles.dangerButton}
            >
              <Text style={styles.dangerLabel}>Revoke</Text>
            </Pressable>
          </View>
        ) : null}

        {issue.isError || revoke.isError ? (
          <Text accessibilityLiveRegion="polite" style={styles.message}>
            That didn’t work. Try again in a moment.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  body: { color: "#52606D", fontSize: 14, lineHeight: 20 },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    gap: 4,
    padding: 16,
  },
  content: { gap: 16, padding: 20, paddingBottom: 48 },
  dangerButton: {
    alignItems: "center",
    borderColor: "#BA2525",
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 20,
  },
  dangerLabel: { color: "#BA2525", fontSize: 15, fontWeight: "800" },
  label: { color: "#52606D", fontSize: 13, fontWeight: "700" },
  link: { color: "#1769AA", fontWeight: "800" },
  message: { color: "#52606D", fontSize: 14, lineHeight: 20 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 20,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  retryRow: { alignItems: "center", flexDirection: "row", gap: 12 },
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
  title: { color: "#102A43", fontSize: 34, fontWeight: "900" },
  value: { color: "#102A43", fontSize: 17, lineHeight: 24 },
});
