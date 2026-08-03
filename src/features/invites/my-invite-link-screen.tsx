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

import { AppButton } from "@/components/app-button";
import { ScreenHeader } from "@/components/screen-header";
import { color, radius, spacing, typeScale } from "@/constants/design";

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
  onBack: () => void;
  environmentUrl: string;
  userId: string;
};

export function MyInviteLinkScreen({
  environmentUrl,
  onBack,
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
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScreenHeader onBack={onBack} title="My Invite Link" />
      <ScrollView contentContainerStyle={styles.content}>
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
          <AppButton
            disabled={busy}
            label="Create link"
            onPress={() => issue.mutate(false)}
          />
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
          <AppButton
            disabled={busy}
            label="Share link"
            onPress={() =>
              void Share.share({
                message: inviteLinkFor(localToken, Linking.createURL("invite")),
              })
            }
          />
        ) : null}

        {status.data ? (
          <View style={styles.actions}>
            <AppButton
              accessibilityHint="Replaces your link so the old one stops working"
              disabled={busy}
              label="Rotate"
              onPress={() => issue.mutate(true)}
              style={styles.action}
              variant="secondary"
            />
            <AppButton
              disabled={busy}
              label="Revoke"
              onPress={() => revoke.mutate()}
              style={styles.action}
              variant="danger"
            />
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
  action: { flexGrow: 1 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  body: { ...typeScale.cardBody, color: color.textSecondary },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  content: { gap: spacing.lg, padding: spacing.xl, paddingBottom: 48 },
  label: { ...typeScale.sectionLabel, color: color.textSecondary },
  link: { ...typeScale.label, color: color.brand },
  message: { ...typeScale.cardBody, color: color.textSecondary },
  retryRow: { alignItems: "center", flexDirection: "row", gap: spacing.md },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  value: { ...typeScale.body, color: color.textPrimary },
});
