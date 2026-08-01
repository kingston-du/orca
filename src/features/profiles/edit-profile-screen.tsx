import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ProfileAvatar } from "@/components/profile-avatar";

import { chooseAvatar } from "./avatar-image";
import {
  cancelAvatarUpload,
  publishAvatar,
  removeAvatar,
  type AvatarPublishOutcome,
} from "./avatar-api";

type EditProfileScreenProps = {
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
    <SafeAreaView style={styles.safeArea}>
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
          <Pressable
            accessibilityHint="Opens your photo library to pick one image"
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: busy }}
            disabled={busy}
            onPress={() => replace.mutate()}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryLabel}>
              {avatarPath ? "Change photo" : "Add photo"}
            </Text>
          </Pressable>

          {busy ? (
            <Pressable
              accessibilityRole="button"
              onPress={cancel}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryLabel}>Cancel</Text>
            </Pressable>
          ) : null}

          {avatarPath && !busy ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: remove.isPending }}
              disabled={remove.isPending}
              onPress={() => remove.mutate()}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryLabel}>Remove photo</Text>
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.footnote}>
          Only you, your friends, and friends of your friends can see your
          photo. Anyone who has already seen it may still have a copy.
        </Text>

        <Pressable
          accessibilityRole="button"
          onPress={onDone}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryLabel}>Done</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: { gap: 12 },
  body: { color: "#52606D", fontSize: 15, lineHeight: 22 },
  content: { gap: 24, padding: 20, paddingBottom: 48 },
  footnote: { color: "#52606D", fontSize: 13, lineHeight: 19 },
  identity: { alignItems: "center", gap: 8 },
  message: { color: "#BA2525", fontSize: 14, lineHeight: 20 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 20,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  progressRow: { alignItems: "center", flexDirection: "row", gap: 12 },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  secondaryButton: {
    alignItems: "center",
    borderColor: "#829AB1",
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 20,
  },
  secondaryLabel: { color: "#243B53", fontSize: 15, fontWeight: "700" },
  title: { color: "#102A43", fontSize: 26, fontWeight: "900" },
});
