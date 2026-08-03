import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { ProfileAvatar } from "@/components/profile-avatar";
import { ScreenHeader } from "@/components/screen-header";
import { color, spacing, typeScale } from "@/constants/design";

import { chooseAvatar } from "./avatar-image";
import {
  cancelAvatarUpload,
  publishAvatar,
  removeAvatar,
  type AvatarPublishOutcome,
} from "./avatar-api";

type EditProfileScreenProps = {
  onBack: () => void;
  avatarPath: string | null;
  displayName: string;
  onDone: () => void;
  username: string;
};

type Phase =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "uploading"; fraction: number; requestId?: string }
  | { kind: "verifying" }
  | { kind: "message"; text: string };

export function EditProfileScreen({
  avatarPath,
  displayName,
  onBack,
  onDone,
  username,
}: EditProfileScreenProps) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const pendingRequestRef = useRef<string | null>(null);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["onboarding-state"] });
    await queryClient.invalidateQueries({ queryKey: ["profile-summary"] });
    await queryClient.invalidateQueries({ queryKey: ["friends"] });
    await queryClient.invalidateQueries({ queryKey: ["friend-friends"] });
    await queryClient.invalidateQueries({ queryKey: ["avatar-url"] });
  };

  const replace = useMutation({
    mutationFn: async (): Promise<AvatarPublishOutcome | null> => {
      setPhase({ kind: "preparing" });
      const chosen = await chooseAvatar();
      if (chosen.kind === "canceled") return null;
      if (chosen.kind === "error") {
        setPhase({ kind: "message", text: chosen.message });
        return null;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setPhase({ kind: "uploading", fraction: 0 });

      const outcome = await publishAvatar({
        byteSize: chosen.avatar.byteSize,
        fileUri: chosen.avatar.uri,
        onProgress: (fraction) => setPhase({ kind: "uploading", fraction }),
        sha256: chosen.avatar.sha256,
        signal: controller.signal,
      });
      abortRef.current = null;
      return outcome;
    },
    onSuccess: async (outcome) => {
      if (!outcome) return;
      if (outcome.kind === "published") {
        pendingRequestRef.current = null;
        await invalidate();
        setPhase({ kind: "idle" });
        return;
      }
      if (outcome.kind === "canceled") {
        pendingRequestRef.current = null;
        setPhase({ kind: "idle" });
        return;
      }
      if (outcome.kind === "rejected") {
        pendingRequestRef.current = null;
        setPhase({
          kind: "message",
          text: "That photo couldn’t be used. Try another one.",
        });
        return;
      }
      // Unresolved keeps the request ID so the same reservation is retried or
      // cancelled explicitly, rather than silently abandoned.
      pendingRequestRef.current = outcome.requestId;
      setPhase({
        kind: "message",
        text: "We couldn’t confirm that upload. Try again.",
      });
    },
    onError: () => {
      abortRef.current = null;
      setPhase({
        kind: "message",
        text: "That didn’t work. Check your connection and try again.",
      });
    },
  });

  const remove = useMutation({
    mutationFn: removeAvatar,
    onSuccess: async () => {
      await invalidate();
      setPhase({ kind: "idle" });
    },
    onError: () =>
      setPhase({ kind: "message", text: "That didn’t work. Try again." }),
  });

  const cancel = () => {
    abortRef.current?.abort();
    const requestId = pendingRequestRef.current;
    pendingRequestRef.current = null;
    if (requestId) void cancelAvatarUpload(requestId).catch(() => undefined);
    setPhase({ kind: "idle" });
  };

  const busy = phase.kind === "preparing" || phase.kind === "uploading";

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScreenHeader onBack={onBack} title="Edit Profile" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.identity}>
          <ProfileAvatar
            avatarPath={avatarPath}
            displayName={displayName}
            size={96}
          />
          <Text accessibilityRole="header" style={styles.title}>
            {displayName}
          </Text>
          {/* Usernames are immutable in V1, so this is shown but not editable. */}
          <Text style={styles.body}>@{username}</Text>
        </View>

        {phase.kind === "uploading" ? (
          <View accessibilityLiveRegion="polite" style={styles.progressRow}>
            <ActivityIndicator accessibilityLabel="Uploading photo" />
            <Text style={styles.body}>
              Uploading… {Math.round(phase.fraction * 100)}%
            </Text>
          </View>
        ) : null}
        {phase.kind === "preparing" ? (
          <View accessibilityLiveRegion="polite" style={styles.progressRow}>
            <ActivityIndicator accessibilityLabel="Preparing photo" />
            <Text style={styles.body}>Preparing your photo…</Text>
          </View>
        ) : null}
        {phase.kind === "message" ? (
          <Text accessibilityLiveRegion="polite" style={styles.message}>
            {phase.text}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <AppButton
            accessibilityHint="Opens your photo library to pick one image"
            busy={busy}
            disabled={busy}
            label={avatarPath ? "Change photo" : "Add photo"}
            onPress={() => replace.mutate()}
          />

          {busy ? (
            <AppButton label="Cancel" onPress={cancel} variant="secondary" />
          ) : null}

          {avatarPath && !busy ? (
            <AppButton
              disabled={remove.isPending}
              label="Remove photo"
              onPress={() => remove.mutate()}
              variant="secondary"
            />
          ) : null}
        </View>

        <Text style={styles.footnote}>
          Only you, your friends, and friends of your friends can see your
          photo. Anyone who has already seen it may still have a copy.
        </Text>

        <AppButton label="Done" onPress={onDone} variant="secondary" />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.md },
  body: { ...typeScale.cardBody, color: color.textSecondary },
  content: { gap: spacing.xl, padding: spacing.xl, paddingBottom: 48 },
  footnote: { ...typeScale.caption, color: color.textSecondary },
  identity: { alignItems: "center", gap: spacing.sm },
  message: { ...typeScale.caption, color: color.criticalText },
  progressRow: { alignItems: "center", flexDirection: "row", gap: spacing.md },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  title: { ...typeScale.title, color: color.textPrimary },
});
